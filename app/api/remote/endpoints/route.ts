import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface EndpointConfig {
  sshCommand?: string;
  remoteCwd?: string;
  note?: string;
}

interface RemoteConfigFile {
  activeEndpoint?: string;
  endpoints?: Record<string, EndpointConfig>;
}

// GET /api/remote/endpoints — lists endpoints saved by the pi-ssh-remote
// extension so the directory picker can offer them as one-click targets.
export async function GET() {
  try {
    const path = join(getAgentDir(), "ssh-remote-config.json");
    let config: RemoteConfigFile = {};
    try {
      config = JSON.parse(await readFile(path, "utf8")) as RemoteConfigFile;
    } catch {
      config = {};
    }
    const endpoints = Object.entries(config.endpoints ?? {}).map(([key, endpoint]) => ({
      key,
      sshCommand: endpoint.sshCommand,
      remoteCwd: endpoint.remoteCwd,
      note: endpoint.note,
    }));
    return NextResponse.json({ activeEndpoint: config.activeEndpoint, endpoints });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
