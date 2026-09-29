import { homedir } from "node:os";
import { sendFeishuText } from "./feishu-client";
import { getFeishuChatId, registerFeishuSession } from "./feishu-state";
import { readSessionQA } from "./feishu-session-qa";
import { listSessionSummaries, resolveSessionPath } from "./session-reader";

/**
 * Completion notification sent to the operator's Feishu private chat, in the
 * style of the codex stop hook: task header + the last question and the
 * agent's final answer, so the operator can read and continue it on a phone.
 */

const FIRST_PROMPT_MAX = 80;
const LAST_USER_MAX = 1000;
const LAST_ASSISTANT_MAX = 2000;

function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shortenHome(value: string): string {
  const home = homedir();
  if (value === home) return "~";
  if (value.startsWith(home + "/")) return `~${value.slice(home.length)}`;
  return value;
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}……` : trimmed;
}

function compactSessionName(value: string): string {
  const firstLine = value.split("\n").find((line) => line.trim()) ?? value;
  return firstLine.trim().slice(0, 40) || "会话";
}

/**
 * Registers the session (assigning a stable number), then sends the completion
 * notification to the operator's Feishu chat. No-op until the operator has
 * messaged the bot once (which reveals the chat id).
 */
export async function sendFeishuCompletionNotification(sessionId: string): Promise<void> {
  const chatId = getFeishuChatId();
  if (!chatId) return;

  const filePath = await resolveSessionPath(sessionId);
  const qa = filePath ? readSessionQA(filePath) : { firstPrompt: "", lastUser: "", lastAssistant: "" };

  let name = "";
  let cwd = "";
  try {
    const session = (await listSessionSummaries()).find((s) => s.id === sessionId);
    name = session?.name ?? "";
    cwd = session?.cwd ?? "";
  } catch {
    // Best-effort metadata.
  }
  const displayName = compactSessionName(name || qa.firstPrompt || sessionId);
  const number = registerFeishuSession(sessionId, displayName);

  const lines = [
    `🔷 [${number}] ${displayName}`,
    ...(cwd ? [`📂 ${shortenHome(cwd)}`] : []),
    `🕐 ${formatTimestamp(new Date())}`,
  ];
  if (qa.firstPrompt) lines.push(truncate(qa.firstPrompt, FIRST_PROMPT_MAX));
  if (qa.lastUser) {
    lines.push("", "═══════════════", "", "𝗤:", truncate(qa.lastUser, LAST_USER_MAX));
  }
  if (qa.lastAssistant) {
    lines.push("", "───────────────", "", "𝗔:", truncate(qa.lastAssistant, LAST_ASSISTANT_MAX));
  }

  await sendFeishuText(chatId, lines.join("\n"));
}
