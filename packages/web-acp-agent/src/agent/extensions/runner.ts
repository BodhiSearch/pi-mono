/**
 * Holds active extension instances + their subscriptions and runs
 * the lifecycle dispatch in extension-load order. Handler errors
 * are caught and logged so one buggy extension cannot poison its
 * peers or the agent loop.
 */

import type { ExtensionSubscription } from './api';
import type {
  AfterProviderResponseEvent,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeProviderRequestEvent,
  ExtensionInfo,
  InputEvent,
  InputEventResult,
  SessionStartEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
  ToolResultEventResult,
} from './types';

export interface ActiveExtension {
  info: ExtensionInfo;
  subscriptions: ExtensionSubscription[];
  dispose(): Promise<void>;
}

export class ExtensionRunner {
  readonly #active = new Map<string, ActiveExtension>();

  add(extension: ActiveExtension): void {
    this.#active.set(extension.info.name, extension);
  }

  list(): ExtensionInfo[] {
    return [...this.#active.values()].map(a => a.info);
  }

  has(name: string): boolean {
    return this.#active.has(name);
  }

  async remove(name: string): Promise<void> {
    const active = this.#active.get(name);
    if (!active) return;
    this.#active.delete(name);
    try {
      await active.dispose();
    } catch (err) {
      console.error(`[extensions] dispose threw for '${name}':`, err);
    }
  }

  async disposeAll(): Promise<void> {
    const all = [...this.#active.values()];
    this.#active.clear();
    for (const active of all) {
      try {
        await active.dispose();
      } catch (err) {
        console.error(`[extensions] dispose threw for '${active.info.name}':`, err);
      }
    }
  }

  async dispatchSessionStart(event: SessionStartEvent): Promise<void> {
    for (const ext of this.#active.values()) {
      for (const sub of ext.subscriptions) {
        if (sub.event !== 'session_start' || sub.disposed) continue;
        try {
          await sub.handler(event);
        } catch (err) {
          console.error(`[extensions] session_start handler in '${ext.info.name}' threw:`, err);
        }
      }
    }
  }

  /**
   * Each handler may return `{ action: 'transform', text }` to
   * replace the value the next handler sees, or
   * `{ action: 'handled' }` to short-circuit dispatch (no LLM
   * call). Returns the final outcome, or `undefined` when nothing
   * matched.
   */
  async dispatchInput(event: InputEvent): Promise<InputEventResult | undefined> {
    let currentText = event.text;
    let transformed = false;
    for (const ext of this.#active.values()) {
      for (const sub of ext.subscriptions) {
        if (sub.event !== 'input' || sub.disposed) continue;
        try {
          const chained: InputEvent = { ...event, text: currentText };
          const result = (await sub.handler(chained)) as InputEventResult | undefined | void;
          if (!result || (result as InputEventResult).action === 'continue') continue;
          if ((result as InputEventResult).action === 'handled') {
            return { action: 'handled' };
          }
          if ((result as InputEventResult).action === 'transform') {
            currentText = (result as { text: string }).text;
            transformed = true;
          }
        } catch (err) {
          console.error(`[extensions] input handler in '${ext.info.name}' threw:`, err);
        }
      }
    }
    return transformed ? { action: 'transform', text: currentText } : undefined;
  }

  /**
   * Walks every `tool_call` subscription. Handlers may mutate the
   * shared `event.input` object in place to rewrite arguments, or
   * return `{ block: true, reason }` to abort the call. The first
   * `block` wins and stops the chain.
   */
  async dispatchToolCall(event: ToolCallEvent): Promise<ToolCallEventResult | undefined> {
    for (const ext of this.#active.values()) {
      for (const sub of ext.subscriptions) {
        if (sub.event !== 'tool_call' || sub.disposed) continue;
        try {
          const result = (await sub.handler(event)) as ToolCallEventResult | undefined | void;
          if (result?.block) {
            return { block: true, reason: result.reason };
          }
        } catch (err) {
          console.error(`[extensions] tool_call handler in '${ext.info.name}' threw:`, err);
        }
      }
    }
    return undefined;
  }

  /**
   * Walks every `tool_result` subscription. Handlers may return a
   * partial patch (`content?`, `details?`, `isError?`); patches
   * accumulate field-by-field across handlers (each handler sees
   * the prior accumulated values) and the final result replaces
   * the original tool result.
   */
  async dispatchToolResult(event: ToolResultEvent): Promise<ToolResultEventResult | undefined> {
    let current: ToolResultEvent = event;
    let patched = false;
    for (const ext of this.#active.values()) {
      for (const sub of ext.subscriptions) {
        if (sub.event !== 'tool_result' || sub.disposed) continue;
        try {
          const result = (await sub.handler(current)) as ToolResultEventResult | undefined | void;
          if (!result) continue;
          let next = current;
          if (result.content !== undefined) {
            next = { ...next, content: result.content };
            patched = true;
          }
          if (result.details !== undefined) {
            next = { ...next, details: result.details };
            patched = true;
          }
          if (result.isError !== undefined) {
            next = { ...next, isError: result.isError };
            patched = true;
          }
          current = next;
        } catch (err) {
          console.error(`[extensions] tool_result handler in '${ext.info.name}' threw:`, err);
        }
      }
    }
    if (!patched) return undefined;
    return {
      content: current.content,
      details: current.details,
      isError: current.isError,
    };
  }

  /**
   * Each handler may return `{ systemPrompt }` to replace the value
   * the next handler sees. Returns the accumulated patch, or
   * `undefined` when no handler modified the prompt.
   */
  async dispatchBeforeAgentStart(
    event: BeforeAgentStartEvent
  ): Promise<BeforeAgentStartEventResult | undefined> {
    let currentPrompt = event.systemPrompt;
    let modified = false;
    for (const ext of this.#active.values()) {
      for (const sub of ext.subscriptions) {
        if (sub.event !== 'before_agent_start' || sub.disposed) continue;
        try {
          const chained: BeforeAgentStartEvent = { ...event, systemPrompt: currentPrompt };
          const result = (await sub.handler(chained)) as
            | BeforeAgentStartEventResult
            | undefined
            | void;
          if (result && typeof (result as BeforeAgentStartEventResult).systemPrompt === 'string') {
            currentPrompt = (result as BeforeAgentStartEventResult).systemPrompt as string;
            modified = true;
          }
        } catch (err) {
          console.error(
            `[extensions] before_agent_start handler in '${ext.info.name}' threw:`,
            err
          );
        }
      }
    }
    return modified ? { systemPrompt: currentPrompt } : undefined;
  }

  /**
   * Walks every `before_provider_request` subscription in load
   * order. Each handler returns the (possibly mutated) replacement
   * payload; returning `undefined` keeps the prior value. Returns
   * the final payload (which equals `event.payload` when no
   * handler modified it).
   *
   * Subscriptions whose owning extension has been disposed (e.g.
   * mid-stream cancel + reload) are skipped silently — `sub.disposed`
   * gates the loop. This is intentional: a cancelled or torn-down
   * extension must not drive provider hooks. Do not "fix" this by
   * re-running disposed subscriptions; cancellation is a hard barrier.
   */
  async dispatchBeforeProviderRequest(event: BeforeProviderRequestEvent): Promise<unknown> {
    let currentPayload: unknown = event.payload;
    for (const ext of this.#active.values()) {
      for (const sub of ext.subscriptions) {
        if (sub.event !== 'before_provider_request' || sub.disposed) continue;
        try {
          const chained: BeforeProviderRequestEvent = { ...event, payload: currentPayload };
          const result = await sub.handler(chained);
          if (result !== undefined) {
            currentPayload = result;
          }
        } catch (err) {
          console.error(
            `[extensions] before_provider_request handler in '${ext.info.name}' threw:`,
            err
          );
        }
      }
    }
    return currentPayload;
  }

  /**
   * Walks every `after_provider_response` subscription. Observation-only;
   * thrown errors are caught and logged so a buggy listener cannot
   * poison the LLM round-trip.
   *
   * Disposed subscriptions are skipped silently — same rationale as
   * `dispatchBeforeProviderRequest`.
   */
  async dispatchAfterProviderResponse(event: AfterProviderResponseEvent): Promise<void> {
    for (const ext of this.#active.values()) {
      for (const sub of ext.subscriptions) {
        if (sub.event !== 'after_provider_response' || sub.disposed) continue;
        try {
          await sub.handler(event);
        } catch (err) {
          console.error(
            `[extensions] after_provider_response handler in '${ext.info.name}' threw:`,
            err
          );
        }
      }
    }
  }
}
