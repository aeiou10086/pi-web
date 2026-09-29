"use client";

import { FormEvent, useCallback, useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import type { RemoteWorkspace } from "@/lib/remote-workspace";

interface DirectoryEntry {
  name: string;
  path: string;
}

interface BrowseResponse {
  path?: string;
  parentPath?: string | null;
  directories?: DirectoryEntry[];
  drives?: DirectoryEntry[];
  error?: string;
}

async function loadDirectories(directory?: string): Promise<BrowseResponse> {
  const query = directory ? `?path=${encodeURIComponent(directory)}` : "";
  const response = await fetch(`/api/cwd/browse${query}`);
  const data = await response.json() as BrowseResponse;
  if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
  return data;
}

function FolderIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
      <path d="M1.5 3h4l1.5 2h7.5v7.5h-13z" />
    </svg>
  );
}

function DriveIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="12" height="10" rx="1.5" />
      <path d="M2 9h12" />
      <circle cx="11.5" cy="11" r="0.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

function isWindowsDriveRoot(directory: string): boolean {
  return /^[a-zA-Z]:[\\/]?$/.test(directory);
}

interface SavedEndpoint {
  key: string;
  sshCommand?: string;
  remoteCwd?: string;
  note?: string;
}

interface Props {
  onCancel: () => void;
  onSelect: (path: string) => void;
  onSelectRemote?: (remote: RemoteWorkspace) => void;
  initialPath?: string;
  busy?: boolean;
  error?: string | null;
}

