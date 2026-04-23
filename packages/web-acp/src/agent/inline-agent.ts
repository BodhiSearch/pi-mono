import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';

const SENTINEL_API_KEY = 'bodhiapp_sentinel_api_key_ignored';

export interface InlineAgentSetModelOptions {
  tools?: AgentTool<never>[];
  systemPrompt?: string;
}

export interface InlineAgent {
  setModel(model: Model<Api>, opts?: InlineAgentSetModelOptions): void;
  subscribe(cb: (event: AgentEvent) => void): () => void;
  getMessages(): AgentMessage[];
  getErrorMessage(): string | undefined;
  prompt(text: string): Promise<void>;
  cancel(): void;
  clearMessages(): void;
  /**
   * Seed the agent's conversation with an existing message history
   * without firing `AgentEvent`s. Used by `session/load` replay so
   * follow-up prompts on a restored session use the persisted context.
   */
  restoreMessages(messages: AgentMessage[]): void;
}

export function createInlineAgent(streamFn: StreamFn): InlineAgent {
  const agent = new Agent({
    streamFn,
    getApiKey: () => SENTINEL_API_KEY,
  });

  return {
    setModel(model, opts) {
      agent.state.model = model;
      agent.state.tools = opts?.tools ?? [];
      agent.state.systemPrompt = opts?.systemPrompt ?? '';
    },
    subscribe(cb) {
      return agent.subscribe(cb);
    },
    getMessages() {
      return [...agent.state.messages];
    },
    getErrorMessage() {
      return agent.state.errorMessage;
    },
    async prompt(text) {
      await agent.prompt(text);
    },
    cancel() {
      agent.abort();
    },
    clearMessages() {
      agent.abort();
      agent.state.messages = [];
    },
    restoreMessages(messages) {
      agent.state.messages = [...messages];
    },
  };
}
