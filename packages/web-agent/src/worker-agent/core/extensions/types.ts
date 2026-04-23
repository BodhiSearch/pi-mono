/**
 * Extension types for the web-agent Worker.
 *
 * Authoritative reference: `ai-docs/specs/worker-agent/extensions.md`.
 *
 * Phase 1 surface: `before_agent_start` + `tool_result` hooks,
 * `registerTool`, `registerCommand`, plus the `Type` / `defineTool`
 * helpers re-exported on `pi` so authors don't need external imports.
 *
 * Phase 2a extended the surface with additional context / lifecycle
 * hooks (`context`, `tool_call`, `turn_start`, `message_end`,
 * `session_loaded` — reload only) and a minimal `pi.ui.*` channel
 * (notify, setStatus, select, confirm, input).
 *
 * Phase 2b closes the remaining delta to coding-agent:
 *  - `pi.ui.setTitle` / `setWidget` / `editor` / `setEditorText`
 *  - `pi.registerProvider` (extension-contributed LLM provider)
 *  - `pi.registerSkill` (extension-contributed skill descriptor)
 *  - `ctx.session` (ReadonlySessionManager forwarder)
 *  - `on('before_compact')` + `on('after_compact')`
 *  - widened `session_loaded.reason` so mount / switch / fork / new /
 *    navigate are all observable by extensions.
 */

