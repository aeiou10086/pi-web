import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, normalize as normalizePath, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Remote workspace support for pi-web (Option A).
 *
 * A "remote workspace" is a stable string identity that the session layer can
 * persist and the UI can render as a first-class workspace entry, while the
 * agent's bash/read/write/edit tools are routed over SSH by the
 * pi-ssh-remote extension.
 *
 * Identity format (mirrors ZCode's proven `remote:ssh:...` scheme):
 *   remote:ssh:<host>:<port>:<username>:<posixPath>
 * The path is POSIX-normalized and always starts with "/". Authority segments
 * (host/port/username) never contain "/".
 */

const REMOTE_IDENTITY_PREFIX = "remote:ssh:";
const DEFAULT_SSH_PORT = 22;

/** Custom session-entry type the pi-ssh-remote extension scans to auto-connect. */
export const REMOTE_SESSION_STATE_ENTRY_TYPE = "pi-ssh-remote-state";
/** Custom session-entry type pi-web writes so the UI can label/gate remote workspaces. */
export const REMOTE_WORKSPACE_ENTRY_TYPE = "pi-web-remote-workspace";

export interface ResolvedSshTarget {
  host: string;
  port: number;
  username: string;
  identityFile?: string;
}

export interface RemoteWorkspace {
  /** Stable identity, e.g. `remote:ssh:172.18.80.108:22:root:/root`. */
  workspaceKey: string;
  /** Human-readable label, e.g. `root@172.18.80.108:/root`. */
  label: string;
  /** Explicit ssh command handed to the pi-ssh-remote extension. */
  command: string;
  /** Remote POSIX path (the agent's working directory). */
  cwd: string;
  host: string;
  port: number;
  username: string;
  identityFile?: string;
  /** Local anchor directory holding this workspace's session files (server-computed). */
  anchorDir?: string;
}

export interface RemoteConnectInput {
  /** ssh_config Host alias — resolved via `ssh -G`. Takes precedence over host/port/username. */
  alias?: string;
  host?: string;
  port?: number;
  username?: string;
  /** Local private key path; defaults to the first existing default key. */
  identityFile?: string;
  /** Remote POSIX working directory. */
  cwd: string;
}

export function normalizePosixPath(raw: string): string {
  const normalized = raw.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return trimmed ? `/${trimmed}` : "/";
}

export function buildRemoteWorkspaceKey(
  host: string,
  port: number | undefined,
  username: string,
  cwd: string,
): string {
  return `${REMOTE_IDENTITY_PREFIX}${host.trim().toLowerCase()}:${port ?? DEFAULT_SSH_PORT}:${username.trim()}:${normalizePosixPath(cwd)}`;
}

export interface ParsedRemoteWorkspaceKey {
  kind: "ssh";
  host: string;
  port: number;
  username: string;
  workspacePath: string;
}

/** Parses a remote workspace key; returns null for non-remote or malformed keys. */
export function parseRemoteWorkspaceKey(identity: string): ParsedRemoteWorkspaceKey | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) return null;
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  let cursor = 0;
  const segments: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const next = rest.indexOf(":", cursor);
    if (next <= cursor) return null;
    segments.push(rest.slice(cursor, next));
    cursor = next + 1;
  }
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) return null;
  const port = Number.parseInt(segments[1] ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) return null;
  return {
    kind: "ssh",
    host: segments[0] ?? "",
    port,
    username: segments[2] ?? "",
    workspacePath,
  };
}

export function isRemoteWorkspaceKey(identity: string): boolean {
  return parseRemoteWorkspaceKey(identity) !== null;
}

