import { NextResponse, type NextRequest } from "next/server";
import {
  buildRemoteWorkspace,
  normalizePosixPath,
  parseSshCommand,
  resolveRemoteTarget,
  type ResolvedSshTarget,
} from "@/lib/remote-workspace";
import { remoteListDir, remoteStat } from "@/lib/remote-fs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parentOf(path: string): string | null {
  const normalized = normalizePosixPath(path);
  if (normalized === "/") return null;
  const idx = normalized.lastIndexOf("/");
  return idx <= 0 ? "/" : normalized.slice(0, idx);
}

// POST /api/remote/browse — lists remote directories for the SSH-remote picker.
// body: { command? } OR { alias?/host?/port?/username?/identityFile? }, path
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const command = asOptionalString(body.command);
    const rawPath = asOptionalString(body.path) ?? "/";
    const path = normalizePosixPath(rawPath);

    let target: ResolvedSshTarget;
    if (command) {
      const parsed = parseSshCommand(command);
      if (!parsed) {
        return NextResponse.json({ error: "无法解析 SSH 命令，仅支持 ssh [-i key] [-p port] [-l user] user@host" }, { status: 400 });
      }
      target = parsed;
    } else {
      // Reuse the same resolution as /api/remote/validate without the cwd check.
      const remote = await buildRemoteWorkspace({
        ...(asOptionalString(body.alias) !== undefined ? { alias: asOptionalString(body.alias) } : {}),
        ...(asOptionalString(body.host) !== undefined ? { host: asOptionalString(body.host) } : {}),
        ...(typeof body.port === "number" ? { port: body.port } : {}),
        ...(asOptionalString(body.username) !== undefined ? { username: asOptionalString(body.username) } : {}),
        ...(asOptionalString(body.identityFile) !== undefined ? { identityFile: asOptionalString(body.identityFile) } : {}),
        cwd: path,
      });
      target = { host: remote.host, port: remote.port, username: remote.username, ...(remote.identityFile ? { identityFile: remote.identityFile } : {}) };
    }

    const stat = await remoteStat(target, path);
    if (!stat?.isDirectory) {
      return NextResponse.json({ error: `不是目录或不存在：${path}` }, { status: 400 });
    }

    const entries = await remoteListDir(target, path);
    const directories = entries
      .filter((entry) => entry.isDir)
      .map((entry) => ({ name: entry.name, path: path === "/" ? `/${entry.name}` : `${path}/${entry.name}` }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ path, parentPath: parentOf(path), directories });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
