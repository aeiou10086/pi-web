import * as Lark from "@larksuiteoapi/node-sdk";
import { loadFeishuAppConfig } from "./feishu-config";

/**
 * Shared Feishu SDK client (used to send messages back to the operator).
 * Created lazily; returns null when the app is not configured.
 */

declare global {
  var __piWebFeishuClient: Lark.Client | undefined;
}

export function getFeishuClient(): Lark.Client | null {
  if (globalThis.__piWebFeishuClient) return globalThis.__piWebFeishuClient;
  const config = loadFeishuAppConfig();
  if (!config) return null;
  globalThis.__piWebFeishuClient = new Lark.Client({
    appId: config.appId,
    appSecret: config.appSecret,
  });
  return globalThis.__piWebFeishuClient;
}

/** Sends a plain-text message to a chat. Returns false when unconfigured. */
export async function sendFeishuText(chatId: string, text: string): Promise<boolean> {
  const client = getFeishuClient();
  if (!client) return false;
  await client.im.v1.message.create({
    params: { receive_id_type: "chat_id" },
    data: {
      receive_id: chatId,
      msg_type: "text",
      content: JSON.stringify({ text }),
    },
  });
  return true;
}

/**
 * Feishu caps a plain-text message somewhere between 60KB and 100KB of content
 * (the documented 30KB figure applies to rich text and cards). 40KB leaves room
 * for JSON escaping while still fitting typical long answers in one message.
 */
const MAX_CHUNK_BYTES = 40 * 1024;
/** Safety net: never fan one notification out into an unbounded message storm. */
const MAX_CHUNKS = 8;

interface SplitResult {
  chunks: string[];
  /** Bytes left out because MAX_CHUNKS was reached. */
  droppedBytes: number;
}

/** Largest prefix length (in UTF-16 units) whose UTF-8 size is at most maxBytes. */
function cutAtBytes(text: string, maxBytes: number): number {
  let bytes = 0;
  let index = 0;
  // Iterating by code point keeps surrogate pairs intact.
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (bytes + size > maxBytes) break;
    bytes += size;
    index += char.length;
  }
  return index;
}

function splitForFeishu(text: string): SplitResult {
  if (Buffer.byteLength(text, "utf8") <= MAX_CHUNK_BYTES) {
    return { chunks: [text], droppedBytes: 0 };
  }

  const chunks: string[] = [];
  let rest = text;
  while (rest) {
    if (chunks.length >= MAX_CHUNKS) break;
    if (Buffer.byteLength(rest, "utf8") <= MAX_CHUNK_BYTES) {
      chunks.push(rest);
      rest = "";
      break;
    }
    const cut = cutAtBytes(rest, MAX_CHUNK_BYTES);
    // Prefer breaking at a line boundary so lines stay readable.
    const newline = rest.lastIndexOf("\n", cut);
    const end = newline > cut * 0.6 ? newline : cut;
    chunks.push(rest.slice(0, end));
    rest = rest.slice(end === cut ? cut : end + 1);
  }

  return { chunks, droppedBytes: rest ? Buffer.byteLength(rest, "utf8") : 0 };
}

/**
 * Sends long text without losing content: anything over one Feishu message is
 * split on line boundaries and delivered as `(i/n)` parts.
 */
export async function sendFeishuTextChunked(chatId: string, text: string): Promise<boolean> {
  const { chunks, droppedBytes } = splitForFeishu(text);
  const total = chunks.length;
  if (total === 0) return sendFeishuText(chatId, text);

  let sent = false;
  for (let index = 0; index < total; index += 1) {
    const isLast = index === total - 1;
    const prefix = total > 1 ? `（${index + 1}/${total}）\n` : "";
    let body = prefix + chunks[index];
    if (isLast && droppedBytes > 0) {
      body += `\n\n（内容过长：已省略剩余约 ${Math.round(droppedBytes / 1024)} KB）`;
    }
    sent = await sendFeishuText(chatId, body);
  }
  return sent;
}
