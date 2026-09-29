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
  firstPrompt: string;
  lastUser: string;
  lastAssistant: string;
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
    let entry: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue;
    }
    if (entry.type !== "message") continue;
    const role = entry.message?.role;
    if (role !== "user" && role !== "assistant") continue;
    const text = textFromContent(entry.message?.content);
    if (!text) continue;
    if (role === "user") {
      if (!state.firstPrompt) state.firstPrompt = text;
      state.lastUser = text;
    } else {
      state.lastAssistant = text;
    }
  }
}

export function readSessionQA(filePath: string): SessionQA {
  const state: SessionQA = { firstPrompt: "", lastUser: "", lastAssistant: "" };
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
