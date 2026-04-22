import { Agent } from '@mariozechner/pi-agent-core';
import type {
  AfterToolCallContext,
  AfterToolCallResult,
  AgentEvent,
  AgentMessage,
  AgentTool,
  BeforeToolCallContext,
  BeforeToolCallResult,
  StreamFn,
} from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { RpcSessionState } from '../rpc/rpc-types';

export interface AgentSessionOptions {
  streamFn?: StreamFn;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
}

/**
 * Thin wrapper around `pi-agent-core`'s `Agent`.
 *
 * Responsibilities:
 * - owns the session Agent instance
 * - exposes the exact surface the RPC server needs (plain-data in/out)
 * - holds non-serializable state (tools, streamFn) that can't cross RPC
 *   via direct setters — the M4 Worker host calls these directly inside
 *   the Worker context where the closures live
 *
 * Auth is NOT owned here. The Worker boots with an `LlmAuthProvider`
 * concrete implementation (see `worker-bodhi/`) and wires it into the
 * session's `streamFn` + compaction summariser. Token rotation lives on
 * the provider.
 */
export class AgentSession {
  private readonly agent: Agent;
  private currentModel: Model<Api> | undefined;

  constructor(options: AgentSessionOptions = {}) {
    this.agent = new Agent({
      streamFn: options.streamFn,
      getApiKey: options.getApiKey,
    });
  }

  // ==========================================================================
  // RPC surface — plain data in/out
  // ==========================================================================

  async prompt(message: string): Promise<void> {
    await this.agent.prompt(message);
  }

  abort(): void {
    this.agent.abort();
  }

  getState(): RpcSessionState {
    return {
      isStreaming: this.agent.state.isStreaming,
      messageCount: this.agent.state.messages.length,
      model: this.currentModel,
      errorMessage: this.agent.state.errorMessage,
    };
  }

  getMessages(): AgentMessage[] {
    return [...this.agent.state.messages];
  }

  getStreamingMessage(): AgentMessage | undefined {
    return this.agent.state.streamingMessage;
  }

  getErrorMessage(): string | undefined {
    return this.agent.state.errorMessage;
  }

  isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  setSystemPrompt(prompt: string): void {
    this.agent.state.systemPrompt = prompt;
  }

  getSystemPrompt(): string {
    return this.agent.state.systemPrompt;
  }

  setModel(model: Model<Api> | undefined): void {
    if (model) {
      this.agent.state.model = model;
      this.currentModel = model;
    }
  }

  /**
   * Returns the Model set via the most recent `setModel` call, or
   * `undefined` if no model has been selected yet. Compaction reads this
   * for its `contextWindow` and for the `completeSimple` call.
   */
  getModel(): Model<Api> | undefined {
    return this.currentModel;
  }

  reset(): void {
    this.agent.reset();
  }

  /**
   * Replace the agent's message buffer without firing lifecycle events.
   * Used by the Worker-side `loadSession` path after reading a persisted
   * JSONL file — we want the UI to see the restored history but we must
   * not re-trigger `message_end` handlers (which would re-persist every
   * restored message and would double-count in extension hooks).
   *
   * If pi-agent-core later adds caches derived from `state.messages` they
   * may need to be invalidated here; for now, direct assignment is enough.
   */
  restoreMessages(messages: AgentMessage[]): void {
    this.agent.state.messages = [...messages];
  }

  // ==========================================================================
  // Host-only surface — non-serializable state, called inside the Worker
  // ==========================================================================

  setTools(tools: AgentTool[]): void {
    this.agent.state.tools = tools;
  }

  setStreamFn(fn: StreamFn): void {
    this.agent.streamFn = fn;
  }

  subscribe(handler: (event: AgentEvent) => void | Promise<void>): () => void {
    return this.agent.subscribe(event => handler(event));
  }

  /**
   * Install (or clear with `undefined`) pi-agent-core's native
   * `afterToolCall` hook. The `WorkerAgentHost` uses this to give the
   * extension runtime a chance to transform tool results before the
   * agent emits `message_end` on the toolResult message. No-op when
   * no extensions are loaded so the happy path carries zero overhead.
   */
  setAfterToolCall(
    hook:
      | ((
          ctx: AfterToolCallContext,
          signal?: AbortSignal
        ) => Promise<AfterToolCallResult | undefined>)
      | undefined
  ): void {
    this.agent.afterToolCall = hook;
  }

  /** Mirror of `setAfterToolCall` for the complementary `beforeToolCall` hook. */
  setBeforeToolCall(
    hook:
      | ((
          ctx: BeforeToolCallContext,
          signal?: AbortSignal
        ) => Promise<BeforeToolCallResult | undefined>)
      | undefined
  ): void {
    this.agent.beforeToolCall = hook;
  }

  /**
   * Install (or clear with `undefined`) pi-agent-core's native
   * `transformContext` hook. Each LLM call runs this transform on the
   * outgoing `AgentMessage[]`; the extension runtime uses it to
   * implement the `on('context')` hook surface. Zero overhead when
   * no extensions subscribe (the closure short-circuits on empty
   * handler set).
   */
  setTransformContext(
    hook: ((messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>) | undefined
  ): void {
    this.agent.transformContext = hook;
  }
}
