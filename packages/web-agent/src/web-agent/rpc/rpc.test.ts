import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import { RpcClient } from './rpc-client';
import { type AgentSessionHost, RpcServer } from './rpc-server';
import type { RpcSessionState } from './rpc-types';
import { createInProcessTransportPair } from './transports/in-process';

function createFakeSession(): AgentSessionHost {
  const listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  const state: {
    messages: AgentMessage[];
    isStreaming: boolean;
    streamingMessage: AgentMessage | undefined;
    errorMessage: string | undefined;
    model: unknown;
    systemPrompt: string;
  } = {
    messages: [],
    isStreaming: false,
    streamingMessage: undefined,
    errorMessage: undefined,
    model: undefined,
    systemPrompt: '',
  };

  async function emit(event: AgentEvent): Promise<void> {
    for (const listener of listeners) await listener(event);
  }

  return {
    async prompt(message: string): Promise<void> {
      state.isStreaming = true;
      await emit({ type: 'agent_start' });

      const assistant = {
        role: 'assistant',
        content: [{ type: 'text', text: `echo:${message}` }],
        api: 'openai-completions',
        provider: 'fake',
        model: 'fake-model',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: 'stop',
        timestamp: Date.now(),
      } as unknown as AgentMessage;

      state.messages.push(assistant);
      await emit({ type: 'message_end', message: assistant });
      await emit({ type: 'turn_end', message: assistant, toolResults: [] });

      state.isStreaming = false;
      await emit({ type: 'agent_end', messages: [assistant] });
    },
    abort() {
      state.isStreaming = false;
    },
    setModel(model) {
      state.model = model;
    },
    setSystemPrompt(prompt) {
      state.systemPrompt = prompt;
    },
    reset() {
      state.messages = [];
      state.streamingMessage = undefined;
      state.errorMessage = undefined;
    },
    getState(): RpcSessionState {
      return {
        isStreaming: state.isStreaming,
        messageCount: state.messages.length,
        hasModel: state.model !== undefined,
        errorMessage: state.errorMessage,
      };
    },
    getMessages: () => [...state.messages],
    isStreaming: () => state.isStreaming,
    getStreamingMessage: () => state.streamingMessage,
    getErrorMessage: () => state.errorMessage,
    subscribe(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },
  };
}

function bootPair(): { session: AgentSessionHost; client: RpcClient } {
  const session = createFakeSession();
  const { client: clientT, server: serverT } = createInProcessTransportPair();
  new RpcServer(serverT, session);
  const client = new RpcClient(clientT);
  return { session, client };
}

describe('RPC round-trip', () => {
  test('prompt resolves after turn completes and events flow to client', async () => {
    const { client } = bootPair();

    const eventTypes: AgentEvent['type'][] = [];
    client.subscribe(envelope => {
      eventTypes.push(envelope.event.type);
    });

    await client.prompt('hi');

    expect(eventTypes).toEqual(['agent_start', 'message_end', 'turn_end', 'agent_end']);

    const messages = await client.getMessages();
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe('assistant');
  });

  test('get_state returns a serialized snapshot', async () => {
    const { client } = bootPair();

    const initial = await client.getState();
    expect(initial).toEqual({
      isStreaming: false,
      messageCount: 0,
      hasModel: false,
    });

    await client.setModel({
      id: 'test',
      api: 'openai-completions',
      provider: 'fake',
      baseUrl: '',
    } as never);

    const afterModel = await client.getState();
    expect(afterModel.hasModel).toBe(true);
  });

  test('abort and reset succeed without throwing', async () => {
    const { client } = bootPair();
    await expect(client.abort()).resolves.toBeUndefined();
    await expect(client.reset()).resolves.toBeUndefined();
  });

  test('event envelope carries messages snapshot alongside event', async () => {
    const { client } = bootPair();

    const snapshots: number[] = [];
    client.subscribe(envelope => {
      if (envelope.event.type === 'message_end') {
        snapshots.push(envelope.messages.length);
      }
    });

    await client.prompt('one');
    await client.prompt('two');

    expect(snapshots).toEqual([1, 2]);
  });
});
