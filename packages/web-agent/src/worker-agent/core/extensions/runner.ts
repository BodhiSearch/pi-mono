/**
 * Worker-side extension runner. Owns the loaded `Extension` records
 * and dispatches the Phase 1 hooks (`before_agent_start`,
 * `tool_result`) with per-extension error isolation and ordered
 * chaining. The enable/disable map lives on the worker-host
 * (`ExtensionHostController`); the runner just reflects the
 * currently-loaded set.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ContextEventResult,
  Extension,
  ExtensionContext,
  ExtensionError,
  ExtensionEventHandler,
  MessageEndEvent,
  RegisteredCommand,
  RegisteredTool,
  SessionLoadedEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
  TurnStartEvent,
} from './types';

export type ExtensionErrorListener = (err: ExtensionError) => void;

/**
 * `emitToolResult` returns the effective overrides merged across all
 * handlers. The worker-host maps it back to the agent's
 * `AfterToolCallResult` shape.
 */
export interface ToolResultOverride {
  content?: ToolResultEvent['content'];
  details?: unknown;
  isError?: boolean;
}

/**
 * Aggregate outcome of a `tool_call` dispatch. `blocked` is `true` when
 * any handler returned `{ block: true }`; the reason is surfaced to the
 * LLM as the tool result. The worker-host uses this to translate into
 * `pi-agent-core`'s `{ action: 'block', content }` reply.
 */
export interface ToolCallOutcome {
  blocked: boolean;
  reason?: string;
}

export class ExtensionRunner {
  private extensions: Extension[] = [];
  private readonly errorListeners = new Set<ExtensionErrorListener>();

  setExtensions(extensions: Extension[]): void {
    this.extensions = extensions;
  }

  /** Drop all loaded extensions (e.g. on vault unmount). */
  clear(): void {
    this.extensions = [];
  }

  getExtensions(): Extension[] {
    return this.extensions;
  }

  hasExtensions(): boolean {
    return this.extensions.length > 0;
  }

  hasHandlers(eventType: string): boolean {
    return this.extensions.some(e => (e.handlers.get(eventType)?.length ?? 0) > 0);
  }

  // --------------------------------------------------------------------------
  // Error surface
  // --------------------------------------------------------------------------

