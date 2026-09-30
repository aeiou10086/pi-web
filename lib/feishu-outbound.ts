import { homedir } from "node:os";
import { sendFeishuTextChunked } from "./feishu-client";
import { getFeishuChatId, registerFeishuSession } from "./feishu-state";
import { readSessionQA, type SessionQA } from "./feishu-session-qa";
import { listSessionSummaries, resolveSessionPath } from "./session-reader";

/**
 * Completion notification sent to the operator's Feishu private chat, in the
 * style of the codex stop hook: task header + the last question and the
 * agent's final answer, so the operator can read and continue it on a phone.
 */

// The header shows only a short preview; 𝗤 / 𝗔 are sent in full (long replies
// are split into numbered parts instead of being truncated).
const FIRST_PROMPT_MAX = 80;

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
  const qa: SessionQA = filePath
    ? readSessionQA(filePath)
    : { title: "", firstPrompt: "", lastUser: "", lastAssistant: "", lastError: "" };
  // A failed run has an error and no assistant text; surface it as the answer.
  const failed = !qa.lastAssistant && Boolean(qa.lastError);

  let name = "";
  let cwd = "";
  try {
    const session = (await listSessionSummaries()).find((s) => s.id === sessionId);
    name = session?.name ?? "";
    cwd = session?.cwd ?? "";
  } catch {
    // Best-effort metadata.
  }
  // Prefer the session's generated/renamed title (from its file), then the
  // session-list name, then the first message.
  const displayName = compactSessionName(qa.title || name || qa.firstPrompt || sessionId);
  const number = registerFeishuSession(sessionId, displayName);

  const lines = [
    `🔷 [${number}] ${displayName}${failed ? " ❌" : ""}`,
    ...(cwd ? [`📂 ${shortenHome(cwd)}`] : []),
    `🕐 ${formatTimestamp(new Date())}`,
  ];
  if (qa.firstPrompt) lines.push(truncate(qa.firstPrompt, FIRST_PROMPT_MAX));
  if (qa.lastUser) {
    lines.push("", "═══════════════", "", "𝗤:", qa.lastUser);
  }
  // Always render the answer slot, so a run that failed without producing text
  // is not mistaken for a reply that simply omits 𝗔.
  const answer = qa.lastAssistant
    ? qa.lastAssistant
    : qa.lastError
      ? `❌ 运行出错：${qa.lastError}`
      : "(无回复内容)";
  lines.push("", "───────────────", "", "𝗔:", answer);

  await sendFeishuTextChunked(chatId, lines.join("\n"));
}
