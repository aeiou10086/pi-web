import { NextResponse } from "next/server";
import {
  buildRemoteWorkspace,
  buildRemoteWorkspaceFromCommand,
  ensureRemoteAnchorDir,
  validateRemoteCwd,
  writeRemoteWorkspaceSidecar,
  type RemoteConnectInput,
  type RemoteWorkspace,
} from "@/lib/remote-workspace";
import { allowFileRoot } from "@/lib/file-access";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function asOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

// POST /api/remote/validate
// body: { alias?, host?, port?, username?, identityFile?, cwd }
// Resolves the SSH target (including ssh_config aliases), verifies the remote
// directory exists, and returns a ready-to-persist RemoteWorkspace descriptor.
export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    const input: RemoteConnectInput = {
      ...(asOptionalString(body.alias) !== undefined ? { alias: asOptionalString(body.alias) } : {}),
      ...(asOptionalString(body.host) !== undefined ? { host: asOptionalString(body.host) } : {}),
      ...(asOptionalNumber(body.port) !== undefined ? { port: asOptionalNumber(body.port) } : {}),
      ...(asOptionalString(body.username) !== undefined ? { username: asOptionalString(body.username) } : {}),
      ...(asOptionalString(body.identityFile) !== undefined ? { identityFile: asOptionalString(body.identityFile) } : {}),
      cwd: asOptionalString(body.cwd) ?? "",
    };

    if (!input.cwd) {
      return NextResponse.json({ error: "远端工作目录不能为空" }, { status: 400 });
    }

    const command = asOptionalString(body.command);
    let remote: RemoteWorkspace;
    try {
      remote = command
        ? await buildRemoteWorkspaceFromCommand(command, input.cwd)
        : await buildRemoteWorkspace(input);
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }

    const validation = await validateRemoteCwd(
      { host: remote.host, port: remote.port, username: remote.username, identityFile: remote.identityFile },
      remote.cwd,
    );
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }

    // Pre-create the local anchor dir and allow file access to it so /api/models
    // and /api/agent/new both succeed for this remote workspace.
    const anchorDir = ensureRemoteAnchorDir(remote.workspaceKey);
    allowFileRoot(anchorDir);
    remote.anchorDir = anchorDir;
    writeRemoteWorkspaceSidecar(remote);

    return NextResponse.json({ success: true, remote });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
