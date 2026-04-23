import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage, StreamFn } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';

const SENTINEL_API_KEY = 'bodhiapp_sentinel_api_key_ignored';

export interface InlineAgent {
  setModel(model: Model<Api>): void;
  subscribe(cb: (event: AgentEvent) => void): () => void;
  getMessages(): AgentMessage[];
  getErrorMessage(): string | undefined;
  prompt(text: string): Promise<void>;
  cancel(): void;
  clearMessages(): void;
}

export function createInlineAgent(streamFn: StreamFn): InlineAgent {
  const agent = new Agent({
    streamFn,
    getApiKey: () => SENTINEL_API_KEY,
  });

  return {
    setModel(model) {
      agent.state.model = model;
      agent.state.tools = [];
      agent.state.systemPrompt = '';
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
  };
}
