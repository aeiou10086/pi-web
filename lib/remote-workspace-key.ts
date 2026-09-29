/**
 * Client-safe remote workspace key helpers. Must not import anything that pulls
 * Node builtins or the coding-agent SDK (those break the browser bundle).
 */

export const REMOTE_IDENTITY_PREFIX = "remote:ssh:";

/** True when a string is a remote workspace identity (`remote:ssh:...`). */
export function isRemoteWorkspaceKey(value: string): boolean {
  return value.startsWith(REMOTE_IDENTITY_PREFIX);
}
