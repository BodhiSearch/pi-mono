import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
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
 *   via direct setters — in Phase 1 the "host" code (React hook) calls
 *   these directly because client and server share a JS context
 *
 * Phase 4 will move this into a Web Worker; tools will become proxies
 * that call back to the main thread over the same transport.
 */
export class AgentSession {
  private readonly agent: Agent;

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
      hasModel: this.agent.state.model.id !== 'unknown',
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

  setModel(model: Model<Api> | undefined): void {
    if (model) this.agent.state.model = model;
  }

  reset(): void {
    this.agent.reset();
  }

  // ==========================================================================
  // Host-only surface — non-serializable state, called directly in Phase 1
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
}
