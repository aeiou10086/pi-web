import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "./session-reader";

/** Feishu self-built app credentials (`<agentDir>/feishu-app.json`). */
export interface FeishuAppConfig {
  appId: string;
  appSecret: string;
}

export function feishuAppConfigPath(): string {
  return join(getAgentDir(), "feishu-app.json");
}

export function loadFeishuAppConfig(): FeishuAppConfig | null {
  try {
    const raw = JSON.parse(readFileSync(feishuAppConfigPath(), "utf8")) as {
      appId?: unknown;
      appSecret?: unknown;
    };
    if (typeof raw.appId === "string" && raw.appId.trim()
      && typeof raw.appSecret === "string" && raw.appSecret.trim()) {
      return { appId: raw.appId.trim(), appSecret: raw.appSecret.trim() };
    }
  } catch {
    // No config yet.
  }
  return null;
}
