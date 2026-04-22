/**
 * Extension types for the web-agent Worker.
 *
 * Authoritative reference: `ai-docs/specs/worker-agent/extensions.md`.
 *
 * Phase 1 surface: `before_agent_start` + `tool_result` hooks,
 * `registerTool`, `registerCommand`, plus the `Type` / `defineTool`
 * helpers re-exported on `pi` so authors don't need external imports.
 *
 * Phase 2a extends the surface with additional context / lifecycle
 * hooks (`context`, `tool_call`, `turn_start`, `message_end`,
 * `session_loaded`) and a minimal `pi.ui.*` channel (notify, setStatus,
 * select, confirm, input). Widgets, editor, setTitle, registerProvider,
 * registerSkill, session access, and compaction hooks are deferred to
 * Phase 2b.
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
 * Minimal UI channel exposed to extensions via `ctx.ui` and `pi.ui`.
 *
 * Every method marshals its arguments over RPC; responses resolve the
 * returned promise or fire the synchronous side effect (notify /
 * setStatus). The main-thread renderer owns display + user interaction;
 * the Worker owns lifecycle (signal / timeout / session cancellation).
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
}

/**
 * Context provided to extension event handlers and command handlers.
 *
 * Phase 2a adds `ui` (always present) + `hasUI` (always `true` for the
 * browser host — RPC / headless modes would set it to `false`). Session
 * access, model registry, and compaction controls remain deferred to
 * Phase 2b.
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
 * Phase 2a only fires this on `/reload` — initial mount + dev-seed
 * happen before extensions subscribe, so there is no one to notify.
 * Phase 3 needs to revisit the boot lifecycle.
 */
export interface SessionLoadedEvent {
  type: 'session_loaded';
  /** The only reason that can fire in Phase 2a. */
  reason: 'reload';
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
  /** Subscribe to `session_loaded`. Phase 2a only fires on `/reload`. Observer only. */
  on(event: 'session_loaded', handler: ExtensionEventHandler<SessionLoadedEvent>): void;

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
