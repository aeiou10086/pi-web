import { join, normalize as normalizePath, sep } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { listAllSessions } from "./session-reader";
import {
  parseSshCommand,
  quotePosixShellArg,
  readRemoteWorkspaceSidecar,
  runRemoteCommand,
  type ResolvedSshTarget,
} from "./remote-workspace";

/**
 * Remote filesystem primitives for pi-web Option B1.
 *
 * Remote workspaces store their session files in a local anchor directory
 * (`<agentDir>/remote-workspaces/<hash>`). File API requests carry absolute
 * LOCAL paths rooted at that anchor, so we translate them to remote paths by
 * substituting the anchor prefix with the workspace's remote cwd.
 */

export interface RemoteFsTarget {
  target: ResolvedSshTarget;
  remotePath: string;
}

/** Maps a local absolute path under a remote anchor to its remote counterpart. */
export async function resolveRemoteFile(localPath: string): Promise<RemoteFsTarget | null> {
  const remoteRoot = join(getAgentDir(), "remote-workspaces");
  const normalized = normalizePath(localPath);
  if (!normalized.startsWith(remoteRoot + sep)) return null;

  const relative = normalized.slice(remoteRoot.length + 1);
  const hashEnd = relative.indexOf(sep);
  const hash = hashEnd >= 0 ? relative.slice(0, hashEnd) : relative;
  const anchor = join(remoteRoot, hash);
  const rel = hashEnd >= 0 ? relative.slice(hashEnd + 1) : "";

  const sessions = await listAllSessions();
  const remote = readRemoteWorkspaceSidecar(anchor)
    ?? sessions.find((s) => s.remoteWorkspace && s.cwd === anchor)?.remoteWorkspace;
  if (!remote) return null;

  const target = parseSshCommand(remote.command);
  if (!target) return null;

  const remotePath = rel
    ? `${remote.cwd.replace(/\/+$/, "")}/${rel}`
    : remote.cwd;
  return { target, remotePath };
}

export interface RemoteStat {
  isDirectory: boolean;
  isFile: boolean;
  size: number;
}

export async function remoteStat(target: ResolvedSshTarget, remotePath: string): Promise<RemoteStat | null> {
  const q = quotePosixShellArg(remotePath);
  const result = await runRemoteCommand(
    target,
    `if [ -d ${q} ]; then echo DIR; elif [ -f ${q} ]; then echo "FILE $(wc -c < ${q})"; else echo MISSING; fi`,
  );
  const out = result.stdout.trim();
  if (out === "DIR") return { isDirectory: true, isFile: false, size: 0 };
  if (out.startsWith("FILE ")) {
    const size = Number(out.slice(5));
    return { isDirectory: false, isFile: true, size: Number.isFinite(size) ? size : 0 };
  }
  return null;
}

export interface RemoteFileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

export async function remoteListDir(target: ResolvedSshTarget, remotePath: string): Promise<RemoteFileEntry[]> {
  const q = quotePosixShellArg(remotePath);
  const script = `cd ${q} 2>/dev/null || exit 1\nfor f in * .[!.]*; do\n  [ -e "$f" ] || [ -L "$f" ] || continue\n  if [ -d "$f" ] && [ ! -L "$f" ]; then printf 'd\\t%s\\n' "$f"; elif [ -L "$f" ]; then printf 'l\\t%s\\n' "$f"; else printf 'f\\t%s\\n' "$f"; fi\ndone`;
  const result = await runRemoteCommand(target, script);
  if (result.code !== 0) return [];

  const entries: RemoteFileEntry[] = [];
  for (const line of result.stdout.split("\n")) {
    const idx = line.indexOf("\t");
    if (idx <= 0) continue;
    const name = line.slice(idx + 1);
    if (!name) continue;
    entries.push({ name, isDir: line[0] === "d", size: 0, modified: "" });
  }
  return entries;
}

/** Reads a bounded byte range of a remote file, base64-decoded. */
export async function remoteReadBounded(
  target: ResolvedSshTarget,
  remotePath: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const q = quotePosixShellArg(remotePath);
  const result = await runRemoteCommand(
    target,
    `tail -c +${offset + 1} ${q} 2>/dev/null | head -c ${length} | base64`,
  );
  return Buffer.from(result.stdout.replace(/\s/g, ""), "base64");
}
