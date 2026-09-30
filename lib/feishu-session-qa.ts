import { closeSync, openSync, readSync, statSync } from "node:fs";

/**
 * Reads the human-readable Q/A of a pi session from its JSONL file:
 *   - `firstPrompt`: the first user message (the task)
 *   - `lastUser`: the most recent user message (𝗤)
 *   - `lastAssistant`: the most recent assistant text (𝗔)
 *
 * Session files can be large, so the head (for the first prompt) and the tail
 * (for the last Q/A) are read separately instead of loading the whole file.
 */

export interface SessionQA {
  /** Latest generated title (`session_info.name`), if the user renamed it. */
  title: string;
  firstPrompt: string;
  lastUser: string;
  lastAssistant: string;
  /** Last run's failure text when the most recent assistant turn errored. */
  lastError: string;
}

const HEAD_BYTES = 256 * 1024;
const TAIL_BYTES = 1024 * 1024;

function readRange(fd: number, start: number, length: number): string {
  if (length <= 0) return "";
  const buffer = Buffer.allocUnsafe(length);
  const read = readSync(fd, buffer, 0, length, start);
  return buffer.toString("utf8", 0, read);
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content
      .filter((block): block is { type?: string; text?: string } => Boolean(block) && typeof block === "object")
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim();
  }
  return "";
}

function collect(lines: string[], state: SessionQA): void {
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry: {
      type?: string;
      name?: unknown;
      message?: { role?: string; content?: unknown; errorMessage?: unknown; stopReason?: unknown };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    // A generated/renamed title lives in a top-level `session_info` entry.
    if (entry.type === "session_info") {
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      if (name) state.title = name;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    const role = message?.role;
    if (role !== "user" && role !== "assistant") continue;

    if (role === "user") {
      const text = textFromContent(message?.content);
      if (!text) continue;
      if (!state.firstPrompt) state.firstPrompt = text;
      state.lastUser = text;
      continue;
    }

    // Assistant: a normal turn has text; a failed run has empty content and an
    // error message. Track whichever came last as this run's outcome.
    const text = textFromContent(message?.content);
    if (text) {
      state.lastAssistant = text;
      state.lastError = "";
      continue;
    }
    const error = typeof message?.errorMessage === "string" ? message.errorMessage.trim() : "";
    if (error || message?.stopReason === "error") {
      state.lastAssistant = "";
      state.lastError = error || "运行出错（模型未返回错误详情）";
    }
  }
}

export function readSessionQA(filePath: string): SessionQA {
  const state: SessionQA = { title: "", firstPrompt: "", lastUser: "", lastAssistant: "", lastError: "" };
  let size: number;
  try {
    size = statSync(filePath).size;
  } catch {
    return state;
  }
  const fd = openSync(filePath, "r");
  try {
    if (size <= HEAD_BYTES + TAIL_BYTES) {
      collect(readRange(fd, 0, size).split("\n"), state);
      return state;
    }
    // Head: drop the trailing partial line. Tail: drop the leading partial line.
    const head = readRange(fd, 0, HEAD_BYTES);
    collect(head.slice(0, head.lastIndexOf("\n")).split("\n"), state);

    const tail = readRange(fd, size - TAIL_BYTES, TAIL_BYTES);
    const tailStart = tail.indexOf("\n");
    collect((tailStart >= 0 ? tail.slice(tailStart + 1) : tail).split("\n"), state);
    return state;
  } finally {
    closeSync(fd);
  }
}