export function quotePosixShellArg(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function expandHomeToken(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  return trimmed;
}

export function resolveDefaultIdentityFile(): string | undefined {
  for (const name of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const candidate = join(homedir(), ".ssh", name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function toValidPort(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : undefined;
}

/** Runs `ssh -G -F ~/.ssh/config -o BatchMode=yes <alias>` and parses the effective options. */
export function resolveSshConfigAlias(
  alias: string,
  configPath = join(homedir(), ".ssh", "config"),
): Promise<Partial<ResolvedSshTarget>> {
  return new Promise((resolvePromise) => {
    if (!existsSync(configPath)) {
      resolvePromise({});
      return;
    }
    const child = spawn(
      "ssh",
      ["-G", "-F", configPath, "-o", "BatchMode=yes", alias],
      { stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, SSH_ASKPASS: "", DISPLAY: "" } },
    );
    let stdout = "";
    let finished = false;
    const finish = (result: Partial<ResolvedSshTarget>) => {
      if (finished) return;
      finished = true;
      resolvePromise(result);
    };
    const timeoutId = setTimeout(() => {
      child.kill();
      finish({});
    }, 5_000);
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += chunk.toString();
      if (stdout.length > 128_000) stdout = stdout.slice(0, 128_000);
    });
    child.on("error", () => {
      clearTimeout(timeoutId);
      finish({});
    });
    child.on("close", (code) => {
      clearTimeout(timeoutId);
      if (code !== 0) {
        finish({});
        return;
      }
      let host: string | undefined;
      let port: number | undefined;
      let username: string | undefined;
      for (const line of stdout.split(/\r?\n/)) {
        const match = /^(\S+)\s+(.*)$/.exec(line.trim());
        if (!match) continue;
        const key = (match[1] ?? "").toLowerCase();
        const value = (match[2] ?? "").trim();
        if (key === "hostname" && !host && value) host = value;
        else if (key === "port" && port === undefined) port = toValidPort(value);
        else if (key === "user" && !username && value) username = value;
      }
      finish({
        ...(host ? { host } : {}),
        ...(port !== undefined ? { port } : {}),
        ...(username ? { username } : {}),
      });
    });
  });
}

export function buildSshCommand(target: ResolvedSshTarget): string {
  const parts = ["ssh"];
  if (target.identityFile) parts.push("-i", target.identityFile);
  parts.push(`${target.username}@${target.host}`);
  if (target.port !== DEFAULT_SSH_PORT) parts.push("-p", String(target.port));
  return parts.join(" ");
}

export async function resolveRemoteTarget(input: RemoteConnectInput): Promise<ResolvedSshTarget> {
  const aliasResult = input.alias?.trim()
    ? await resolveSshConfigAlias(input.alias.trim())
    : {};
  const host = input.host?.trim() || aliasResult.host || input.alias?.trim();
  if (!host) throw new Error("SSH host is required");
  const port = input.port ?? aliasResult.port ?? DEFAULT_SSH_PORT;
  const username = input.username?.trim() || aliasResult.username || "root";
  const identityFile =
    expandHomeToken(input.identityFile ?? "") ||
    (input.identityFile === undefined ? resolveDefaultIdentityFile() : undefined) ||
    undefined;
  return { host, port, username, ...(identityFile ? { identityFile } : {}) };
}

/** Parses a full `ssh [-i key] [-p port] [-l user] user@host` command. */
export function parseSshCommand(command: string): ResolvedSshTarget | undefined {
  const tokens = command.trim().split(/\s+/);
  if (!tokens[0] || tokens[0] !== "ssh") return undefined;
  let identityFile: string | undefined;
  let port = DEFAULT_SSH_PORT;
  let username: string | undefined;
  let hostPart: string | undefined;
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === "-i") { identityFile = tokens[++index]; continue; }
    if (token === "-p") { const parsed = toValidPort(tokens[++index]); if (parsed) port = parsed; continue; }
    if (token === "-l") { username = tokens[++index]; continue; }
    if (token.startsWith("-")) return undefined;
    hostPart = token;
    break;
  }
  if (!hostPart) return undefined;
  const at = hostPart.lastIndexOf("@");
  if (at >= 0) {
    username = hostPart.slice(0, at);
    hostPart = hostPart.slice(at + 1);
  }
  if (!hostPart) return undefined;
  return { host: hostPart, port, username: username ?? "root", ...(identityFile ? { identityFile } : {}) };
}

export async function resolveRemoteHome(target: ResolvedSshTarget): Promise<string> {
  const result = await runRemoteCommand(target, 'printf %s "$HOME"', { connectTimeoutSeconds: 12 });
  const home = result.stdout.trim();
  if (!home || !home.startsWith("/")) return "~";
  return home.replace(/\/+$/, "") || "/";
}

