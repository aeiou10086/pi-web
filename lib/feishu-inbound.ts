import * as Lark from "@larksuiteoapi/node-sdk";
import { loadFeishuAppConfig } from "./feishu-config";
import { sendFeishuTextChunked } from "./feishu-client";
import {
  findFeishuSessionByNumber,
  listFeishuSessions,
  setFeishuChatId,
  type FeishuSessionSummary,
} from "./feishu-state";
import { getRpcSession, startRpcSession } from "./rpc-manager";
import { listSessionSummaries, resolveSessionPath } from "./session-reader";

/**
 * Feishu inbound message bridge (WebSocket 长连接 mode).
 *
 * The operator talks to the bot in a private (p2p) chat. Every message must
 * either name a session by its stable number or be one of the English
 * commands; anything else is rejected instead of being forwarded, so a stray
 * message can never land in the wrong session.
 *
 *   - `3 <text>` / `3，<text>` / `3,<text>` -> forward to session #3
 *   - `3`                                   -> show session #3
 *   - `list`                                -> recent 10 sessions
 *   - `all`                                 -> every registered session
 *   - `help` / `?`                          -> command reference
 *   - anything else                         -> rejected with a format hint
 *
 * App credentials live in `<agentDir>/feishu-app.json`.
 */

const RECENT_LIST_LIMIT = 10;

interface FeishuReceiveEvent {
  sender?: { sender_type?: string };
  message?: { chat_id?: string; message_type?: string; content?: string };
}

declare global {
  var __piWebFeishuInboundStarted: boolean | undefined;
}

function extractText(content: string): string | null {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    if (typeof parsed.text !== "string") return null;
    const text = parsed.text
      .replace(/@_user_\d+/g, "")
      .replace(/@_all/g, "")
      .replace(/@_everyone/g, "")
      .trim();
    return text || null;
  } catch {
    return null;
  }
}

async function forwardMessageToSession(sessionId: string, text: string): Promise<void> {
  const existing = getRpcSession(sessionId);
  if (existing?.isAlive()) {
    await existing.send({ type: "prompt", message: text });
    return;
  }
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new Error(`会话不存在: ${sessionId}`);
  const { session } = await startRpcSession(sessionId, filePath, undefined);
  await session.send({ type: "prompt", message: text });
}

function formatSessionList(sessions: FeishuSessionSummary[]): string {
  if (sessions.length === 0) return "暂无已完成的会话（先在 pi-web 里跑完一个任务）";
  const lines = sessions.map((s) => `#${s.number} ${s.name}`);
  return `可回复的会话（用「编号 内容」发送，如「${sessions[0].number} 继续」）：\n${lines.join("\n")}\n\n发 all 看全部，发 help 看命令`;
}

/** Current session titles, keyed by session id (best-effort). */
async function liveNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    for (const session of await listSessionSummaries()) {
      if (session.name) names.set(session.id, session.name);
    }
  } catch {
    // Best-effort: fall back to the name cached at registration time.
  }
  return names;
}

function nameOf(names: Map<string, string>, session: FeishuSessionSummary): string {
  return names.get(session.sessionId) ?? session.name;
}

function renderSessionList(sessions: FeishuSessionSummary[], names: Map<string, string>): string {
  if (sessions.length === 0) return "暂无已完成的会话（先在 pi-web 里跑完一个任务）";
  const lines = sessions.map((s) => `#${s.number} ${nameOf(names, s)}`);
  return `可回复的会话（用「编号 内容」发送，如「${sessions[0].number} 继续」）：\n${lines.join("\n")}\n\n发 all 看全部，发 help 看命令`;
}

function findByNumber(number: number): FeishuSessionSummary | undefined {
  const sessionId = findFeishuSessionByNumber(number);
  if (!sessionId) return undefined;
  return listFeishuSessions().find((s) => s.sessionId === sessionId);
}

async function acknowledge(chatId: string, target: FeishuSessionSummary): Promise<void> {
  const names = await liveNames();
  await sendFeishuTextChunked(chatId, `✅ 已转发到 #${target.number} ${nameOf(names, target)}`);
}

