/**
 * Main-thread projection of an MCP instance fetched from
 * `bodhiClient.mcps.list()`. Keeps the surface we pass around narrow —
 * only the fields the web-acp main thread needs to compose
 * `McpServerHttp` entries and render the status panel. The full
 * `Mcp` record from `@bodhiapp/ts-client` carries auth-config plumbing
 * that is not consumed by the agent worker.
 */
export interface McpInstanceView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** MCP proxy path, e.g. `/bodhi/v1/apps/mcps/{id}/mcp` (server-relative). */
  path: string;
  /** `public` | `header` | `oauth`. Surfaced for future UI hints; the worker never branches on this today. */
  authType: string;
}

/**
 * Per-server lifecycle state the worker reports via `session/update`
 * (`_meta.bodhi.mcp`). Mirrored on the main thread for the status chip
 * in `McpPanel`.
 */
export type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpConnectionMeta {
  server: string;
  state: McpConnectionState;
  error?: string;
  tools?: string[];
}

/**
 * Extension slot attached to a `session/update` notification. The
 * adapter emits an `agent_message_chunk` with an empty delta as the
 * carrier — ACP doesn't define a first-class verb for transport-level
 * events, but `_meta.bodhi.mcp` is the spec-sanctioned way to stamp
 * our own payload onto an otherwise well-formed update. See
 * `specs/web-acp/mcp.md` for the wire contract.
 */
export interface BodhiMcpUpdateMeta {
  bodhi?: {
    mcp?: McpConnectionMeta;
  };
}
