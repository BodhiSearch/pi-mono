export { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

export type {
  Agent,
  AvailableCommand,
  AvailableCommandInput,
  AvailableCommandsUpdate,
  Client,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
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

export const BODHI_AUTH_METHOD_ID = 'bodhi-token';
export const BODHI_LIST_MODELS_METHOD = 'bodhi/listModels';
export const BODHI_LIST_SESSIONS_METHOD = 'bodhi/listSessions';
export const BODHI_GET_SESSION_METHOD = 'bodhi/getSession';

// M2 extension methods use the spec-blessed `_`-prefix; the older
// `bodhi/*` constants above stay unchanged to preserve M1 client-side
// contracts (a rename is tracked as a deferred cleanup item).
export const BODHI_VOLUMES_LIST_METHOD = '_bodhi/volumes/list';
export const BODHI_FEATURES_LIST_METHOD = '_bodhi/features/list';
export const BODHI_FEATURES_SET_METHOD = '_bodhi/features/set';

// M3 phase B: per-session MCP server / tool toggles. Defaults are all
// "on"; only explicit overrides travel on the wire. See
// `specs/web-acp/mcp.md` for the snapshot contract returned via
// `bodhi/getSession` and the mutation handler below.
export const BODHI_MCP_TOGGLES_SET_METHOD = '_bodhi/mcp/toggles/set';

// Persistent removal of a session and its associated entries / features /
// MCP toggles. ACP has no stable `session/delete`; `session/close` in the
// unstable schema means "free in-memory resources", not "remove from
// disk", so we ride a `_bodhi/*` extension per principle § 15.
export const BODHI_SESSIONS_DELETE_METHOD = '_bodhi/sessions/delete';

export interface BodhiVolumeDescriptor {
  mountName: string;
  description?: string;
}

export interface BodhiVolumesListResponse extends Record<string, unknown> {
  volumes: BodhiVolumeDescriptor[];
}

export type BodhiFeatureBag = Record<string, boolean>;

export interface BodhiFeaturesListResponse extends Record<string, unknown> {
  features: BodhiFeatureBag;
  defaults: BodhiFeatureBag;
}

export interface BodhiFeaturesSetRequest extends Record<string, unknown> {
  sessionId: string;
  key: string;
  value: boolean;
}

export interface BodhiFeaturesSetResponse extends Record<string, unknown> {
  features: BodhiFeatureBag;
}

export interface BodhiAuthenticateMeta {
  token: string;
  baseUrl: string;
}

export interface BodhiModelDescriptor {
  id: string;
  apiFormat: string;
}

export interface BodhiListModelsResponse extends Record<string, unknown> {
  models: BodhiModelDescriptor[];
}

/**
 * Session summary surfaced to the client for the picker. Mirrors
 * `SessionSummary` in `agent/session-store` but is the wire contract —
 * kept independent so the worker can evolve store internals without
 * breaking clients.
 */
export interface BodhiSessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastModelId: string | null;
}

export interface BodhiListSessionsResponse extends Record<string, unknown> {
  sessions: BodhiSessionSummary[];
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
 * a `true` entry just to mirror the default. Added in M3 phase B.
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
 * Wire shape carried on `_meta.bodhi.builtin` for `session/update`
 * notifications produced by an agent-handled slash command (M4 phase
 * B). Rides on `agent_message_chunk` notifications the same way
 * `_meta.bodhi.mcp` rides — the client's hook reads it before the
 * normal chunk-accumulation path so built-in messages render distinctly
 * and any `action` is dispatched (e.g. `/copy` → clipboard write).
 *
 * `action.kind` is open-ended for future built-ins (`'share'`,
 * `'export-html'`, …); the actual payload is built on the client at
 * dispatch time so persisted records stay minimal.
 */
export interface BodhiBuiltinAction {
  kind: string;
}

export interface BodhiBuiltinMeta {
  command: string;
  action?: BodhiBuiltinAction;
}

/**
 * Marker stamped onto the in-memory `AgentMessage` shape on the
 * client side so `MessageBubble` can render built-in turns muted with
 * a "not sent to LLM" badge. It survives `bodhi/getSession` replay
 * because the worker writes both the user and assistant entries with
 * this marker when reconstructing the snapshot.
 */
export interface BodhiBuiltinTag {
  command: string;
  action?: BodhiBuiltinAction;
}
