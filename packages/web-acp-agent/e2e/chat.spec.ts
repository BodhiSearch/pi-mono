import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { embedAgent, type EmbeddedAgent } from './helpers/embed-agent';
import { loadTestState, type TestState } from './helpers/test-state';

describe('chat', () => {
  let state: TestState;
  let agent: EmbeddedAgent;

  beforeEach(async () => {
    state = loadTestState();
    agent = await embedAgent();
  });

  afterEach(async () => {
    await agent.dispose();
  });

  it('returns agentInfo + agentCapabilities on initialize', async () => {
    const response = await agent.initialize();

    expect(typeof response.protocolVersion).toBe('number');

    expect(response.agentInfo).toBeDefined();
    expect(response.agentInfo?.name).toBe('@bodhiapp/web-acp-agent');
    expect(response.agentInfo?.version).toBe('0.0.0-e2e');

    const caps = response.agentCapabilities;
    expect(caps).toBeDefined();
    expect(caps?.loadSession).toBe(true);
    expect(caps?.sessionCapabilities?.list).toEqual({});
    expect(caps?.sessionCapabilities?.close).toEqual({});

    expect(caps?.mcpCapabilities?.http).toBe(true);
    expect(caps?.mcpCapabilities?.sse).toBe(false);

    expect(response.authMethods).toBeDefined();
    expect(response.authMethods?.some(m => m.id === 'bodhi-token')).toBe(true);

    expect(state.bodhiServerUrl).toMatch(/^http:\/\/localhost:\d+$/);
    expect(state.accessToken).toBeTruthy();
  });

  async function authedAgent(): Promise<EmbeddedAgent> {
    await agent.initialize();
    await agent.authenticate({
      token: state.accessToken,
      baseUrl: state.bodhiServerUrl,
    });
    return agent;
  }

  it('authenticate returns BodhiApp /info under _meta.bodhi.providerInfo', async () => {
    await agent.initialize();
    const response = await agent.authenticate({
      token: state.accessToken,
      baseUrl: state.bodhiServerUrl,
    });

    const meta = response._meta as
      | { bodhi?: { providerInfo?: Record<string, unknown> } }
      | undefined;
    expect(meta?.bodhi?.providerInfo).toBeDefined();
    const info = meta!.bodhi!.providerInfo!;
    expect(typeof info.version).toBe('string');
    expect(typeof info.status).toBe('string');
    expect(typeof info.url).toBe('string');
  });

  it('newSession returns sessionId, model catalog, and configOptions', async () => {
    await authedAgent();
    const response = await agent.client.newSession({
      mcpServers: [],
      cwd: '/',
    });

    expect(response.sessionId).toMatch(/.+/);

    expect(response.models).toBeTruthy();
    const ids = (response.models?.availableModels ?? []).map(m => m.modelId);
    expect(ids).toContain(state.modelId);

    const configIds = (response.configOptions ?? []).map(c => c.id);
    expect(configIds).toContain('_bodhi/features/bashEnabled');
  });

  it('prompt round-trip streams agent_message_chunk and ends with end_turn', async () => {
    await authedAgent();
    const newSession = await agent.client.newSession({ mcpServers: [], cwd: '/' });
    const sessionId = newSession.sessionId;
    await agent.client.unstable_setSessionModel({ sessionId, modelId: state.modelId });

    const promptResponse = await agent.client.prompt({
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Reply with the single word: pong',
        },
      ],
    });

    expect(promptResponse.stopReason).toBe('end_turn');

    const text = agent.notifications.accumulatedAssistantText(sessionId);
    expect(text.toLowerCase()).toContain('pong');
  });

  it('cancel mid-prompt yields stopReason=cancelled, then session is reusable', async () => {
    await authedAgent();
    const newSession = await agent.client.newSession({ mcpServers: [], cwd: '/' });
    const sessionId = newSession.sessionId;
    await agent.client.unstable_setSessionModel({ sessionId, modelId: state.modelId });

    const promptPromise = agent.client.prompt({
      sessionId,
      prompt: [
        {
          type: 'text',
          text: 'Write a 1000-word essay about asynchronous programming. Be detailed.',
        },
      ],
    });

    await agent.notifications.waitForUpdate(
      sessionId,
      n => (n.update as { sessionUpdate?: string }).sessionUpdate === 'agent_message_chunk',
      30_000
    );
    await agent.client.cancel({ sessionId });

    const promptResponse = await promptPromise;
    expect(promptResponse.stopReason).toBe('cancelled');

    const second = await agent.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with the single word: ok' }],
    });
    expect(second.stopReason).toBe('end_turn');
    const text = agent.notifications.accumulatedAssistantText(sessionId);
    expect(text.toLowerCase()).toContain('ok');
  });
});
