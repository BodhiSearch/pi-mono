/**
 * Worker-side extension runner. Owns the loaded `Extension` records
 * and dispatches the Phase 1 hooks (`before_agent_start`,
 * `tool_result`) with per-extension error isolation and ordered
 * chaining. The enable/disable map lives on the worker-host
 * (`ExtensionHostController`); the runner just reflects the
 * currently-loaded set.
 */

import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  Extension,
  ExtensionContext,
  ExtensionError,
  ExtensionEventHandler,
  RegisteredCommand,
  RegisteredTool,
  ToolResultEvent,
  ToolResultEventResult,
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
}