async function resolveRemoteCwdPath(target: ResolvedSshTarget, rawCwd: string): Promise<string> {
  const trimmed = rawCwd.trim();
  if (!trimmed || trimmed === "~") return resolveRemoteHome(target);
  if (trimmed.startsWith("~/")) {
    const home = await resolveRemoteHome(target);
    const rest = trimmed
      .slice(2)
      .replace(/\\/g, "/")
      .replace(/\/+/g, "/")
      .replace(/^\/+|\/+$/g, "");
    return rest ? `${home}/${rest}` : home;
  }
  return normalizePosixPath(trimmed);
}

export async function buildRemoteWorkspaceFromCommand(command: string, cwd: string): Promise<RemoteWorkspace> {
  const target = parseSshCommand(command);
  if (!target) throw new Error("无法解析 SSH 命令，仅支持 ssh [-i key] [-p port] [-l user] user@host");
  const resolvedCwd = await resolveRemoteCwdPath(target, cwd || "~");
  const workspaceKey = buildRemoteWorkspaceKey(target.host, target.port, target.username, resolvedCwd);
  return {
    workspaceKey,
    label: `${target.username}@${target.host}:${resolvedCwd}`,
    command,
    cwd: resolvedCwd,
    ...target,
  };
}

export async function buildRemoteWorkspace(input: RemoteConnectInput): Promise<RemoteWorkspace> {
  const target = await resolveRemoteTarget(input);
  const cwd = await resolveRemoteCwdPath(target, input.cwd || "~");
  const workspaceKey = buildRemoteWorkspaceKey(target.host, target.port, target.username, cwd);
  return {
    workspaceKey,
    label: `${target.username}@${target.host}:${cwd}`,
    command: buildSshCommand(target),
    cwd,
    ...target,
  };
}

export interface SshRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a command on the remote via the system `ssh` binary (respects ~/.ssh/config + agent). */
export function runRemoteCommand(
  target: ResolvedSshTarget,
  remoteCommand: string,
  options: {
    connectTimeoutSeconds?: number;
    onData?: (data: Buffer) => void;
    signal?: AbortSignal;
  } = {},
): Promise<SshRunResult> {
  return new Promise((resolvePromise) => {
    const args = [
      "-o", "BatchMode=yes",
      "-o", `ConnectTimeout=${options.connectTimeoutSeconds ?? 12}`,
      "-o", "StrictHostKeyChecking=accept-new",
      "-o", "LogLevel=ERROR",
    ];
    if (target.identityFile) args.push("-i", target.identityFile);
    if (target.port !== DEFAULT_SSH_PORT) args.push("-p", String(target.port));
    args.push(`${target.username}@${target.host}`, remoteCommand);

    const child = spawn("ssh", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      options.signal?.removeEventListener("abort", onAbort);
      resolvePromise({ code, stdout, stderr });
    };
    const onAbort = () => {
      child.kill("SIGKILL");
      finish(null);
    };
    if (options.signal) {
      if (options.signal.aborted) { onAbort(); return; }
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stdout.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdout += buffer.toString();
      options.onData?.(buffer);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderr += buffer.toString();
      options.onData?.(buffer);
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code));
  });
}

/** BashOperations backed by `ssh`, so `!command` shell commands run on the remote. */
export function createRemoteBashOperations(
  target: ResolvedSshTarget,
  remoteCwd: string,
): {
  exec: (
    command: string,
    cwd: string,
    options: { onData: (data: Buffer) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv },
  ) => Promise<{ exitCode: number | null }>;
} {
  return {
    exec: async (command, _cwd, options) => {
      const remoteCommand = `cd ${quotePosixShellArg(remoteCwd)} && ${command}`;
      const result = await runRemoteCommand(target, remoteCommand, { signal: options.signal });
      // Strip the remote login shell's locale warning so it doesn't pollute output.
      const output = stripLocaleNoise(`${result.stdout}${result.stderr}`);
      if (output) options.onData(Buffer.from(output));
      return { exitCode: result.code };
    },
  };
}

function stripLocaleNoise(stderr: string): string {
  return stderr
    .split(/\r?\n/)
    .filter((line) => !/setlocale|LC_ALL|LC_CTYPE|cannot change locale/i.test(line))
    .join("\n")
    .trim();
}

