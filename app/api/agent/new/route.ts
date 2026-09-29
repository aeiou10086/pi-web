import { NextResponse } from "next/server";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { allowFileRoot } from "@/lib/file-access";
import { invalidateSessionListCache } from "@/lib/session-reader";
import { startRpcSession } from "@/lib/rpc-manager";
import { ensureRemoteAnchorDir, isRemoteAnchorDir, isRemoteWorkspaceKey, readRemoteWorkspaceSidecar, type RemoteWorkspace } from "@/lib/remote-workspace";

function parseRemoteWorkspace(value: unknown): RemoteWorkspace | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  const workspaceKey = candidate.workspaceKey;
  const command = candidate.command;
  const cwd = candidate.cwd;
  if (typeof workspaceKey !== "string" || !isRemoteWorkspaceKey(workspaceKey)) return undefined;
  if (typeof command !== "string" || !command.trim()) return undefined;
  if (typeof cwd !== "string" || !cwd.trim()) return undefined;
  const host = typeof candidate.host === "string" ? candidate.host : "";
  const port = typeof candidate.port === "number" ? candidate.port : 22;
  const username = typeof candidate.username === "string" ? candidate.username : "root";
  const label = typeof candidate.label === "string" && candidate.label.trim()
    ? candidate.label
    : `${username}@${host}:${cwd}`;
  const identityFile = typeof candidate.identityFile === "string" ? candidate.identityFile : undefined;
  return { workspaceKey, label, command, cwd, host, port, username, ...(identityFile ? { identityFile } : {}) };
}

const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function parseThinkingLevel(value: unknown): ThinkingLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && THINKING_LEVELS.has(value as ThinkingLevel)) {
    return value as ThinkingLevel;
  }
  throw new Error(`Invalid thinking level: ${String(value)}`);
}
// POST /api/agent/new  body: { cwd: string; type: string; message?: string; ... }
// Spawns a brand-new pi session. Most calls immediately send the first command;
// type:"ensure_session" only creates the runtime so clients can query commands.
// Returns pi's real session id plus the model/thinking state selected at startup.
export async function POST(req: Request) {
  let commandType: string | undefined;
  let promptAccepted = false;
  try {
    const body = await req.json() as { cwd?: string; remote?: unknown; [key: string]: unknown };
    const { cwd: requestedCwd, remote: remoteInput, ...command } = body;
    commandType = typeof command.type === "string" ? command.type : undefined;

    let remote = parseRemoteWorkspace(remoteInput);
    // Robustness: if the client lost the remote descriptor (e.g. a navigation
    // race cleared it), recover it from the anchor dir sidecar so the session is
    // still seeded and its tools route over SSH.
    if (!remote && typeof requestedCwd === "string" && isRemoteAnchorDir(requestedCwd)) {
      remote = readRemoteWorkspaceSidecar(requestedCwd) ?? undefined;
    }
    const cwd = remote ? ensureRemoteAnchorDir(remote.workspaceKey) : requestedCwd;

    if (!cwd || typeof cwd !== "string") {
      return NextResponse.json({
        error: "cwd is required",
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }
    if (!remote && !existsSync(cwd)) {
      return NextResponse.json({
        error: `Directory does not exist: ${cwd}`,
        ...(commandType === "prompt"
          ? { code: "prompt_rejected", accepted: false }
          : {}),
      }, { status: 400 });
    }

    // Use a one-time key so startRpcSession's lock doesn't conflict with real session ids
    const { provider, modelId, toolNames, thinkingLevel, ...promptCommand } = command as { provider?: string; modelId?: string; toolNames?: string[]; thinkingLevel?: unknown; [key: string]: unknown };
    if ((provider && !modelId) || (!provider && modelId)) {
      throw new Error("provider and modelId must be provided together");
    }
    const explicitThinkingLevel = parseThinkingLevel(thinkingLevel);

    // Must be unique per request: startRpcSession coalesces concurrent callers
    // that share a key onto one session. Date.now() (ms resolution) collides for
    // requests in the same millisecond, merging two new sessions into one.
    const tempKey = `__new__${randomUUID()}`;
    const { session, realSessionId } = await startRpcSession(tempKey, "", cwd, {
      ...(toolNames ? { toolNames } : {}),
      ...(provider && modelId ? { initialModel: { provider, modelId } } : {}),
      ...(explicitThinkingLevel ? { thinkingLevel: explicitThinkingLevel } : {}),
      ...(remote ? { remote } : {}),
    });

    // Keep the files-route allowed-roots cache (see app/api/files/[...path]/route.ts)
    // in sync so the new cwd is immediately readable via /api/files. Without this,
    // a file request under a brand-new cwd would 403 for up to the cache TTL.
    allowFileRoot(cwd);
    invalidateSessionListCache();

    const state = await session.send({ type: "get_state" }) as {
      model?: { id: string; provider: string };
      thinkingLevel?: string;
    };

    if (promptCommand.type === "ensure_session") {
      return NextResponse.json({
        success: true,
        sessionId: realSessionId,
        data: null,
        model: state.model
          ? { provider: state.model.provider, modelId: state.model.id }
          : null,
        thinkingLevel: state.thinkingLevel,
      });
    }

    const result = await session.send(promptCommand);
    promptAccepted = promptCommand.type === "prompt";

    return NextResponse.json({
      success: true,
      sessionId: realSessionId,
      data: result,
      model: state.model
        ? { provider: state.model.provider, modelId: state.model.id }
        : null,
      thinkingLevel: state.thinkingLevel,
    });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : String(error),
      ...(commandType === "prompt" && !promptAccepted
        ? { code: "prompt_rejected", accepted: false }
        : {}),
    }, { status: 500 });
  }
}