export function DirectoryPicker({ onCancel, onSelect, onSelectRemote, initialPath, busy = false, error }: Props) {
  const { t } = useI18n();
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [currentPath, setCurrentPath] = useState("");
  const [parentDirectory, setParentDirectory] = useState<string | null>(null);
  const [pathInput, setPathInput] = useState(initialPath ?? "");
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [drives, setDrives] = useState<DirectoryEntry[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [mode, setMode] = useState<"local" | "remote">("local");
  const [endpoints, setEndpoints] = useState<SavedEndpoint[]>([]);
  const [endpointsLoading, setEndpointsLoading] = useState(false);
  const [remoteBusy, setRemoteBusy] = useState(false);
  const [remoteError, setRemoteError] = useState<string | null>(null);
  const [selectedEndpoint, setSelectedEndpoint] = useState<string | null>(null);
  const [aliasInput, setAliasInput] = useState("");
  const [hostInput, setHostInput] = useState("");
  const [portInput, setPortInput] = useState("");
  const [usernameInput, setUsernameInput] = useState("root");
  const [identityInput, setIdentityInput] = useState("");
  const [remoteCwdInput, setRemoteCwdInput] = useState("");
  const [remoteBrowseOpen, setRemoteBrowseOpen] = useState(false);
  const [remoteBrowsePath, setRemoteBrowsePath] = useState("/");
  const [remoteBrowseParent, setRemoteBrowseParent] = useState<string | null>(null);
  const [remoteBrowseDirs, setRemoteBrowseDirs] = useState<{ name: string; path: string }[]>([]);
  const [remoteBrowseLoading, setRemoteBrowseLoading] = useState(false);
  const [remoteBrowseError, setRemoteBrowseError] = useState<string | null>(null);

  const switchMode = useCallback((next: "local" | "remote") => {
    setMode(next);
    setRemoteError(null);
    if (next === "remote" && endpoints.length === 0 && !endpointsLoading) {
      setEndpointsLoading(true);
      void fetch("/api/remote/endpoints")
        .then((r) => r.json().catch(() => ({})))
        .then((d: { endpoints?: SavedEndpoint[] }) => setEndpoints(d.endpoints ?? []))
        .catch(() => setEndpoints([]))
        .finally(() => setEndpointsLoading(false));
    }
  }, [endpoints.length, endpointsLoading]);

  const submitRemote = useCallback(async (event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    if (remoteBusy) return;
    setRemoteBusy(true);
    setRemoteError(null);
    const endpoint = endpoints.find((e) => e.key === selectedEndpoint);
    const cwd = remoteCwdInput.trim() || endpoint?.remoteCwd || "~";
    const body: Record<string, unknown> = endpoint?.sshCommand
      ? { command: endpoint.sshCommand, cwd }
      : {
          ...(aliasInput.trim() ? { alias: aliasInput.trim() } : { host: hostInput.trim() }),
          ...(portInput.trim() ? { port: Number(portInput.trim()) } : {}),
          ...(usernameInput.trim() ? { username: usernameInput.trim() } : {}),
          ...(identityInput.trim() ? { identityFile: identityInput.trim() } : {}),
          cwd,
        };
    try {
      const res = await fetch("/api/remote/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { remote?: RemoteWorkspace; error?: string };
      if (!res.ok || !data.remote) {
        setRemoteError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      onSelectRemote?.(data.remote);
    } catch (e) {
      setRemoteError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBusy(false);
    }
  }, [aliasInput, endpoints, hostInput, identityInput, onSelectRemote, portInput, remoteBusy, remoteCwdInput, selectedEndpoint, usernameInput]);

  const browseRemote = useCallback(async (path: string) => {
    if (remoteBrowseLoading) return;
    setRemoteBrowseLoading(true);
    setRemoteBrowseError(null);
    const endpoint = endpoints.find((e) => e.key === selectedEndpoint);
    const body: Record<string, unknown> = endpoint?.sshCommand
      ? { command: endpoint.sshCommand, path }
      : {
          ...(aliasInput.trim() ? { alias: aliasInput.trim() } : { host: hostInput.trim() }),
          ...(portInput.trim() ? { port: Number(portInput.trim()) } : {}),
          ...(usernameInput.trim() ? { username: usernameInput.trim() } : {}),
          ...(identityInput.trim() ? { identityFile: identityInput.trim() } : {}),
          path,
        };
    try {
      const res = await fetch("/api/remote/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; parentPath?: string | null; directories?: { name: string; path: string }[]; error?: string };
      if (!res.ok || data.error) {
        setRemoteBrowseError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setRemoteBrowsePath(data.path ?? path);
      setRemoteBrowseParent(data.parentPath ?? null);
      setRemoteBrowseDirs(data.directories ?? []);
    } catch (e) {
      setRemoteBrowseError(e instanceof Error ? e.message : String(e));
    } finally {
      setRemoteBrowseLoading(false);
    }
  }, [aliasInput, endpoints, hostInput, identityInput, portInput, remoteBrowseLoading, selectedEndpoint, usernameInput]);

  const navigateTo = useCallback(async (directory?: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await loadDirectories(directory);
      const nextPath = data.path ?? directory ?? "/";
      setCurrentPath(nextPath);
      setParentDirectory(data.parentPath ?? null);
      setPathInput(nextPath);
      setDirectories(data.directories ?? []);
      setDrives(data.drives ?? null);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    setPortalTarget(document.body);
    void navigateTo(initialPath || undefined);
  }, [initialPath, navigateTo]);

  const handlePathSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const candidate = pathInput.trim();
    if (candidate) void navigateTo(candidate);
  };
  const hasUncommittedPath = pathInput.trim() !== currentPath;
  const canSelect = Boolean(currentPath) && !hasUncommittedPath && !busy;
  const canNavigateUp = Boolean(parentDirectory) || isWindowsDriveRoot(currentPath);
  const fieldStyle: CSSProperties = {
    minWidth: 0, height: 34, padding: "0 10px", border: "1px solid var(--border)",
    borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)",
    fontFamily: "var(--font-mono)", fontSize: 12,
  };

  if (!portalTarget) return null;

  return createPortal(
    <div
      className="directory-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={t("directoryPicker.selectDirectory")}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onCancel();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) onCancel();
      }}
      style={{ position: "fixed", inset: 0, zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)" }}
    >
      <div className="directory-picker-panel" style={{ width: 520, maxWidth: "calc(100vw - 16px)", height: "min(620px, calc(100dvh - 16px))", maxHeight: "calc(100dvh - 16px)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.18)" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0, padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ color: "var(--text)", fontWeight: 700, fontSize: 15 }}>{t("directoryPicker.selectDirectory")}</div>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            style={{ padding: "2px 6px", border: 0, background: "none", color: "var(--text-muted)", fontSize: 20, lineHeight: 1, cursor: busy ? "default" : "pointer", opacity: busy ? 0.5 : 1 }}
          >
            ×
          </button>
        </div>

        <div style={{ display: "flex", gap: 6, flexShrink: 0, padding: "10px 14px 0" }}>
          <button
            type="button"
            onClick={() => switchMode("local")}
            style={{ flex: 1, padding: "6px 0", border: "1px solid var(--border)", borderRadius: 6, background: mode === "local" ? "var(--accent)" : "var(--bg-panel)", color: mode === "local" ? "var(--accent-contrast)" : "var(--text-muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
          >
            {t("directoryPicker.selectDirectory")}
          </button>
          {onSelectRemote && (
            <button
              type="button"
              onClick={() => switchMode("remote")}
              style={{ flex: 1, padding: "6px 0", border: "1px solid var(--border)", borderRadius: 6, background: mode === "remote" ? "var(--accent)" : "var(--bg-panel)", color: mode === "remote" ? "var(--accent-contrast)" : "var(--text-muted)", fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              SSH 远程
            </button>
          )}
        </div>

        {mode === "remote" && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "auto", padding: "10px 14px", gap: 8 }}>
            {endpointsLoading ? (
              <div style={{ color: "var(--text-dim)", fontSize: 11 }}>加载已保存的远程端点…</div>
            ) : endpoints.length > 0 ? (
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 11, marginBottom: 6 }}>已保存的远程端点</div>
                {endpoints.map((endpoint) => (
                  <button
                    key={endpoint.key}
                    type="button"
                    onClick={() => {
                      setSelectedEndpoint(endpoint.key);
                      if (endpoint.remoteCwd) setRemoteCwdInput(endpoint.remoteCwd);
                    }}
                    style={{ width: "100%", textAlign: "left", padding: "6px 8px", marginBottom: 4, border: "1px solid var(--border)", borderRadius: 5, background: selectedEndpoint === endpoint.key ? "var(--bg-hover)" : "none", color: "var(--text)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)" }}
                  >
                    <span style={{ fontWeight: 600 }}>{endpoint.key}</span>
                    {endpoint.note ? <span style={{ color: "var(--text-dim)" }}> · {endpoint.note}</span> : null}
                    {endpoint.remoteCwd ? <span style={{ color: "var(--text-dim)" }}> · {endpoint.remoteCwd}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}

            <form onSubmit={(event) => void submitRemote(event)} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <input type="text" value={aliasInput} onChange={(event) => setAliasInput(event.target.value)} placeholder="ssh 别名（~/.ssh/config，可选）" style={fieldStyle} />
              <input type="text" value={hostInput} onChange={(event) => setHostInput(event.target.value)} placeholder="主机 IP / 域名" style={fieldStyle} />
              <div style={{ display: "flex", gap: 6 }}>
                <input type="text" value={usernameInput} onChange={(event) => setUsernameInput(event.target.value)} placeholder="用户" style={{ ...fieldStyle, flex: 1 }} />
                <input type="text" value={portInput} onChange={(event) => setPortInput(event.target.value)} placeholder="端口" style={{ ...fieldStyle, width: 70 }} />
              </div>
              <input type="text" value={identityInput} onChange={(event) => setIdentityInput(event.target.value)} placeholder="私钥路径（可选，默认用默认密钥）" style={fieldStyle} />
              <input type="text" value={remoteCwdInput} onChange={(event) => setRemoteCwdInput(event.target.value)} placeholder="远端工作目录（留空用默认，如 /root）" style={fieldStyle} />
              <div style={{ display: "flex", gap: 6 }}>
                <button type="button" onClick={() => {
                  const opening = !remoteBrowseOpen;
                  setRemoteBrowseOpen(opening);
                  if (opening) void browseRemote(remoteBrowsePath === "/" && remoteCwdInput.trim().startsWith("/") ? remoteCwdInput.trim() : remoteBrowsePath);
                }} style={{ flex: 1, padding: "5px 8px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", fontSize: 11, cursor: "pointer" }}>
                  {remoteBrowseOpen ? "收起浏览" : "浏览远端目录"}
                </button>
              </div>
              {remoteBrowseOpen && (
                <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: 6, display: "flex", flexDirection: "column", gap: 4, maxHeight: 170, overflowY: "auto" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <button type="button" onClick={() => void browseRemote(remoteBrowseParent ?? "/")} disabled={!remoteBrowseParent || remoteBrowseLoading} style={{ width: 24, height: 24, border: "1px solid var(--border)", borderRadius: 5, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: remoteBrowseParent && !remoteBrowseLoading ? "pointer" : "default", opacity: remoteBrowseParent && !remoteBrowseLoading ? 1 : 0.45, fontSize: 12 }}>↑</button>
                    <span style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--text)" }}>{remoteBrowsePath}</span>
                    <button type="button" onClick={() => { setRemoteCwdInput(remoteBrowsePath); setRemoteBrowseOpen(false); }} style={{ padding: "3px 8px", border: "1px solid var(--accent)", borderRadius: 5, background: "none", color: "var(--accent)", fontSize: 11, cursor: "pointer" }}>选此目录</button>
                  </div>
                  {remoteBrowseLoading ? (
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>加载中…</div>
                  ) : remoteBrowseError ? (
                    <div style={{ fontSize: 11, color: "#dc2626" }}>{remoteBrowseError}</div>
                  ) : remoteBrowseDirs.length === 0 ? (
                    <div style={{ fontSize: 11, color: "var(--text-dim)" }}>无子目录</div>
                  ) : (
                    remoteBrowseDirs.map((dir) => (
                      <button key={dir.path} type="button" onClick={() => void browseRemote(dir.path)} style={{ width: "100%", textAlign: "left", padding: "4px 8px", border: "1px solid transparent", borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, fontFamily: "var(--font-mono)" }}>
                        📁 {dir.name}
                      </button>
                    ))
                  )}
                </div>
              )}
              {remoteError && <div style={{ color: "#dc2626", fontSize: 11 }}>{remoteError}</div>}
              <button type="submit" disabled={remoteBusy} style={{ padding: "7px 12px", border: 0, borderRadius: 6, background: "var(--accent)", color: "var(--accent-contrast)", fontSize: 13, fontWeight: 600, opacity: remoteBusy ? 0.6 : 1, cursor: remoteBusy ? "default" : "pointer" }}>
                {remoteBusy ? "连接中…" : "连接并打开远程工作区"}
              </button>
            </form>
          </div>
        )}

        {mode === "local" && (
        <>
        <form onSubmit={handlePathSubmit} style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, padding: "10px 14px", borderBottom: "1px solid var(--border)" }}>
          <button className="directory-picker-back" type="button" onClick={() => void navigateTo(parentDirectory ?? undefined)} disabled={loading || !canNavigateUp} title={t("directoryPicker.goToParent")} aria-label={t("directoryPicker.goToParent")} style={{ width: 36, height: 36, padding: 0, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: canNavigateUp ? "pointer" : "default", opacity: canNavigateUp ? 1 : 0.45 }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m18 15-6-6-6 6" />
            </svg>
          </button>
          <label htmlFor="directory-path" style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0, 0, 0, 0)", whiteSpace: "nowrap", border: 0 }}>
            {t("directoryPicker.directoryPath")}
          </label>
          <input
            className="directory-picker-path"
            id="directory-path"
            type="text"
            value={pathInput}
            placeholder="/path/to/project or ~/project"
            autoFocus
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setPathInput(event.target.value);
              setLoadError(null);
            }}
            style={{ minWidth: 0, flex: 1, height: 36, padding: "0 10px", border: "1px solid var(--border)", borderRadius: 6, outline: "none", background: "var(--bg-panel)", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12 }}
          />
          <button
            className="directory-picker-action"
            type="submit"
            disabled={loading || !pathInput.trim()}
            title={t("directoryPicker.goToDirectory")}
            style={{ minWidth: 58, height: 36, padding: "0 12px", border: "1px solid var(--border)", borderRadius: 6, background: "var(--bg-hover)", color: "var(--text-muted)", cursor: loading || !pathInput.trim() ? "default" : "pointer", opacity: loading || !pathInput.trim() ? 0.6 : 1 }}
          >
            {t("directoryPicker.go")}
          </button>
        </form>

        <div className="directory-picker-list" style={{ flex: 1, minHeight: 0, overflow: "auto", padding: "8px 10px" }}>
          {loading ? (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.loadingDirectories")}</div>
          ) : drives !== null ? (
            <>
              {drives.length > 0 ? (
                drives.map((drive) => (
                  <button
                    key={drive.path}
                    className="directory-picker-entry"
                    type="button"
                    onClick={() => void navigateTo(drive.path)}
                    title={drive.path}
                    style={{ width: "100%", minHeight: 34, display: "flex", alignItems: "center", gap: 7, padding: "6px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
                  >
                    <DriveIcon />
                    <span>{drive.name}</span>
                  </button>
                ))
              ) : (
                <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noDrives")}</div>
              )}
            </>
          ) : directories.length > 0 ? (
            directories.map((entry) => (
              <button
                key={entry.path}
                className="directory-picker-entry"
                type="button"
                onClick={() => void navigateTo(entry.path)}
                title={entry.path}
                style={{ width: "100%", minHeight: 30, display: "flex", alignItems: "center", gap: 7, padding: "5px 8px", border: 0, borderRadius: 5, background: "none", color: "var(--text-muted)", cursor: "pointer", textAlign: "left", fontFamily: "var(--font-mono)", fontSize: 11 }}
              >
                <FolderIcon />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{entry.name}</span>
              </button>
            ))
          ) : (
            <div style={{ padding: 8, color: "var(--text-dim)", fontSize: 11 }}>{t("directoryPicker.noSubdirectories")}</div>
          )}
          {(loadError || error) && <div style={{ padding: "8px", color: "#dc2626", fontSize: 11 }}>{loadError ?? error}</div>}
        </div>
        </>
        )}

        <div className="directory-picker-footer" style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, flexShrink: 0, padding: "10px 18px", borderTop: "1px solid var(--border)" }}>
          <button className="directory-picker-action" type="button" onClick={onCancel} disabled={busy || remoteBusy} style={{ padding: "6px 14px", border: "1px solid var(--border)", borderRadius: 6, background: "none", color: "var(--text-muted)", cursor: busy || remoteBusy ? "default" : "pointer", fontSize: 13 }}>{t("i18n.cancel")}</button>
          {mode === "local" && (
          <button
            className="directory-picker-action"
            type="button"
            onClick={() => onSelect(currentPath)}
            disabled={!canSelect}
            title={hasUncommittedPath ? t("directoryPicker.openBeforeSelecting") : t("directoryPicker.selectCurrentDirectory")}
            style={{ padding: "6px 16px", border: 0, borderRadius: 6, background: "var(--accent)", color: "var(--accent-contrast)", fontSize: 13, fontWeight: 600, opacity: canSelect ? 1 : 0.6, cursor: canSelect ? "pointer" : "default" }}
          >
            {busy ? t("i18n.checking") : t("directoryPicker.selectThisFolder")}
          </button>
          )}
        </div>
      </div>
    </div>,
    portalTarget,
  );
}