import type {
  AgentMessage,
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentTool,
  ToolExecutionMode,
} from '@mariozechner/pi-agent-core';
import type { ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { Static, TSchema } from '@sinclair/typebox';
import type { LlmProvider } from '../../llm/types';
import type { ReadonlySessionManager, SessionEntry } from '../session/types';

export type { AgentToolResult, AgentToolUpdateCallback };

// ============================================================================
// UI Context (Phase 2a)
// ============================================================================

/**
 * Notification severity. Maps onto sonner's `info` / `warning` / `error`
 * toast helpers on the main thread.
 */
export type ExtensionUINotifyType = 'info' | 'warning' | 'error';

/**
 * Dialog options accepted by `pi.ui.select` / `confirm` / `input`.
 *
 * `signal` programmatically dismisses the dialog (resolving to
 * `undefined` / `false`). `timeout` auto-dismisses after the supplied
 * milliseconds; the main-thread renderer surfaces a countdown footer.
 *
 * Both options are resolved inside the Worker by the UI controller;
 * structured-clone-safe payloads cross the RPC boundary.
 */
export interface ExtensionUIDialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

/**
 * Option passed to `pi.ui.select`. `value` is the payload returned when
 * the user picks this entry; `label` is what the dialog renders.
 */
export interface ExtensionSelectOption<T = string> {
  label: string;
  value: T;
}

/**
 * Structured-clone-safe widget descriptor rendered inline in the
 * transcript. `kind` is a closed enum in Phase 2b; `props` carries
 * per-kind data and must stay JSON-serialisable (no React nodes, no
 * functions) because it crosses the Worker boundary.
 *
 * Kind schemas (informal):
 *   progress — { label?: string, value?: number /* 0-1 *\/, indeterminate?: boolean }
 *   info     — { title?: string, message: string, tone?: 'info' | 'success' | 'warning' | 'error' }
 *   choice   — { title?: string, message?: string, options: { label: string }[] }
 *              The `choice` widget is informational only — extensions
 *              wanting a user answer should use `ui.select`. We keep the
 *              kind because several coding-agent widgets render option
 *              lists as read-only hints.
 */
export interface ExtensionWidget {
  kind: 'progress' | 'info' | 'choice';
  props: Record<string, unknown>;
}

/** Optional configuration for `pi.ui.editor`. */
export interface ExtensionEditorOptions {
  /**
   * Language hint surfaced to the main-thread renderer (purely cosmetic
   * in 2b — the dialog is a plain textarea). Mirrors coding-agent's
   * editor API.
   */
  language?: string;
  /** Optional placeholder text when the editor opens empty. */
  placeholder?: string;
}

/**
 * Minimal UI channel exposed to extensions via `ctx.ui` and `pi.ui`.
 *
 * Every method marshals its arguments over RPC; responses resolve the
 * returned promise or fire the synchronous side effect (notify /
 * setStatus / setTitle / setWidget / setEditorText). The main-thread
 * renderer owns display + user interaction; the Worker owns lifecycle
 * (signal / timeout / session cancellation).
 */
export interface ExtensionUIContext {
  /** Show a transient toast. `type` maps to sonner's info / warning / error variants. */
  notify(message: string, type?: ExtensionUINotifyType): void;
  /**
   * Set a single status string rendered next to the model picker in the
   * `ChatInput` footer. Pass `undefined` (or no argument) to clear the
   * extension's current status chip.
   */
  setStatus(text?: string): void;
  /**
   * Set the chat-header title slot contributed by this extension. Pass
   * `null` / `undefined` to clear. Each extension owns a single slot;
   * the renderer shows the most-recently-updated non-null title.
   */
  setTitle(text?: string | null): void;
  /**
   * Add / replace / remove an inline transcript widget keyed by
   * `widgetId`. Pass `null` to remove. Multiple widgets per extension
   * are supported — each `widgetId` is an independent slot.
   */
  setWidget(widgetId: string, widget: ExtensionWidget | null): void;
  /**
   * Show a picker dialog with the supplied options. Resolves to the
   * selected value, or `undefined` if cancelled / aborted / timed out.
   */
  select<T = string>(
    title: string,
    options: ExtensionSelectOption<T>[],
    opts?: ExtensionUIDialogOptions
  ): Promise<T | undefined>;
  /**
   * Show a confirmation dialog. Resolves to `true` / `false`. `false`
   * is also returned on cancel / abort / timeout.
   */
  confirm(title: string, message: string, opts?: ExtensionUIDialogOptions): Promise<boolean>;
  /**
   * Prompt the user for a single-line string. Resolves to the entered
   * text, or `undefined` on cancel / abort / timeout.
   */
  input(
    title: string,
    placeholder?: string,
    opts?: ExtensionUIDialogOptions
  ): Promise<string | undefined>;
  /**
   * Open a multi-line editor dialog. Resolves to the submitted text,
   * or `undefined` when cancelled / aborted / session-reset. Mirrors
   * coding-agent's inline editor but uses a modal textarea in 2b.
   */
  editor(
    title: string,
    prefill?: string,
    opts?: ExtensionEditorOptions & ExtensionUIDialogOptions
  ): Promise<string | undefined>;
  /**
   * Programmatically update the text buffer of the currently-open
   * editor dialog for this extension. No-op when no editor is open or
   * the open editor belongs to a different extension.
   */
  setEditorText(text: string): void;
}

/**
 * Context provided to extension event handlers and command handlers.
 *
 * Phase 2a added `ui` (always present) + `hasUI` (always `true` for
 * the browser host — RPC / headless modes would set it to `false`).
 *
 * Phase 2b adds `session`, a thin read-only forwarder over the active
 * `SessionManager`. Every call re-reads the live session — when the
 * session has been swapped out the forwarder throws
 * `InvalidSessionError` rather than returning stale data. `session` is
 * `null` when the vault is unmounted or no session has been loaded yet.
 */
export interface ExtensionContext {
  /** Absolute vault mount path (e.g. `/vault`) or undefined when unmounted. */
  readonly cwd: string | undefined;
  /** True when the agent is not currently streaming. */
  isIdle(): boolean;
  /** Abort the current streaming run, if any. */
  abort(): void;
  /**
   * Minimal UI channel. Always present in the web-agent host; future
   * headless hosts may supply a no-op implementation and set
   * `hasUI: false`.
   */
  readonly ui: ExtensionUIContext;
  /** Whether the UI channel backs onto real interactive surfaces. */
  readonly hasUI: boolean;
  /**
   * Read-only view of the active session. `null` when no session is
   * loaded. Calls on a session that has since been swapped throw
   * `InvalidSessionError`.
   */
  readonly session: ReadonlySessionManager | null;
}

// ============================================================================
// Events
// ============================================================================

/**
 * Fired after command expansion and before the agent's loop starts for a
 * user prompt. Handlers can return a new `systemPrompt` to shape what the
 * LLM sees for this turn; multiple extensions chain (each sees the
 * previous override).
 */
export interface BeforeAgentStartEvent {
  type: 'before_agent_start';
  prompt: string;
  systemPrompt: string;
}

export interface BeforeAgentStartEventResult {
  systemPrompt?: string;
}

/**
 * Fired before every LLM call with the in-memory `AgentMessage[]` the
 * agent is about to convert and send. Handlers can return `{ messages }`
 * to replace the array wholesale. Backed by `pi-agent-core`'s
 * `transformContext` hook; each handler sees the previous handler's
 * override (chaining semantics mirror `before_agent_start`).
 */
export interface ContextEvent {
  type: 'context';
  messages: AgentMessage[];
}

export interface ContextEventResult {
  messages?: AgentMessage[];
}

/**
 * Fired before a tool executes. Handlers can mutate `event.input` in
 * place to shape arguments (later handlers + the executor see the
 * mutation; no re-validation is performed), or return `{ block, reason }`
 * to block the execution — the agent surfaces `reason` as the tool
 * result so the conversation continues gracefully.
 */
export interface ToolCallEvent {
  type: 'tool_call';
  toolCallId: string;
  toolName: string;
  /** Mutable. Changes apply to later handlers and the executor. */
  input: Record<string, unknown>;
}

export interface ToolCallEventResult {
  /** When `true`, the tool is not executed and `reason` is surfaced as the result. */
  block?: boolean;
  /** Human-readable explanation rendered to the LLM when `block === true`. */
  reason?: string;
}

/**
 * Fired after a tool executes, before the tool result is appended to the
 * transcript. Handlers can override `content`, `details`, and `isError`.
 * No deep merge — supplied fields replace wholesale.
 */
export interface ToolResultEvent {
  type: 'tool_result';
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  content: (TextContent | ImageContent)[];
  details: unknown;
  isError: boolean;
}

export interface ToolResultEventResult {
  content?: (TextContent | ImageContent)[];
  details?: unknown;
  isError?: boolean;
}

/**
 * Fired at the start of each assistant turn (mirrors pi-agent-core's
 * `turn_start` event). Observer only — the return value is ignored.
 */
export interface TurnStartEvent {
  type: 'turn_start';
}

/**
 * Fired at the end of each message (user, assistant, toolResult). Mirrors
 * pi-agent-core's `message_end` event. Observer only.
 */
export interface MessageEndEvent {
  type: 'message_end';
  message: AgentMessage;
}

/**
 * Discriminator for `session_loaded` invocations.
 *
 *   'mount'    — vault was mounted / dev-seeded; extension factories
 *                just finished running. Fires once per mount.
 *   'reload'   — `/reload` re-read the vault and reran factories.
 *   'switch'   — `loadSession` hydrated a different session from disk.
 *   'fork'     — `forkSession` created a new branch rooted at the
 *                current entry.
 *   'new'      — `newSession` created a fresh session (blank
 *                transcript).
 *   'navigate' — `navigateToLeaf` moved the pointer to a different
 *                leaf inside the same session.
 */
export type SessionLoadedReason = 'mount' | 'reload' | 'switch' | 'fork' | 'new' | 'navigate';

export interface SessionLoadedEvent {
  type: 'session_loaded';
  reason: SessionLoadedReason;
}

/**
 * Fired before the compaction pipeline selects its cut point. Handlers
 * may return `{ cutIndex }` to override the worker-selected index (the
 * first kept entry) or `{ preserveEntries }` to whitelist entry ids
 * that must be retained. Returning `undefined` leaves the cut unchanged.
 * Errors are logged and isolated — a failing handler cannot block
 * compaction.
 */
export interface BeforeCompactEvent {
  type: 'before_compact';
  /** Full branch path from root to leaf at the time compaction starts. */
  entries: SessionEntry[];
  /**
   * Index into `entries` the worker has selected as the first entry to
   * keep (everything before is summarised). Handlers returning a
   * different `cutIndex` must still fall inside `[0, entries.length]`.
   */
  cutIndex: number;
}

export interface BeforeCompactEventResult {
  /** New cut index; clamped to `[0, entries.length]`. */
  cutIndex?: number;
  /**
   * Entry ids that must be retained regardless of where the cut falls.
   * The worker merges these into the kept set before summarising. The
   * final kept prefix is still contiguous — see
   * `compaction/prepare.ts` for the exact semantics.
   */
  preserveEntries?: string[];
}

/**
 * Fired after compaction committed a summary entry. Observer only.
 *
 * `summary` is the summary text the worker persisted; `beforeCount` is
 * the number of branch entries prior to compaction, `afterCount` is
 * the number after. Extensions that track compaction analytics read
 * these fields directly — the values are structured-clone safe.
 */
export interface AfterCompactEvent {
  type: 'after_compact';
  summary: string;
  beforeCount: number;
  afterCount: number;
  tokensBefore: number;
}

/**
 * Phase 1 tool definition. Thinner than coding-agent's `ToolDefinition`
 * because there is no TUI to render into — no `renderCall` / `renderResult`
 * / `label` / theme-scoped hooks.
 */
export interface ToolDefinition<TParameters extends TSchema = TSchema, TDetails = unknown> {
  /** Tool name (used in LLM tool calls). */
  name: string;
  /** Description for the LLM. */
  description: string;
  /** Parameter schema (TypeBox). */
  parameters: TParameters;
  /**
   * Optional compatibility shim for raw tool-call arguments before schema
   * validation. Must return an object matching `TParameters`.
   */
  prepareArguments?: (args: unknown) => Static<TParameters>;
  /** Per-tool execution mode override. */
  executionMode?: ToolExecutionMode;
  /**
   * Execute the tool. The `ctx` is supplied by the `ExtensionRunner` so
   * the handler can inspect isIdle / abort / cwd without needing a
   * closure-captured reference.
   */
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionContext
  ): Promise<AgentToolResult<TDetails>>;
}

