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
