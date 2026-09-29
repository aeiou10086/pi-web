import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { getAgentDir } from "./session-reader";

/**
 * Persisted Feishu bridge state (`<agentDir>/feishu-state.json`):
 *   - `chatId`: the private chat the operator talks to the bot in. Learned from
 *     the first inbound message; completion notifications are sent here.
 *   - `sessions`: stable per-session numbers so `3 <text>` always targets the
 *     same pi session, no matter how many others completed in between.
 */

export interface FeishuSessionEntry {
  number: number;
  name: string;
  updatedAt: number;
}

interface FeishuState {
  chatId: string | null;
  nextNumber: number;
  sessions: Record<string, FeishuSessionEntry>;
}

export interface FeishuSessionSummary {
  sessionId: string;
  number: number;
  name: string;
  updatedAt: number;
}

declare global {
  var __piWebFeishuState: FeishuState | undefined;
}

function stateFilePath(): string {
  return join(getAgentDir(), "feishu-state.json");
}

function loadState(): FeishuState {
  if (globalThis.__piWebFeishuState) return globalThis.__piWebFeishuState;
  let state: FeishuState = { chatId: null, nextNumber: 1, sessions: {} };
  try {
    const raw = JSON.parse(readFileSync(stateFilePath(), "utf8")) as Partial<FeishuState>;
    state = {
      chatId: typeof raw.chatId === "string" && raw.chatId ? raw.chatId : null,
      nextNumber: Number.isInteger(raw.nextNumber) && (raw.nextNumber ?? 0) > 0 ? raw.nextNumber! : 1,
      sessions: raw.sessions && typeof raw.sessions === "object" ? raw.sessions : {},
    };
  } catch {
    // No state yet.
  }
  globalThis.__piWebFeishuState = state;
  return state;
}

function saveState(): void {
  const state = globalThis.__piWebFeishuState;
  if (!state) return;
  try {
    const path = stateFilePath();
    mkdirSync(dirname(path), { recursive: true });
    writePrivateFileAtomicSync(path, `${JSON.stringify(state, null, 2)}\n`);
  } catch {
    // Best-effort persistence.
  }
}

export function setFeishuChatId(chatId: string): void {
  const state = loadState();
  if (state.chatId === chatId) return;
  state.chatId = chatId;
  saveState();
}

export function getFeishuChatId(): string | null {
  return loadState().chatId;
}

/** Returns the session's stable number, assigning a new one when first seen. */
export function registerFeishuSession(sessionId: string, name: string): number {
  const state = loadState();
  const existing = state.sessions[sessionId];
  if (existing) {
    if (name && name !== existing.name) {
      existing.name = name;
      saveState();
    }
    return existing.number;
  }
  const number = state.nextNumber;
  state.nextNumber += 1;
  state.sessions[sessionId] = { number, name: name || "会话", updatedAt: Date.now() };
  saveState();
  return number;
}

export function findFeishuSessionByNumber(number: number): string | null {
  const state = loadState();
  for (const [sessionId, entry] of Object.entries(state.sessions)) {
    if (entry.number === number) return sessionId;
  }
  return null;
}

/** Sessions ordered by most recently updated first. */
export function listFeishuSessions(limit?: number): FeishuSessionSummary[] {
  const state = loadState();
  const all = Object.entries(state.sessions).map(([sessionId, entry]) => ({
    sessionId,
    number: entry.number,
    name: entry.name,
    updatedAt: entry.updatedAt,
  }));
  all.sort((a, b) => b.updatedAt - a.updatedAt);
  return limit && limit > 0 ? all.slice(0, limit) : all;
}