/**
 * Preserve parameter inference when an extension assigns a tool to a
 * variable before handing it to `pi.registerTool`. Mirrors coding-agent's
 * `defineTool` helper.
 */
export function defineTool<TParams extends TSchema, TDetails = unknown>(
  tool: ToolDefinition<TParams, TDetails>
): ToolDefinition<TParams, TDetails> {
  return tool;
}

/** Loaded-state record for a tool contributed by an extension. */
export interface RegisteredTool {
  definition: ToolDefinition;
  /** Absolute vault path of the extension that registered the tool. */
  extensionPath: string;
}

/**
 * Handler invoked when a user types `/commandName args` whose command
 * source is `extension`. The handler runs on the Worker side and receives
 * the argument suffix plus a command-scoped context.
 */
export type ExtensionCommandHandler = (args: string, ctx: ExtensionContext) => Promise<void> | void;

export interface RegisteredCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  handler: ExtensionCommandHandler;
  /** Absolute vault path of the extension that registered the command. */
  extensionPath: string;
}

/**
 * Input shape accepted by `pi.registerSkill`. Mirrors coding-agent's
 * `ExtensionSkill` loosely — `body` is the SKILL.md-style prompt the
 * worker injects inside a `<skill>` block when the user invokes
 * `/skill:<name>`. `disableModelInvocation` is carried on the
 * descriptor so the main-thread palette can surface the hint the same
 * way it does for vault-loaded skills.
 */
