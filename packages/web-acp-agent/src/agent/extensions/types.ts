/**
 * Public shape of `pi: ExtensionAPI` and the descriptors the
 * `_bodhi/extensions/list` ext-method ships back to the host.
 * The full union is declared up front so the typed surface stays
 * stable as later phases wire dispatch for individual events.
 */

import type { AgentTool } from '@mariozechner/pi-agent-core';
import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
} from '@mariozechner/pi-ai';
import type { TSchema, Type as TypeNamespace } from '@sinclair/typebox';
import type { ExtensionsFs } from './extensions-fs';
import type { VolumeSnapshot } from '../volume-registry';

export interface Disposable {
  dispose(): void;
}

export type ExtensionTool = AgentTool<TSchema, unknown>;
export type ExtensionTypeBuilder = typeof TypeNamespace;

export interface ExtensionCommandDefinition {
  description?: string;
  inputHint?: string;
  handler: (args: string) => string | Promise<string>;
}

export type ExtensionEvent =
  | 'session_start'
  | 'before_agent_start'
  | 'turn_start'
  | 'turn_end'
  | 'input'
  | 'tool_call'
  | 'tool_result'
  | 'before_provider_request'
  | 'after_provider_response'
  | 'resources_discover';

export interface SessionStartEvent {
  readonly type: 'session_start';
  readonly sessionId: string;
}

export interface BeforeAgentStartEvent {
  readonly type: 'before_agent_start';
  readonly sessionId: string;
  readonly prompt: string;
  readonly systemPrompt: string;
}

export interface BeforeAgentStartEventResult {
  systemPrompt?: string;
}

export type InputEventSource = 'user' | 'extension';

export interface InputEvent {
  readonly type: 'input';
  readonly sessionId: string;
  readonly text: string;
  readonly source: InputEventSource;
}

export interface InputResultContinue {
  action: 'continue';
}
export interface InputResultTransform {
  action: 'transform';
  text: string;
}
export interface InputResultHandled {
  action: 'handled';
}

export type InputEventResult = InputResultContinue | InputResultTransform | InputResultHandled;

export type GenericExtensionEventHandler = (event: unknown) => unknown | Promise<unknown>;

export type SessionStartHandler = (event: SessionStartEvent) => void | Promise<void>;
export type BeforeAgentStartHandler = (
  event: BeforeAgentStartEvent
) =>
  | BeforeAgentStartEventResult
  | undefined
  | void
  | Promise<BeforeAgentStartEventResult | undefined | void>;
export type InputHandler = (
  event: InputEvent
) => InputEventResult | undefined | void | Promise<InputEventResult | undefined | void>;

export interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly sessionId: string;
  readonly toolName: string;
  /** Validated tool arguments. Handlers may mutate this object in place to rewrite the call. */
  readonly input: Record<string, unknown>;
}

export interface ToolCallEventResult {
  block?: boolean;
  reason?: string;
}

export interface ToolResultEvent {
  readonly type: 'tool_result';
  readonly sessionId: string;
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly content: unknown[];
  readonly details: unknown;
  readonly isError: boolean;
}

export interface ToolResultEventResult {
  content?: unknown[];
  details?: unknown;
  isError?: boolean;
}

export type ToolCallHandler = (
  event: ToolCallEvent
) => ToolCallEventResult | undefined | void | Promise<ToolCallEventResult | undefined | void>;

export type ToolResultHandler = (
  event: ToolResultEvent
) => ToolResultEventResult | undefined | void | Promise<ToolResultEventResult | undefined | void>;

export interface BeforeProviderRequestEvent {
  readonly type: 'before_provider_request';
  readonly sessionId: string;
  /**
   * Provider-shaped JSON payload about to be sent on the wire
   * (OpenAI completions / Anthropic messages / etc.). The payload
   * is **not** structurally validated — extensions inspect or
   * replace it at their own risk. Returning a replacement object
   * passes it on to the next handler in load order; the last
   * handler's value is what the provider receives.
   */
  readonly payload: unknown;
}

