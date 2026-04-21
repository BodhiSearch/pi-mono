/**
 * Phase 1 extension types for the web-agent Worker.
 *
 * Authoritative reference: `ai-docs/specs/worker-agent/extensions.md`.
 * Phase 1 surface is: `before_agent_start` + `tool_result` hooks,
 * `registerTool`, `registerCommand`, plus the `Type` / `defineTool`
 * helpers re-exported on `pi` so authors don't need external imports.
 */

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  AgentTool,
  ToolExecutionMode,
} from '@mariozechner/pi-agent-core';
import type { ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { Static, TSchema } from '@sinclair/typebox';

export type { AgentToolResult, AgentToolUpdateCallback };

/**
 * Context provided to extension event handlers and command handlers.
 * Phase 1 surface is narrow — UI / session / provider access are Phase 2.
 */
export interface ExtensionContext {
  /** Absolute vault mount path (e.g. `/vault`) or undefined when unmounted. */
  readonly cwd: string | undefined;
  /** True when the agent is not currently streaming. */
  isIdle(): boolean;
  /** Abort the current streaming run, if any. */
  abort(): void;
}

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
 * The object passed to an extension's factory function. Phase 1 surface
 * is intentionally small — `on` (two events), `registerTool`,
 * `registerCommand`, plus the `Type` / `defineTool` helpers that free
 * extension authors from needing external imports inside the Worker.
 */
export interface ExtensionAPI {
  /** Subscribe to `before_agent_start`. Returning a new systemPrompt overrides the current one for this turn. */
  on(
    event: 'before_agent_start',
    handler: ExtensionEventHandler<BeforeAgentStartEvent, BeforeAgentStartEventResult>
  ): void;
  /** Subscribe to `tool_result`. Returning fields overrides content/details/isError before the result is committed. */
  on(
    event: 'tool_result',
    handler: ExtensionEventHandler<ToolResultEvent, ToolResultEventResult>
  ): void;

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
 * `isIdle` / `cwd` current regardless of when the tool was registered.
 */
export type ContextSupplier = () => ExtensionContext;
export type { AgentTool };