const HELP_TEXT = [
  "📖 命令（英文）",
  "list           最近 10 个会话",
  "all            全部会话",
  "<编号> <内容>   发给对应会话，如「3 继续做X」",
  "<编号>         查看该会话",
  "help / ?       本说明",
].join("\n");

const FORMAT_HINT = [
  "⚠️ 请带上会话编号，例如「3 继续做X」。",
  "发 list 看有哪些会话，发 help 看全部命令。",
].join("\n");

async function handleText(chatId: string, text: string): Promise<void> {
  const trimmed = text.trim();

  if (/^list$/i.test(trimmed)) {
    await sendFeishuTextChunked(chatId, renderSessionList(listFeishuSessions(RECENT_LIST_LIMIT), await liveNames()));
    return;
  }
  if (/^all$/i.test(trimmed)) {
    await sendFeishuTextChunked(chatId, renderSessionList(listFeishuSessions(), await liveNames()));
    return;
  }
  if (/^(help|\?)$/i.test(trimmed)) {
    await sendFeishuTextChunked(chatId, HELP_TEXT);
    return;
  }

  // "<number> <text>" with a space or a Chinese/English comma separator.
  const withContent = /^(\d{1,3})[\s，,]+([\s\S]+)$/.exec(trimmed);
  if (withContent) {
    const number = parseInt(withContent[1], 10);
    const content = withContent[2].trim();
    const target = findByNumber(number);
    if (!target) {
      await sendFeishuTextChunked(chatId, `没有 #${number} 号会话（发 list 看看有哪些）`);
      return;
    }
    if (!content) return;
    await forwardMessageToSession(target.sessionId, content);
    await acknowledge(chatId, target);
    return;
  }

  // A bare number: show what that session is, without sending anything.
  const numberOnly = /^(\d{1,3})$/.exec(trimmed);
  if (numberOnly) {
    const target = findByNumber(parseInt(numberOnly[1], 10));
    if (!target) {
      await sendFeishuTextChunked(chatId, `没有 #${numberOnly[1]} 号会话（发 list 看看有哪些）`);
      return;
    }
    const names = await liveNames();
    await sendFeishuTextChunked(chatId, `#${target.number} ${nameOf(names, target)}\n要发内容请用「${target.number} 你的指令」`);
    return;
  }

  // Anything else is rejected: never forward an unaddressed message.
  await sendFeishuTextChunked(chatId, FORMAT_HINT);
}

async function handleMessageEvent(data: FeishuReceiveEvent): Promise<void> {
  // Only human messages; ignore the bot's own and other apps'.
  const senderType = data.sender?.sender_type;
  if (senderType === "app" || senderType === "bot") return;
  // Only text messages; ignore images/files/etc.
  if (data.message?.message_type && data.message.message_type !== "text") return;

  const chatId = data.message?.chat_id;
  const content = data.message?.content;
  const text = content ? extractText(content) : null;
  if (!chatId || !text) return;

  // Remember where to send completion notifications.
  setFeishuChatId(chatId);

  try {
    await handleText(chatId, text);
  } catch (error) {
    console.error("[pi-web] 飞书消息处理失败:", error instanceof Error ? error.message : error);
    await sendFeishuTextChunked(chatId, `❌ 处理失败：${error instanceof Error ? error.message : String(error)}`).catch(() => {});
  }
}

/** Starts the Feishu inbound bridge once per process. */
export function startFeishuInbound(): void {
  if (globalThis.__piWebFeishuInboundStarted) return;
  globalThis.__piWebFeishuInboundStarted = true;

  const config = loadFeishuAppConfig();
  if (!config) {
    console.error("[pi-web] 未找到 feishu-app.json，跳过飞书消息接收");
    return;
  }

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": (data: FeishuReceiveEvent) => {
      void handleMessageEvent(data);
    },
  });

  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  });

  wsClient.start({ eventDispatcher }).then(
    () => console.log("[pi-web] 飞书 WebSocket 已连接"),
    (error) => console.error("[pi-web] 飞书 WebSocket 启动失败:", error instanceof Error ? error.message : error),
  );
}
