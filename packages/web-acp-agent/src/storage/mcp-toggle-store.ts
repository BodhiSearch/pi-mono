/**
 * Per-session MCP toggle store — worker-side companion to the feature
 * store. Stores server and per-tool on/off flags keyed by ACP session
 * id.
 *
 * Semantics:
 * - Defaults are **on**; an absent key means "not explicitly
 *   toggled off". Callers merge via `isServerEnabled`/`isToolEnabled`
 *   before composing `McpServerHttp[]` (server toggles) or registering
 *   tools on `InlineAgent.setModel` (tool toggles).
 * - Writes are additive patches, not whole-row replacements, so the
 *   wire contract for `_bodhi/mcp/toggles/set` stays minimal.
 * - On session delete we drop the row; the `SessionStore` impl is
 *   responsible for the transactional path.
 *
 * The agent package ships only the interface + helpers; the host
 * runtime provides a concrete impl.
 */

/** Snapshot returned to the main thread on `bodhi/getSession`. */
export interface McpToggleSnapshot {
  servers: Record<string, boolean>;
  tools: Record<string, Record<string, boolean>>;
}

export const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;

export interface McpToggleStore {
  get(sessionId: string): Promise<McpToggleSnapshot>;
  setServer(sessionId: string, serverSlug: string, value: boolean): Promise<McpToggleSnapshot>;
  setTool(
    sessionId: string,
    serverSlug: string,
    toolName: string,
    value: boolean
  ): Promise<McpToggleSnapshot>;
  clear(sessionId: string): Promise<void>;
}

/**
 * True iff the given server slug is *enabled* (not explicitly turned
 * off) according to the snapshot. Absent entries are treated as on.
 */
export function isServerEnabled(
  toggles: McpToggleSnapshot | undefined,
  serverSlug: string
): boolean {
  if (!toggles) return true;
  const explicit = toggles.servers?.[serverSlug];
  return explicit !== false;
}

/**
 * True iff the given tool on the given server is enabled. Absent
 * entries are treated as on; the server-level toggle takes
 * precedence (an off server implies all its tools are off, which
 * callers typically handle upstream by skipping the server entirely).
 */
export function isToolEnabled(
  toggles: McpToggleSnapshot | undefined,
  serverSlug: string,
  toolName: string
): boolean {
  if (!toggles) return true;
  if (!isServerEnabled(toggles, serverSlug)) return false;
  const perServer = toggles.tools?.[serverSlug];
  if (!perServer) return true;
  return perServer[toolName] !== false;
}