export interface ExtensionSkillInput {
  name: string;
  description: string;
  body: string;
  disableModelInvocation?: boolean;
}

/**
 * Worker-side loaded-state record for a skill contributed by an
 * extension. `extensionPath` is the owning extension's absolute path;
 * the controller clears every record keyed by that path on factory
 * reload.
 */
export interface RegisteredSkill extends ExtensionSkillInput {
  extensionPath: string;
}

/**
 * Loaded-state record for a provider contributed by an extension. The
 * `extensionPath` discriminator lets the provider controller reconcile
 * on extension churn; `provider` is the full `LlmProvider` instance the
 * factory returned.
 */
export interface RegisteredProvider {
  /** Stable identifier used by catalog entries' `provider` field. */
  providerId: string;
  provider: LlmProvider;
  extensionPath: string;
}

export type ExtensionEventHandler<E, R = void> = (
  event: E,
  ctx: ExtensionContext
) => Promise<R | void> | R | void;

/**
 * The object passed to an extension's factory function.
 *
 * Phase 2a overloads cover: context / tool_call / before_agent_start /
 * tool_result / turn_start / message_end / session_loaded. `pi.ui`
 * mirrors `ctx.ui` for authoring convenience (either works identically).
 */
export interface ExtensionAPI {
  /** Subscribe to `before_agent_start`. Returning a new systemPrompt overrides the current one for this turn. */
  on(
    event: 'before_agent_start',
    handler: ExtensionEventHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>
  ): void;
  /**
   * Subscribe to `context`. Returning `{ messages }` replaces the
   * `AgentMessage[]` the agent is about to send to the LLM. Chained in
   * load order.
   */
  on(event: 'context', handler: ExtensionEventHandler<ContextEvent, ContextEventResult>): void;
  /**
   * Subscribe to `tool_call`. Mutate `event.input` in place to shape
   * arguments; return `{ block: true, reason }` to block execution.
   */
  on(event: 'tool_call', handler: ExtensionEventHandler<ToolCallEvent, ToolCallEventResult>): void;
  /** Subscribe to `tool_result`. Returning fields overrides content/details/isError before the result is committed. */
  on(
    event: 'tool_result',
    handler: ExtensionEventHandler<ToolResultEvent, ToolResultEventResult>
  ): void;
  /** Subscribe to `turn_start`. Observer only. */
  on(event: 'turn_start', handler: ExtensionEventHandler<TurnStartEvent>): void;
  /** Subscribe to `message_end`. Observer only. */
  on(event: 'message_end', handler: ExtensionEventHandler<MessageEndEvent>): void;
  /**
   * Subscribe to `session_loaded`. Fires once per mount / reload and
   * once for every session transition (`new`, `switch`, `fork`,
   * `navigate`). Observer only.
   */
  on(event: 'session_loaded', handler: ExtensionEventHandler<SessionLoadedEvent>): void;
  /**
   * Subscribe to `before_compact`. Handlers may return `{ cutIndex }`
   * and/or `{ preserveEntries }` to influence the compaction cut point.
   * Errors are isolated per-extension.
   */
  on(
    event: 'before_compact',
    handler: ExtensionEventHandler<BeforeCompactEvent, BeforeCompactEventResult>
  ): void;
  /** Subscribe to `after_compact`. Observer only. */
  on(event: 'after_compact', handler: ExtensionEventHandler<AfterCompactEvent>): void;

