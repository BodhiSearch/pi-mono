export type {
  Agent,
  AuthenticateRequest,
  AuthenticateResponse,
  AvailableCommand,
  AvailableCommandInput,
  AvailableCommandsUpdate,
  CancelNotification,
  Client,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  StopReason,
  UnstructuredCommandInput,
} from '@agentclientprotocol/sdk';
export { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

export const BODHI_AUTH_METHOD_ID = 'bodhi-token';
export const BODHI_GET_SESSION_METHOD = '_bodhi/session/get';
/** Deprecated synonym for `_bodhi/session/get`; accepted for one release window. */
export const BODHI_GET_SESSION_METHOD_LEGACY = 'bodhi/getSession';

export const BODHI_VOLUMES_LIST_METHOD = '_bodhi/volumes/list';

export const BODHI_MCP_TOGGLES_SET_METHOD = '_bodhi/mcp/toggles/set';

// `Agent.closeSession` frees in-memory resources only; this extension
// drops the persisted row for the user-visible "delete" gesture.
export const BODHI_SESSIONS_DELETE_METHOD = '_bodhi/sessions/delete';

/** Verbatim shape of BodhiApp's `/bodhi/v1/info` response (snake_case). */
export interface BodhiServerInfoResponse extends Record<string, unknown> {
  version: string;
  status: string;
  url: string;
  client_id?: string;
}

/**
 * `_meta` shape on `AuthenticateResponse`. The agent populates
 * `bodhi.providerInfo` with whatever the configured `LlmProvider`
 * returned from `setAuthToken` — for `BodhiProvider` this is the
 * `/bodhi/v1/info` payload (`BodhiServerInfoResponse`).
 */
export interface BodhiAuthenticateResponseMeta {
  bodhi?: {
    providerInfo?: unknown;
  };
}

export interface BodhiVolumeDescriptor {
  mountName: string;
  description?: string;
}

export interface BodhiVolumesListResponse extends Record<string, unknown> {
  volumes: BodhiVolumeDescriptor[];
}

export interface BodhiAuthenticateMeta {
  token: string;
  baseUrl: string;
}

/**
 * Snapshot of a session's UI-ready state — the condensed view the
 * client needs after `session/load` to rebuild the transcript and
 * restore model selection without having to aggregate streamed
 * chunks itself. Sourced from the last `turn` entry in the session
 * store (which records the full conversation after each turn).
 */
export interface BodhiGetSessionRequest extends Record<string, unknown> {
  sessionId: string;
}

export interface BodhiGetSessionResponse extends Record<string, unknown> {
  sessionId: string;
  messages: unknown[];
  lastModelId: string | null;
  title: string | null;
  mcpToggles: BodhiMcpToggleSnapshot;
}

/**
 * Per-session MCP toggle snapshot surfaced on `bodhi/getSession`.
 * Absence of a key means "default on" — the worker never materialises
 * a `true` entry just to mirror the default.
 */
export interface BodhiMcpToggleSnapshot extends Record<string, unknown> {
  servers: Record<string, boolean>;
  tools: Record<string, Record<string, boolean>>;
}

/**
 * Mutation payload for `_bodhi/mcp/toggles/set`. Exactly one of
 * `serverSlug` (for a server-level override) or
 * `{ serverSlug, toolName }` (for a per-tool override) must be
 * provided. `value` is the new desired on/off state.
 */
export interface BodhiMcpTogglesSetRequest extends Record<string, unknown> {
  sessionId: string;
  serverSlug: string;
  toolName?: string;
  value: boolean;
}

export interface BodhiMcpTogglesSetResponse extends Record<string, unknown> {
  toggles: BodhiMcpToggleSnapshot;
}

export interface BodhiSessionsDeleteRequest extends Record<string, unknown> {
  sessionId: string;
}

/**
 * `deleted: false` means the worker had no record of the session — the
 * call is treated as a no-op rather than an error so clients can issue
 * delete-after-delete (or race two delete clicks) without surfacing a
 * spurious failure.
 */
export interface BodhiSessionsDeleteResponse extends Record<string, unknown> {
  deleted: boolean;
}

/**
 * Generic descriptor for a client-side action a built-in delegates to,
 * carried on the `_bodhi/builtin/action` extNotification. `params` is
 * present iff `P` is non-void. Use per-kind aliases when constructing
 * and {@link AnyBodhiBuiltinAction} when narrowing on `kind`.
 */
export type BodhiBuiltinAction<K extends string = string, P = void> = [P] extends [void]
  ? { kind: K }
  : { kind: K; params: P };

export interface BodhiMcpUrlParams {
  url: string;
}

export type BodhiBuiltinCopyAction = BodhiBuiltinAction<'copy'>;
export type BodhiBuiltinMcpAddAction = BodhiBuiltinAction<'mcp-add', BodhiMcpUrlParams>;
export type BodhiBuiltinMcpRemoveAction = BodhiBuiltinAction<'mcp-remove', BodhiMcpUrlParams>;

/**
 * Discriminated union of every concrete built-in action kind. Switch
 * on `action.kind` to narrow to the per-kind shape. New built-in
 * actions land here as a new member.
 */
export type AnyBodhiBuiltinAction =
  | BodhiBuiltinCopyAction
  | BodhiBuiltinMcpAddAction
  | BodhiBuiltinMcpRemoveAction;

/**
 * Marker stamped onto the in-memory `AgentMessage` shape on the
 * client side so `MessageBubble` can render built-in turns muted with
 * a "not sent to LLM" badge. It survives `bodhi/getSession` replay
 * because the worker writes both the user and assistant entries with
 * this marker when reconstructing the snapshot.
 */
export interface BodhiBuiltinTag {
  command: string;
  action?: AnyBodhiBuiltinAction;
}

/**
 * Lightweight Bodhi MCP instance descriptor passed alongside
 * `requestedMcpUrls` so worker-side `/mcp` can render Connected
 * entries with the human-readable `name` (matching against
 * `slug` alone misses Bodhi-side renames).
 */
export interface BodhiMcpInstanceDescriptor {
  slug: string;
  name: string;
  /** Bodhi-internal proxy path, e.g. `/bodhi/v1/apps/mcps/{id}/mcp`. */
  path: string;
}

/**
 * Per-session bundle stamped onto `_meta.bodhi` of `session/new` and
 * `session/load` requests. `requestedMcpUrls` is the user's main-thread
 * IDB-persisted "MCP servers I want Bodhi to approve" list; the
 * worker reads it for `/mcp` listing + `/mcp add` / `/mcp remove`
 * idempotency feedback. Source of truth lives on the main thread.
 */
export interface BodhiSessionMeta {
  requestedMcpUrls?: string[];
  mcpInstances?: BodhiMcpInstanceDescriptor[];
}

/** Extras stamped on `_meta.bodhi` of `SessionInfo` from `Agent.listSessions`. */
export interface BodhiSessionInfoMeta {
  turnCount: number;
  lastModelId: string | null;
  createdAt: number;
}

/** Extras stamped on `_meta.bodhi` of `LoadSessionResponse` (ACP carries neither natively). */
export interface BodhiLoadSessionMeta {
  title?: string | null;
  mcpToggles?: BodhiMcpToggleSnapshot;
}

export const BODHI_MCP_STATE_NOTIFICATION_METHOD = '_bodhi/mcp/state';
export const BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD = '_bodhi/builtin/action';

export interface BodhiMcpStateNotificationParams extends Record<string, unknown> {
  sessionId: string;
  server: string;
  state: string;
  error?: string;
  tools?: string[];
}

export interface BodhiBuiltinActionNotificationParams extends Record<string, unknown> {
  sessionId: string;
  command: string;
  action: AnyBodhiBuiltinAction;
}

/** Per-session feature toggle config-option ids surfaced via `Agent.setSessionConfigOption`. */
export const BODHI_FEATURE_BASH_ENABLED_CONFIG_ID = '_bodhi/features/bashEnabled';
export const BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID = '_bodhi/features/forceToolCall';
export const BODHI_FEATURE_CONFIG_CATEGORY = '_bodhi/feature';
