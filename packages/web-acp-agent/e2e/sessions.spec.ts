import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BODHI_SESSIONS_DELETE_METHOD } from '@bodhiapp/web-acp-agent';
import { embedAgent, type EmbeddedAgent } from './helpers/embed-agent';
import { loadTestState, type TestState } from './helpers/test-state';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('sessions', () => {
  let state: TestState;
  let agent: EmbeddedAgent;

  beforeEach(async () => {
    state = loadTestState();
    agent = await embedAgent();
    await agent.initialize();
    await agent.authenticate({
      token: state.accessToken,
      baseUrl: state.bodhiServerUrl,
    });
  });

  afterEach(async () => {
    await agent.dispose();
  });

  it('listSessions returns created sessions newest-first', async () => {
    const a = await agent.client.newSession({ mcpServers: [], cwd: '/' });
    // Sleep > 1ms so the in-memory store's updatedAt sort key is total.
    await sleep(2);
    const b = await agent.client.newSession({ mcpServers: [], cwd: '/' });
    await sleep(2);
    const c = await agent.client.newSession({ mcpServers: [], cwd: '/' });

    const list = await agent.client.listSessions({});

    expect(Array.isArray(list.sessions)).toBe(true);
    const ids = list.sessions.map(s => s.sessionId);
    expect(ids).toContain(a.sessionId);
    expect(ids).toContain(b.sessionId);
    expect(ids).toContain(c.sessionId);

    const ia = ids.indexOf(a.sessionId);
    const ib = ids.indexOf(b.sessionId);
    const ic = ids.indexOf(c.sessionId);
    expect(ic).toBeLessThan(ib);
    expect(ib).toBeLessThan(ia);

    expect(list.nextCursor == null).toBe(true);
  });

  it('loadSession replays the transcript via _meta.bodhi.messages', async () => {
    const created = await agent.client.newSession({ mcpServers: [], cwd: '/' });
    const sessionId = created.sessionId;
    await agent.client.unstable_setSessionModel({ sessionId, modelId: state.modelId });
    await agent.client.prompt({
      sessionId,
      prompt: [{ type: 'text', text: 'Reply with the single word: hello' }],
    });

    agent.notifications.reset();

    const loaded = await agent.client.loadSession({
      sessionId,
      mcpServers: [],
      cwd: '/',
    });

    expect(loaded.models).toBeTruthy();
    const ids = (loaded.models?.availableModels ?? []).map(m => m.modelId);
    expect(ids).toContain(state.modelId);

    const meta = loaded._meta as
      | { bodhi?: { messages?: unknown[]; mcpToggles?: unknown; title?: string | null } }
      | undefined;
    expect(meta?.bodhi).toBeDefined();
    expect(Array.isArray(meta?.bodhi?.messages)).toBe(true);
    expect((meta?.bodhi?.messages ?? []).length).toBeGreaterThan(0);
    expect(typeof meta?.bodhi?.mcpToggles).toBe('object');
    expect(typeof meta?.bodhi?.title).toBe('string');
  });

  it('closeSession evicts the in-memory runtime entry but keeps the store row', async () => {
    const created = await agent.client.newSession({ mcpServers: [], cwd: '/' });
    const sessionId = created.sessionId;

    await agent.client.closeSession({ sessionId });

    const list = await agent.client.listSessions({});
    const ids = list.sessions.map(s => s.sessionId);
    expect(ids).toContain(sessionId);

    await expect(
      agent.client.prompt({
        sessionId,
        prompt: [{ type: 'text', text: 'hello' }],
      })
    ).rejects.toBeDefined();
  });

  it('_bodhi/sessions/delete drops the row from listSessions', async () => {
    const created = await agent.client.newSession({ mcpServers: [], cwd: '/' });
    const sessionId = created.sessionId;

    const before = await agent.client.listSessions({});
    expect(before.sessions.map(s => s.sessionId)).toContain(sessionId);

    const response = (await agent.client.extMethod(BODHI_SESSIONS_DELETE_METHOD, {
      sessionId,
    })) as { deleted: boolean };
    expect(response.deleted).toBe(true);

    const after = await agent.client.listSessions({});
    expect(after.sessions.map(s => s.sessionId)).not.toContain(sessionId);
  });

  it('listSessions cursor paginates across more than one page', async () => {
    // Default per_page is 10. Create 12 → expect two pages.
    const created: string[] = [];
    for (let i = 0; i < 12; i++) {
      const r = await agent.client.newSession({ mcpServers: [], cwd: '/' });
      created.push(r.sessionId);
      await sleep(2);
    }

    const seen = new Set<string>();
    const page1 = await agent.client.listSessions({});
    for (const s of page1.sessions) seen.add(s.sessionId);
    expect(page1.sessions.length).toBe(10);
    expect(typeof page1.nextCursor).toBe('string');

    const page2 = await agent.client.listSessions({ cursor: page1.nextCursor ?? null });
    for (const s of page2.sessions) seen.add(s.sessionId);
    expect(page2.sessions.length).toBe(2);
    expect(page2.nextCursor == null).toBe(true);

    for (const id of created) {
      expect(seen.has(id)).toBe(true);
    }
  });
});