export async function validateRemoteCwd(
  target: ResolvedSshTarget,
  cwd: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const remotePath = normalizePosixPath(cwd || "~");
  const result = await runRemoteCommand(
    target,
    `test -d ${quotePosixShellArg(remotePath)} && echo OK`,
  );
  if (result.code === 0 && result.stdout.trim() === "OK") {
    return { ok: true };
  }
  if (result.code === null) {
    return { ok: false, error: "SSH 无法执行：请确认 ssh 在 PATH 中" };
  }
  const cleanStderr = stripLocaleNoise(result.stderr);
  if (cleanStderr && /Permission denied|publickey|authentication/i.test(cleanStderr)) {
    return { ok: false, error: "SSH 认证失败：请检查用户名、私钥或 ssh-agent" };
  }
  const detail = cleanStderr || `exit ${result.code}`;
  return { ok: false, error: `远端目录不存在或不可访问：${remotePath}（${detail}）` };
}

/** Stable local anchor dir holding the session file for a remote workspace. */
export function remoteAnchorDir(workspaceKey: string): string {
  const hash = createHash("sha1").update(workspaceKey).digest("hex").slice(0, 16);
  return join(getAgentDir(), "remote-workspaces", hash);
}

export function ensureRemoteAnchorDir(workspaceKey: string): string {
  const dir = remoteAnchorDir(workspaceKey);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function remoteAnchorSidecarPath(anchorDir: string): string {
  return join(anchorDir, "remote-workspace.json");
}

/** True when a local path is exactly a remote anchor dir (`<agentDir>/remote-workspaces/<hash>`). */
export function isRemoteAnchorDir(localPath: string): boolean {
  const remoteRoot = join(getAgentDir(), "remote-workspaces");
  const normalized = normalizePath(localPath);
  if (!normalized.startsWith(remoteRoot + sep)) return false;
  return !normalized.slice(remoteRoot.length + 1).includes(sep);
}

/**
 * Persists the remote descriptor next to the anchor dir so the server can seed
 * sessions and route file access without relying on the client-side state
 * surviving every navigation/race.
 */
export function writeRemoteWorkspaceSidecar(remote: RemoteWorkspace): void {
  const anchorDir = remote.anchorDir ?? ensureRemoteAnchorDir(remote.workspaceKey);
  const withAnchor = { ...remote, anchorDir };
  writeFileSync(remoteAnchorSidecarPath(anchorDir), JSON.stringify(withAnchor, null, 2) + "\n", { mode: 0o600 });
}

export function readRemoteWorkspaceSidecar(anchorDir: string): RemoteWorkspace | null {
  try {
    const parsed = JSON.parse(readFileSync(remoteAnchorSidecarPath(anchorDir), "utf8"));
    return parseRemoteWorkspaceData(parsed) ?? null;
  } catch {
    return null;
  }
}

/** Validates/normalizes a RemoteWorkspace read back from a session entry. */
export function parseRemoteWorkspaceData(value: unknown): RemoteWorkspace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const data = value as Partial<RemoteWorkspace>;
  if (
    typeof data.workspaceKey !== "string"
    || typeof data.command !== "string"
    || typeof data.cwd !== "string"
  ) return undefined;
  return {
    workspaceKey: data.workspaceKey,
    label: typeof data.label === "string" && data.label
      ? data.label
      : `${data.username ?? "root"}@${data.host ?? ""}:${data.cwd}`,
    command: data.command,
    cwd: data.cwd,
    host: typeof data.host === "string" ? data.host : "",
    port: typeof data.port === "number" ? data.port : 22,
    username: typeof data.username === "string" ? data.username : "root",
    ...(typeof data.identityFile === "string" ? { identityFile: data.identityFile } : {}),
  };
}

/** Custom session entries seeded into a new session so remote routing starts at turn 0. */
export function remoteWorkspaceSessionSeeds(
  remote: RemoteWorkspace,
): Array<{ customType: string; data: unknown }> {
  return [
    {
      customType: REMOTE_SESSION_STATE_ENTRY_TYPE,
      data: { version: 1, connected: true, command: remote.command, cwd: remote.cwd, routeRemoteTools: true },
    },
    { customType: REMOTE_WORKSPACE_ENTRY_TYPE, data: remote },
  ];
}