/**
 * Handler return contract: returning a new value replaces the
 * payload; returning `undefined` / `void` / the original payload
 * leaves it unchanged. Match the shape coding-agent uses so
 * ports drop in cleanly.
 */
export type BeforeProviderRequestHandler = (
  event: BeforeProviderRequestEvent
) => unknown | Promise<unknown>;

export interface AfterProviderResponseEvent {
  readonly type: 'after_provider_response';
  readonly sessionId: string;
  readonly status: number;
  readonly headers: Record<string, string>;
}

/**
 * Observation-only — return value is ignored. Throwing is
 * caught by the runner and logged as an error event without
 * affecting the LLM round-trip.
 */
export type AfterProviderResponseHandler = (
  event: AfterProviderResponseEvent
) => void | Promise<void>;

export interface ExtensionVolumesView {
  list(): VolumeSnapshot[];
}

/**
 * Shared pub/sub surface across loaded extensions. Channel names
 * are free-form strings; payloads are `unknown` (extensions agree
 * on a shape out-of-band). Returning a `Disposable` keeps lifetime
 * management symmetric with `pi.on(...)` lifecycle events.
 */
export type ExtensionEventsHandler = (data: unknown) => void | Promise<void>;

export interface ExtensionEventsView {
  /**
   * Awaits every subscriber in registration order. Returning the
   * promise lets callers (e.g. slash command handlers) chain
   * `await pi.events.emit(...)` and keep `pi.session.*` context
   * alive across async listeners.
   */
  emit(channel: string, data: unknown): Promise<void>;
  on(channel: string, handler: ExtensionEventsHandler): Disposable;
}

export interface ExtensionSessionView {
  /**
   * Returns the active session id when the extension's call site
   * is bound to a session (handlers fired through dispatch always
   * have one). Returns `null` when no session is active.
   */
  getId(): string | null;
  /**
   * Append a custom session entry. Persisted by the host's
   * session store and replayed on `session/load`. The host
   * decides whether to render it inline; agent-side guarantee is
   * persistence + replay.
   */
  appendEntry(customType: string, data: unknown): Promise<void>;
  /**
   * Update the session title. Empty string clears the title and
   * lets the host fall back to the auto-derived first-prompt
   * title.
   */
  setName(name: string): Promise<void>;
  /**
   * Read the active session name. `null` when nothing is set
   * (host falls back to the auto-derived title).
   */
  getName(): string | null;
  /**
   * Attach a free-form label to a previously appended entry.
   * Phase 8 wires the API; full label persistence lands with M7
   * (templates + skills) — until then this is a best-effort log.
   */
  setLabel(entryId: string, label: string | undefined): Promise<void>;
  /**
   * Inject a non-LLM message into the session transcript. The
   * host renders it as an extension-tagged chunk; pi-agent-core
   * never sees it.
   */
  sendMessage(text: string): Promise<void>;
  /**
   * Inject a user-side message that triggers a normal LLM turn.
   * Routed through the same path as user-typed input, including
   * `input` callbacks (with `source: 'extension'`).
   */
  sendUserMessage(text: string): Promise<void>;
}

/**
 * Per-model definition emitted by `pi.registerProvider`. Mirrors
 * the coding-agent shape so ports drop in cleanly. Cost / context
 * window stay per-model (provider-level defaults would force every
 * model into the same shape).
 */
export interface ProviderModelConfig {
  id: string;
  name: string;
  api?: Api;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
}

/**
 * OAuth scaffolding (Phase 11). Type-fixed but **not** wired to a
 * host bridge in M6 — the agent stores credential definitions and
 * the host can probe them post-M6 via `_bodhi/auth/*` (RFC pending,
 * see `extensions.md`). Extensions written today should register
 * `oauth` if relevant; M6 simply ignores it at runtime.
 */