  onError(listener: ExtensionErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private reportError(err: ExtensionError): void {
    for (const listener of this.errorListeners) {
      try {
        listener(err);
      } catch (inner) {
        // Error listeners are diagnostic; swallow rather than cascade.
        console.error('[ExtensionRunner] error listener threw:', inner);
      }
    }
  }

  private toExtensionError(extensionPath: string, event: string, err: unknown): ExtensionError {
    if (err instanceof Error) {
      return {
        extensionPath,
        event,
        error: err.message,
        stack: err.stack,
      };
    }
    return {
      extensionPath,
      event,
      error: typeof err === 'string' ? err : 'unknown error',
    };
  }

  // --------------------------------------------------------------------------
  // Tool + command aggregation
  // --------------------------------------------------------------------------

  getAllRegisteredTools(): RegisteredTool[] {
    const tools: RegisteredTool[] = [];
    const seen = new Set<string>();
    for (const ext of this.extensions) {
      for (const [name, tool] of ext.tools) {
        if (seen.has(name)) continue;
        seen.add(name);
        tools.push(tool);
      }
    }
    return tools;
  }

  getRegisteredCommands(): RegisteredCommand[] {
    const commands: RegisteredCommand[] = [];
    const seen = new Set<string>();
    for (const ext of this.extensions) {
      for (const [name, cmd] of ext.commands) {
        if (seen.has(name)) continue;
        seen.add(name);
        commands.push(cmd);
      }
    }
    return commands;
  }

  findCommand(name: string): RegisteredCommand | null {
    for (const ext of this.extensions) {
      const cmd = ext.commands.get(name);
      if (cmd) return cmd;
    }
    return null;
  }

  // --------------------------------------------------------------------------
  // Dispatchers
  // --------------------------------------------------------------------------

  /**
   * Chain the `before_agent_start` handlers. Returns the (possibly)
   * replaced systemPrompt, or `undefined` when no handler asked to
   * override. The caller (worker-host) swaps this into the session
   * only when a change is produced.
   */
  async emitBeforeAgentStart(
    event: BeforeAgentStartEvent,
    ctx: ExtensionContext
  ): Promise<string | undefined> {
    if (!this.hasHandlers('before_agent_start')) return undefined;
    let current: BeforeAgentStartEvent = { ...event };
    let override: string | undefined;
    for (const ext of this.extensions) {
      const bucket = ext.handlers.get('before_agent_start') ?? [];
      for (const raw of bucket) {
        const handler = raw as ExtensionEventHandler<
          BeforeAgentStartEvent,
          BeforeAgentStartEventResult
        >;
        try {
          const res = await handler(current, ctx);
          const next =
            res && typeof res === 'object' && 'systemPrompt' in res
              ? (res as BeforeAgentStartEventResult).systemPrompt
              : undefined;
          if (typeof next === 'string' && next !== current.systemPrompt) {
            override = next;
            current = { ...current, systemPrompt: next };
          }
        } catch (err) {
          this.reportError(this.toExtensionError(ext.path, 'before_agent_start', err));
        }
      }
    }
    return override;
  }

  /**
   * Chain the `tool_result` handlers. Returns the merged override (or
   * `undefined` when no handler supplied overrides). Each handler sees
   * the accumulated event — supplying `{ content }` replaces the entire
   * array downstream handlers see, matching the "no deep merge" rule.
   */
  async emitToolResult(
    event: ToolResultEvent,
    ctx: ExtensionContext
  ): Promise<ToolResultOverride | undefined> {
    if (!this.hasHandlers('tool_result')) return undefined;
    let current: ToolResultEvent = { ...event };
    let override: ToolResultOverride | undefined;
    for (const ext of this.extensions) {
      const bucket = ext.handlers.get('tool_result') ?? [];
      for (const raw of bucket) {
        const handler = raw as ExtensionEventHandler<ToolResultEvent, ToolResultEventResult>;
        try {
          const res = await handler(current, ctx);
          if (res && typeof res === 'object') {
            const r = res as ToolResultEventResult;
            override = override ?? {};
            if (r.content !== undefined) {
              override.content = r.content;
              current = { ...current, content: r.content };
            }
            if (r.details !== undefined) {
              override.details = r.details;
              current = { ...current, details: r.details };
            }
            if (r.isError !== undefined) {
              override.isError = r.isError;
              current = { ...current, isError: r.isError };
            }
          }
        } catch (err) {
          this.reportError(this.toExtensionError(ext.path, 'tool_result', err));
        }
      }
    }
    return override;
  }

  // --------------------------------------------------------------------------
  // Phase 2a: context / tool_call / lifecycle dispatch
  // --------------------------------------------------------------------------

  /**
   * Chain the `context` handlers before an LLM call. Each handler sees
   * the previous handler's override (if any); returning `{ messages }`
   * replaces the array wholesale. `undefined` return means no override.
   */
  async emitContext(
    messages: AgentMessage[],
    ctx: ExtensionContext
  ): Promise<AgentMessage[] | undefined> {
    if (!this.hasHandlers('context')) return undefined;
    let current = messages;
    let overridden = false;
    for (const ext of this.extensions) {
      const bucket = ext.handlers.get('context') ?? [];
      for (const raw of bucket) {
        const handler = raw as ExtensionEventHandler<ContextEvent, ContextEventResult>;
        try {
          const res = await handler({ type: 'context', messages: current }, ctx);
          if (
            res &&
            typeof res === 'object' &&
            Array.isArray((res as ContextEventResult).messages)
          ) {
            current = (res as ContextEventResult).messages!;
            overridden = true;
          }
        } catch (err) {
          this.reportError(this.toExtensionError(ext.path, 'context', err));
        }
      }
    }
    return overridden ? current : undefined;
  }

  /**
   * Dispatch the `tool_call` handlers. Handlers mutate `event.input` in
   * place; the first `{ block: true }` short-circuits subsequent
   * handlers and captures the reason. The caller observes the mutated
   * `event.input` on the returned outcome semantics — the tool executor
   * will see the same object reference.
   */
  async emitToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallOutcome> {
    if (!this.hasHandlers('tool_call')) return { blocked: false };
    for (const ext of this.extensions) {
      const bucket = ext.handlers.get('tool_call') ?? [];
      for (const raw of bucket) {
        const handler = raw as ExtensionEventHandler<ToolCallEvent, ToolCallEventResult>;
        try {
          const res = await handler(event, ctx);
          if (res && typeof res === 'object' && (res as ToolCallEventResult).block === true) {
            const reason = (res as ToolCallEventResult).reason ?? 'blocked by extension';
            return { blocked: true, reason };
          }
        } catch (err) {
          this.reportError(this.toExtensionError(ext.path, 'tool_call', err));
        }
      }
    }
    return { blocked: false };
  }

  /** Observer-only fan-out for `turn_start`. Errors isolated, return values ignored. */
  async emitTurnStart(ctx: ExtensionContext): Promise<void> {
    if (!this.hasHandlers('turn_start')) return;
    const event: TurnStartEvent = { type: 'turn_start' };
    await this.emitObserverEvent('turn_start', event, ctx);
  }

  /** Observer-only fan-out for `message_end`. Errors isolated, return values ignored. */
  async emitMessageEnd(message: AgentMessage, ctx: ExtensionContext): Promise<void> {
    if (!this.hasHandlers('message_end')) return;
    const event: MessageEndEvent = { type: 'message_end', message };
    await this.emitObserverEvent('message_end', event, ctx);
  }

  /** Observer-only fan-out for `session_loaded`. Errors isolated, return values ignored. */
  async emitSessionLoaded(event: SessionLoadedEvent, ctx: ExtensionContext): Promise<void> {
    if (!this.hasHandlers('session_loaded')) return;
    await this.emitObserverEvent('session_loaded', event, ctx);
  }

  /**
   * Shared observer fan-out: invoke every registered handler for the
   * event, swallow per-handler throws, and wait for all to settle so a
   * slow subscriber can't starve the rest of the host's microtasks.
   */
  private async emitObserverEvent<E extends { type: string }>(
    eventType: string,
    event: E,
    ctx: ExtensionContext
  ): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const ext of this.extensions) {
      const bucket = ext.handlers.get(eventType) ?? [];
      for (const raw of bucket) {
        const handler = raw as ExtensionEventHandler<E, void>;
        pending.push(
          (async () => {
            try {
              await handler(event, ctx);
            } catch (err) {
              this.reportError(this.toExtensionError(ext.path, eventType, err));
            }
          })()
        );
      }
    }
    await Promise.all(pending);
  }
}