  /** Register an LLM-callable tool. Descriptor propagates to the main thread; execute stays in-worker. */
  registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(
    tool: ToolDefinition<TParams, TDetails>
  ): void;

  /**
   * Register a slash command under `name`. The main thread's palette
   * surfaces it with `source: 'extension'`; invocation routes to the
   * registered handler (not the LLM).
   */
  registerCommand(
    name: string,
    options: {
      description?: string;
      argumentHint?: string;
      handler: ExtensionCommandHandler;
    }
  ): void;

  /**
   * Register an extension-contributed LLM provider. The worker's
   * composite provider dispatches `(provider, id)` look-ups to the
   * first matching contributor before falling back to the built-in
   * (Bodhi) provider. `providerId` must be unique across extensions;
   * later registrations under the same id replace earlier ones.
   */
  registerProvider(providerId: string, provider: LlmProvider): void;

  /**
   * Register an extension-contributed skill. The skill appears in the
   * slash palette with `source: 'extension-skill'` and expands into a
   * `<skill>` block using the supplied `body` when invoked via
   * `/skill:<name>`.
   */
  registerSkill(skill: ExtensionSkillInput): void;

  /**
   * UI channel, identical to `ctx.ui` in handlers. Exposed on `pi` as a
   * convenience for command / tool implementations that close over `pi`
   * in the factory.
   */
  readonly ui: ExtensionUIContext;

  /** Helper re-exported so extensions don't need to import `@sinclair/typebox`. */
  readonly Type: typeof import('@sinclair/typebox').Type;
  /** Helper re-exported so extensions don't need to import the tool definition helper. */
  readonly defineTool: typeof defineTool;
}

/** Extension factory function. Supports sync or async initialisation. */
export type ExtensionFactory = (pi: ExtensionAPI) => void | Promise<void>;

export interface ExtensionManifest {
  name: string;
  version?: string;
  description?: string;
}

/**
 * Worker-side record of a successfully loaded extension.
 *
 * Handlers are keyed by event type. Tools and commands are keyed by name
 * to make collision detection cheap. `factory` is retained only for
 * diagnostic purposes — the runner never re-invokes it.
 */
export interface Extension extends ExtensionManifest {
  /** Absolute vault path of the extension folder (e.g. `/vault/.pi/extensions/hello`). */
  path: string;
  /** Absolute vault path of the entry file actually imported. */
  entryPath: string;
  handlers: Map<string, ExtensionEventHandler<unknown, unknown>[]>;
  tools: Map<string, RegisteredTool>;
  commands: Map<string, RegisteredCommand>;
  /** Providers the extension contributed during factory execution. Populated by the loader. */
  providers: Map<string, RegisteredProvider>;
  /** Skills the extension contributed during factory execution. Populated by the loader. */
  skills: Map<string, RegisteredSkill>;
}

/**
 * Plain-data descriptor emitted over RPC for the main-thread
 * ExtensionsPanel. Carries load state + error so the UI can surface
 * broken extensions without the worker needing separate `loadedExtensions`
 * + `brokenExtensions` streams.
 */
export interface ExtensionDescriptor {
  name: string;
  description?: string;
  version?: string;
  /** Absolute vault path of the extension folder. */
  path: string;
  /** Whether the main thread has requested the extension be enabled. */
  enabled: boolean;
  /** Whether the extension is currently loaded (factory ran successfully). */
  loaded: boolean;
  /** Populated when discovery or load failed. */
  error?: string;
}

/**
 * Diagnostic envelope for hook / tool / factory failures after load.
 *
 * The worker surfaces one of these on every caught throw from an
 * extension so the main thread can render a transient message. Same
 * treatment as compaction errors.
 */
export interface ExtensionError {
  extensionPath: string;
  event: string;
  error: string;
  stack?: string;
}

/**
 * Supplies a live `ExtensionContext` to the wrapper on every tool
 * invocation. Using a supplier (rather than a snapshot) keeps
 * `isIdle` / `cwd` / `ui` current regardless of when the tool was
 * registered.
 */
export type ContextSupplier = () => ExtensionContext;
export type { AgentTool };