export interface ProviderOAuthCredentials {
  readonly access: string;
  readonly refresh?: string;
  readonly expires?: number;
}

export interface ProviderOAuthLoginCallbacks {
  onAuth(args: { url: string }): void;
  onPrompt(args: { message: string }): Promise<string>;
}

export interface ProviderOAuthConfig {
  readonly name: string;
  login(callbacks: ProviderOAuthLoginCallbacks): Promise<ProviderOAuthCredentials>;
  refreshToken(credentials: ProviderOAuthCredentials): Promise<ProviderOAuthCredentials>;
  getApiKey(credentials: ProviderOAuthCredentials): string;
}

/**
 * Custom streamSimple shape — extensions may bring their own
 * provider implementation when no built-in `pi-ai` API matches.
 * Most ports leave this `undefined` and rely on the matching
 * built-in API (the `api` field).
 */
export type ProviderStreamSimple = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions
) => AssistantMessageEventStream;

export interface ProviderConfig {
  /** Base URL for the API endpoint. Required when defining models. */
  baseUrl?: string;
  /**
   * API key (literal) or environment variable name (when prefixed
   * with `env:`). Browser hosts read literal values; the host bridge
   * may resolve other shapes post-M6.
   */
  apiKey?: string;
  /** API format. Required at provider or model level when defining models. */
  api?: Api;
  /** Custom streamSimple handler for non-built-in APIs. */
  streamSimple?: ProviderStreamSimple;
  /** Custom HTTP headers to include in requests (merged with agent headers). */
  headers?: Record<string, string>;
  /** When true, the agent injects `Authorization: Bearer <apiKey>`. Default: false. */
  authHeader?: boolean;
  /** Models to register under this provider. */
  models?: ProviderModelConfig[];
  /** OAuth scaffolding — typed for M6 but not host-wired yet. */
  oauth?: ProviderOAuthConfig;
}

export interface ExtensionAPI {
  readonly extensionName: string;
  readonly fs: ExtensionsFs;
  readonly volumes: ExtensionVolumesView;
  readonly types: ExtensionTypeBuilder;
  readonly session: ExtensionSessionView;
  readonly events: ExtensionEventsView;
  on(event: 'session_start', handler: SessionStartHandler): Disposable;
  on(event: 'before_agent_start', handler: BeforeAgentStartHandler): Disposable;
  on(event: 'input', handler: InputHandler): Disposable;
  on(event: 'tool_call', handler: ToolCallHandler): Disposable;
  on(event: 'tool_result', handler: ToolResultHandler): Disposable;
  on(event: 'before_provider_request', handler: BeforeProviderRequestHandler): Disposable;
  on(event: 'after_provider_response', handler: AfterProviderResponseHandler): Disposable;
  on(event: ExtensionEvent, handler: GenericExtensionEventHandler): Disposable;
  registerTool(tool: ExtensionTool): Disposable;
  registerCommand(name: string, definition: ExtensionCommandDefinition): Disposable;
  registerProvider(name: string, config: ProviderConfig): Disposable;
}

export interface ExtensionCommandInfo {
  readonly name: string;
  readonly description?: string;
  readonly inputHint?: string;
  readonly ownerExtension: string;
}

export type ExtensionEventHandler = GenericExtensionEventHandler;

export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export interface ExtensionCapabilities {
  /** Lifecycle event names this extension subscribed to via `pi.on`. */
  events: string[];
  /** Tool names from `pi.registerTool` (Phase 5). */
  tools: string[];
  /** Slash command names from `pi.registerCommand` (Phase 7). */
  commands: string[];
  /** Provider names from `pi.registerProvider` (Phase 11). */
  providers: string[];
}

export interface ExtensionInfo {
  name: string;
  mountName: string;
  sourcePath: string;
  capabilities: ExtensionCapabilities;
}
