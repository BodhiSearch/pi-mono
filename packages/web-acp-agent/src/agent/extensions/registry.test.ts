import { describe, expect, it } from 'vitest';
import type { ExtensionsFs } from './extensions-fs';
import { ExtensionRegistry } from './registry';

function fakeFs(tree: Record<string, string>): ExtensionsFs {
  const dirs = new Set<string>();
  for (const path of Object.keys(tree)) {
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join('/') || '/');
    }
  }
  return {
    async readdir(absolutePath) {
      const prefix = absolutePath.endsWith('/') ? absolutePath : `${absolutePath}/`;
      const childNames = new Set<string>();
      const fileChildren = new Set<string>();
      const dirChildren = new Set<string>();
      for (const path of Object.keys(tree)) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const [name] = rest.split('/');
        if (!name) continue;
        childNames.add(name);
        if (rest === name) fileChildren.add(name);
        else dirChildren.add(name);
      }
      for (const dir of dirs) {
        if (!dir.startsWith(prefix)) continue;
        const rest = dir.slice(prefix.length);
        const [name] = rest.split('/');
        if (!name) continue;
        childNames.add(name);
        if (rest === name) dirChildren.add(name);
      }
      if (childNames.size === 0 && !dirs.has(absolutePath.replace(/\/$/, ''))) {
        return [];
      }
      return [...childNames].map(name => ({
        name,
        isFile: fileChildren.has(name),
        isDirectory: dirChildren.has(name),
      }));
    },
    async readFile(absolutePath) {
      const content = tree[absolutePath];
      if (content === undefined) {
        const err = new Error(`ENOENT: ${absolutePath}`) as Error & { code?: string };
        err.code = 'ENOENT';
        throw err;
      }
      return content;
    },
  };
}

describe('ExtensionRegistry.loadAll', () => {
  it('loads a single hello extension and surfaces it via list()', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/hello/index.js': `
        export default function (pi) {
          pi.on('session_start', () => {});
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('hello');
    expect(list[0]?.mountName).toBe('wiki');
    expect(list[0]?.sourcePath).toBe('/mnt/wiki/.pi/extensions/hello/index.js');
    expect(list[0]?.capabilities.events).toEqual(['session_start']);
    expect(list[0]?.capabilities.tools).toEqual([]);
  });

  it('first-wins on cross-volume name collision', async () => {
    const fs = fakeFs({
      '/mnt/a/.pi/extensions/dup/index.js': `export default function (pi) {}`,
      '/mnt/b/.pi/extensions/dup/index.js': `export default function (pi) {}`,
    });
    const registry = new ExtensionRegistry();
    const warnings: string[] = [];
    await registry.loadAll({
      mounts: [snap('a'), snap('b')],
      fs,
      warn: msg => warnings.push(msg),
    });

    const list = registry.list();
    expect(list).toHaveLength(1);
    expect(list[0]?.mountName).toBe('a');
    expect(warnings.some(w => w.includes("duplicate 'dup'"))).toBe(true);
  });

  it('skips an extension whose index.js has no default-exported function', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/broken/index.js': `export const value = 42;`,
    });
    const registry = new ExtensionRegistry();
    const warnings: string[] = [];
    await registry.loadAll({
      mounts: [snap('wiki')],
      fs,
      warn: msg => warnings.push(msg),
    });

    expect(registry.list()).toHaveLength(0);
    expect(warnings.some(w => w.includes('no default-exported factory function'))).toBe(true);
  });

  it('records each unique event registration only once in capabilities.events', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/multi/index.js': `
        export default function (pi) {
          pi.on('session_start', () => {});
          pi.on('session_start', () => {});
          pi.on('input', () => {});
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });

    const list = registry.list();
    expect(list[0]?.capabilities.events).toEqual(['session_start', 'input']);
  });
});

function snap(mountName: string): { mountName: string; tags: readonly string[] } {
  return { mountName, tags: [] };
}

describe('ExtensionRegistry dispatch', () => {
  it('dispatchSessionStart fans out to every session_start subscriber', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/a/index.js': `
        export default function (pi) {
          globalThis.__a_seen = [];
          pi.on('session_start', (event) => {
            globalThis.__a_seen.push(event.sessionId);
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/b/index.js': `
        export default function (pi) {
          globalThis.__b_seen = [];
          pi.on('session_start', (event) => {
            globalThis.__b_seen.push(event.sessionId);
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    await registry.dispatchSessionStart({
      type: 'session_start',
      sessionId: 'bodhi-session-x',
    });

    const g = globalThis as unknown as { __a_seen: string[]; __b_seen: string[] };
    expect(g.__a_seen).toEqual(['bodhi-session-x']);
    expect(g.__b_seen).toEqual(['bodhi-session-x']);
  });

  it('dispatchSessionStart isolates a thrown handler from peers', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/bad/index.js': `
        export default function (pi) {
          pi.on('session_start', () => { throw new Error('boom'); });
        }
      `,
      '/mnt/wiki/.pi/extensions/good/index.js': `
        export default function (pi) {
          globalThis.__good_seen = 0;
          pi.on('session_start', () => { globalThis.__good_seen += 1; });
        }
      `,
    });
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const registry = new ExtensionRegistry();
      await registry.loadAll({ mounts: [snap('wiki')], fs });
      await registry.dispatchSessionStart({
        type: 'session_start',
        sessionId: 's',
      });
    } finally {
      console.error = originalError;
    }
    const g = globalThis as unknown as { __good_seen: number };
    expect(g.__good_seen).toBe(1);
    expect(errors.some(e => JSON.stringify(e).includes('session_start'))).toBe(true);
  });

  it('dispatchBeforeAgentStart chains systemPrompt patches in load order', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/first/index.js': `
        export default function (pi) {
          pi.on('before_agent_start', (event) => {
            return { systemPrompt: event.systemPrompt + '\\nFIRST' };
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/second/index.js': `
        export default function (pi) {
          pi.on('before_agent_start', (event) => {
            return { systemPrompt: event.systemPrompt + '\\nSECOND' };
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const patch = await registry.dispatchBeforeAgentStart({
      type: 'before_agent_start',
      sessionId: 's',
      prompt: 'hello',
      systemPrompt: 'BASE',
    });
    expect(patch?.systemPrompt).toBe('BASE\nFIRST\nSECOND');
  });

  it('dispatchInput chains transforms across handlers in load order', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/upper/index.js': `
        export default function (pi) {
          pi.on('input', (event) => {
            return { action: 'transform', text: event.text.toUpperCase() };
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/wrap/index.js': `
        export default function (pi) {
          pi.on('input', (event) => {
            return { action: 'transform', text: '<' + event.text + '>' };
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const result = await registry.dispatchInput({
      type: 'input',
      sessionId: 's',
      text: 'hello',
      source: 'user',
    });
    expect(result?.action).toBe('transform');
    expect(result?.action === 'transform' && result.text).toBe('<HELLO>');
  });

  it('dispatchInput returns handled and stops chain on first handled action', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/halt/index.js': `
        export default function (pi) {
          pi.on('input', () => ({ action: 'handled' }));
        }
      `,
      '/mnt/wiki/.pi/extensions/never/index.js': `
        export default function (pi) {
          globalThis.__never_called = false;
          pi.on('input', () => {
            globalThis.__never_called = true;
            return { action: 'transform', text: 'should not run' };
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const result = await registry.dispatchInput({
      type: 'input',
      sessionId: 's',
      text: 'hello',
      source: 'user',
    });
    expect(result?.action).toBe('handled');
    const g = globalThis as unknown as { __never_called: boolean };
    expect(g.__never_called).toBe(false);
  });

  it('dispatchInput returns undefined when every handler returns continue/undefined', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/passthru/index.js': `
        export default function (pi) {
          pi.on('input', () => ({ action: 'continue' }));
          pi.on('input', () => undefined);
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const result = await registry.dispatchInput({
      type: 'input',
      sessionId: 's',
      text: 'hello',
      source: 'user',
    });
    expect(result).toBeUndefined();
  });

  it('registerTool exposes a tool through listTools and the capability list', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/greet/index.js': `
        export default function (pi) {
          const Type = pi.types;
          pi.registerTool({
            name: 'greet',
            label: 'Greet',
            description: 'Greets a name',
            parameters: Type.Object({ name: Type.String() }),
            async execute(_id, params) {
              return { content: [{ type: 'text', text: 'hi ' + params.name }], details: {} };
            },
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });

    const tools = registry.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.name).toBe('greet');

    const list = registry.list();
    expect(list[0]?.capabilities.tools).toEqual(['greet']);
  });

  it('registerTool replaces a prior owner under last-write-wins and warns', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/aaa/index.js': `
        export default function (pi) {
          pi.registerTool({
            name: 'shared',
            label: 'A',
            description: 'a',
            parameters: pi.types.Object({}),
            async execute() { return { content: [{ type: 'text', text: 'a' }], details: {} }; },
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/zzz/index.js': `
        export default function (pi) {
          pi.registerTool({
            name: 'shared',
            label: 'Z',
            description: 'z',
            parameters: pi.types.Object({}),
            async execute() { return { content: [{ type: 'text', text: 'z' }], details: {} }; },
          });
        }
      `,
    });
    const warnings: string[] = [];
    const registry = new ExtensionRegistry();
    await registry.loadAll({
      mounts: [snap('wiki')],
      fs,
      warn: msg => warnings.push(msg),
    });

    const tools = registry.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]?.label).toBe('Z');

    const list = registry.list();
    const aaa = list.find(e => e.name === 'aaa');
    const zzz = list.find(e => e.name === 'zzz');
    expect(aaa?.capabilities.tools).toEqual([]);
    expect(zzz?.capabilities.tools).toEqual(['shared']);
    expect(warnings.some(w => w.includes("tool 'shared'") && w.includes('last-write-wins'))).toBe(
      true
    );
  });

  it('registerCommand surfaces a command via listCommands + findCommand', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/cmd/index.js': `
        export default function (pi) {
          pi.registerCommand('volumes', {
            description: 'list mounted volumes',
            handler: async (args) => 'mounts: ' + (args || '<all>'),
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const list = registry.listCommands();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('volumes');
    expect(list[0]?.description).toBe('list mounted volumes');
    const found = registry.findCommand('volumes');
    expect(found?.ownerExtension).toBe('cmd');
    const reply = await found?.definition.handler('latest');
    expect(reply).toBe('mounts: latest');
    const infos = registry.list();
    expect(infos[0]?.capabilities.commands).toEqual(['volumes']);
  });

  it('registerCommand last-write-wins evicts the prior owner', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/aaa/index.js': `
        export default function (pi) {
          pi.registerCommand('shared', {
            description: 'first',
            handler: async () => 'first',
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/zzz/index.js': `
        export default function (pi) {
          pi.registerCommand('shared', {
            description: 'second',
            handler: async () => 'second',
          });
        }
      `,
    });
    const warnings: string[] = [];
    const registry = new ExtensionRegistry();
    await registry.loadAll({
      mounts: [snap('wiki')],
      fs,
      warn: msg => warnings.push(msg),
    });
    const list = registry.listCommands();
    expect(list).toHaveLength(1);
    expect(list[0]?.description).toBe('second');
    expect(warnings.some(w => w.includes("'/shared'") && w.includes('last-write-wins'))).toBe(true);
    const aaa = registry.list().find(e => e.name === 'aaa');
    const zzz = registry.list().find(e => e.name === 'zzz');
    expect(aaa?.capabilities.commands).toEqual([]);
    expect(zzz?.capabilities.commands).toEqual(['shared']);
  });

  it('dispatchToolCall returns block from the first handler that refuses', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/aaa-passive/index.js': `
        export default function (pi) {
          pi.on('tool_call', () => undefined);
        }
      `,
      '/mnt/wiki/.pi/extensions/bbb-picky/index.js': `
        export default function (pi) {
          pi.on('tool_call', (event) => {
            if (event.toolName === 'bash') return { block: true, reason: 'no bash here' };
            return undefined;
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/zzz-never/index.js': `
        export default function (pi) {
          globalThis.__never_tc = false;
          pi.on('tool_call', () => {
            globalThis.__never_tc = true;
            return undefined;
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const result = await registry.dispatchToolCall({
      type: 'tool_call',
      sessionId: 's',
      toolName: 'bash',
      input: { script: 'echo hi' },
    });
    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('no bash here');
    const g = globalThis as unknown as { __never_tc: boolean };
    expect(g.__never_tc).toBe(false);
  });

  it('dispatchToolCall returns undefined when no handler blocks', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/observer/index.js': `
        export default function (pi) {
          pi.on('tool_call', () => undefined);
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const result = await registry.dispatchToolCall({
      type: 'tool_call',
      sessionId: 's',
      toolName: 'bash',
      input: {},
    });
    expect(result).toBeUndefined();
  });

  it('dispatchToolResult chains content patches across handlers', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/aaa-upper/index.js': `
        export default function (pi) {
          pi.on('tool_result', (event) => {
            const next = event.content.map(b => ({ ...b, text: (b.text ?? '').toUpperCase() }));
            return { content: next };
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/zzz-redact/index.js': `
        export default function (pi) {
          pi.on('tool_result', (event) => {
            const next = event.content.map(b => ({ ...b, text: (b.text ?? '').replace('SECRET', '[REDACTED]') }));
            return { content: next };
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const result = await registry.dispatchToolResult({
      type: 'tool_result',
      sessionId: 's',
      toolName: 'bash',
      input: {},
      content: [{ type: 'text', text: 'secret token' }],
      details: {},
      isError: false,
    });
    expect(Array.isArray(result?.content)).toBe(true);
    const blocks = result?.content as { type: string; text: string }[];
    expect(blocks[0].text).toBe('[REDACTED] TOKEN');
  });

  it('pi.session.appendEntry routes through the host bridge with the active sessionId', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/counter/index.js': `
        export default function (pi) {
          let n = 0;
          pi.on('before_agent_start', async () => {
            n += 1;
            await pi.session.appendEntry('counter', { turns: n });
          });
        }
      `,
    });
    const calls: Array<{
      sessionId: string;
      extensionName: string;
      customType: string;
      data: unknown;
    }> = [];
    const registry = new ExtensionRegistry();
    registry.setSessionBridge({
      async appendEntry(sessionId, extensionName, customType, data) {
        calls.push({ sessionId, extensionName, customType, data });
      },
      async setName() {},
      getName() {
        return null;
      },
      async setLabel() {},
      async sendMessage() {},
      async sendUserMessage() {},
    });
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    await registry.dispatchBeforeAgentStart({
      type: 'before_agent_start',
      sessionId: 'bodhi-session-x',
      prompt: 'hi',
      systemPrompt: 'BASE',
    });
    await registry.dispatchBeforeAgentStart({
      type: 'before_agent_start',
      sessionId: 'bodhi-session-x',
      prompt: 'again',
      systemPrompt: 'BASE',
    });
    expect(calls).toEqual([
      {
        sessionId: 'bodhi-session-x',
        extensionName: 'counter',
        customType: 'counter',
        data: { turns: 1 },
      },
      {
        sessionId: 'bodhi-session-x',
        extensionName: 'counter',
        customType: 'counter',
        data: { turns: 2 },
      },
    ]);
  });

  it('pi.session.* without an active dispatch throws a clear error', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/late/index.js': `
        export default function (pi) {
          globalThis.__late_pi = pi;
        }
      `,
    });
    const registry = new ExtensionRegistry();
    registry.setSessionBridge({
      async appendEntry() {},
      async setName() {},
      getName() {
        return null;
      },
      async setLabel() {},
      async sendMessage() {},
      async sendUserMessage() {},
    });
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const g = globalThis as unknown as {
      __late_pi: { session: { appendEntry(customType: string, data: unknown): Promise<void> } };
    };
    await expect(g.__late_pi.session.appendEntry('counter', { n: 1 })).rejects.toThrow(
      /outside an active session dispatch/
    );
  });

  it('dispatchBeforeAgentStart returns undefined when no handler patches the prompt', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/passive/index.js': `
        export default function (pi) {
          pi.on('before_agent_start', () => {});
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const patch = await registry.dispatchBeforeAgentStart({
      type: 'before_agent_start',
      sessionId: 's',
      prompt: 'hello',
      systemPrompt: 'BASE',
    });
    expect(patch).toBeUndefined();
  });

  it('dispatchBeforeProviderRequest chains payload replacements in load order', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/aaa-temp/index.js': `
        export default function (pi) {
          pi.on('before_provider_request', (event) => {
            return { ...event.payload, temperature: 0 };
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/zzz-tag/index.js': `
        export default function (pi) {
          pi.on('before_provider_request', (event) => {
            return { ...event.payload, tag: 'zzz' };
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const result = await registry.dispatchBeforeProviderRequest({
      type: 'before_provider_request',
      sessionId: 's',
      payload: { model: 'm', messages: [] },
    });
    expect(result).toEqual({
      model: 'm',
      messages: [],
      temperature: 0,
      tag: 'zzz',
    });
  });

  it('dispatchBeforeProviderRequest leaves payload untouched when handlers return undefined', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/observe/index.js': `
        export default function (pi) {
          pi.on('before_provider_request', () => undefined);
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    const original = { model: 'm', messages: [] };
    const result = await registry.dispatchBeforeProviderRequest({
      type: 'before_provider_request',
      sessionId: 's',
      payload: original,
    });
    expect(result).toBe(original);
  });

  it('dispatchAfterProviderResponse fires every observer; thrown errors are isolated', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/observer-a/index.js': `
        export default function (pi) {
          pi.on('after_provider_response', async (event) => {
            globalThis.__observed = globalThis.__observed ?? [];
            globalThis.__observed.push({ who: 'a', status: event.status });
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/observer-b/index.js': `
        export default function (pi) {
          pi.on('after_provider_response', () => {
            throw new Error('boom');
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/observer-c/index.js': `
        export default function (pi) {
          pi.on('after_provider_response', async (event) => {
            globalThis.__observed.push({ who: 'c', status: event.status });
          });
        }
      `,
    });
    const g = globalThis as unknown as { __observed?: Array<{ who: string; status: number }> };
    g.__observed = [];
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    await registry.dispatchAfterProviderResponse({
      type: 'after_provider_response',
      sessionId: 's',
      status: 200,
      headers: { 'x-rate': '42' },
    });
    expect(g.__observed).toEqual([
      { who: 'a', status: 200 },
      { who: 'c', status: 200 },
    ]);
  });

  it('pi.events delivers messages across extensions on a shared bus', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/sender/index.js': `
        export default function (pi) {
          globalThis.__sendPing = (data) => pi.events.emit('ping', data);
        }
      `,
      '/mnt/wiki/.pi/extensions/receiver/index.js': `
        export default function (pi) {
          globalThis.__received = [];
          pi.events.on('ping', (data) => {
            globalThis.__received.push(data);
          });
        }
      `,
    });
    const g = globalThis as unknown as {
      __sendPing?: (data: unknown) => void;
      __received?: unknown[];
    };
    g.__received = [];
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    g.__sendPing?.({ seq: 1 });
    g.__sendPing?.({ seq: 2 });
    expect(g.__received).toEqual([{ seq: 1 }, { seq: 2 }]);
  });

  it('pi.events disposes subscriptions when the extension is torn down', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/sender/index.js': `
        export default function (pi) {
          globalThis.__sendBeep = (data) => pi.events.emit('beep', data);
        }
      `,
      '/mnt/wiki/.pi/extensions/listener/index.js': `
        export default function (pi) {
          globalThis.__beeps = [];
          pi.events.on('beep', (data) => {
            globalThis.__beeps.push(data);
          });
        }
      `,
    });
    const g = globalThis as unknown as {
      __sendBeep?: (data: unknown) => void;
      __beeps?: unknown[];
    };
    g.__beeps = [];
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    g.__sendBeep?.({ seq: 1 });
    expect(g.__beeps).toEqual([{ seq: 1 }]);
    await registry.dispose();
    g.__sendBeep?.({ seq: 2 });
    expect(g.__beeps).toEqual([{ seq: 1 }]);
  });

  it('pi.events handler errors are caught and do not poison peers', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/sender/index.js': `
        export default function (pi) {
          globalThis.__sendBoom = (data) => pi.events.emit('boom', data);
        }
      `,
      '/mnt/wiki/.pi/extensions/throwing/index.js': `
        export default function (pi) {
          pi.events.on('boom', () => {
            throw new Error('listener exploded');
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/quiet/index.js': `
        export default function (pi) {
          globalThis.__quietHits = 0;
          pi.events.on('boom', () => {
            globalThis.__quietHits = (globalThis.__quietHits ?? 0) + 1;
          });
        }
      `,
    });
    const g = globalThis as unknown as {
      __sendBoom?: (data: unknown) => void;
      __quietHits?: number;
    };
    g.__quietHits = 0;
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    expect(() => g.__sendBoom?.({ n: 1 })).not.toThrow();
    expect(g.__quietHits).toBe(1);
  });

  it('pi.registerProvider records the capability and surfaces models via listProviderModels', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/custom/index.js': `
        export default function (pi) {
          pi.registerProvider('custom-anthropic', {
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'literal-key',
            api: 'anthropic-messages',
            models: [
              {
                id: 'claude-opus-4-5',
                name: 'Claude Opus 4.5',
                reasoning: true,
                input: ['text'],
                cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
                contextWindow: 200000,
                maxTokens: 64000,
              },
            ],
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });

    const list = registry.list();
    expect(list[0]?.capabilities.providers).toEqual(['custom-anthropic']);

    const models = registry.listProviderModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe('claude-opus-4-5');
    expect(models[0]?.provider).toBe('custom-anthropic');
    expect(models[0]?.api).toBe('anthropic-messages');
    expect(models[0]?.baseUrl).toBe('https://api.anthropic.com');
  });

  it('pi.registerProvider findProviderForModel returns the matching config', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/custom/index.js': `
        export default function (pi) {
          pi.registerProvider('custom-anthropic', {
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'sk-test',
            api: 'anthropic-messages',
            models: [
              { id: 'claude-opus-4-5', name: 'Opus', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 4096 },
            ],
          });
        }
      `,
    });
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });

    const match = registry.findProviderForModel('claude-opus-4-5');
    expect(match?.providerName).toBe('custom-anthropic');
    expect(match?.config.apiKey).toBe('sk-test');
    expect(registry.findProviderForModel('unknown-id')).toBeNull();
  });

  it('pi.registerProvider last-write-wins on cross-extension name collision and warns', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/aaa/index.js': `
        export default function (pi) {
          pi.registerProvider('shared', {
            baseUrl: 'https://a.example',
            apiKey: 'key-a',
            api: 'openai-completions',
            models: [
              { id: 'shared-model', name: 'A', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },
            ],
          });
        }
      `,
      '/mnt/wiki/.pi/extensions/bbb/index.js': `
        export default function (pi) {
          pi.registerProvider('shared', {
            baseUrl: 'https://b.example',
            apiKey: 'key-b',
            api: 'openai-completions',
            models: [
              { id: 'shared-model', name: 'B', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },
            ],
          });
        }
      `,
    });
    const warnings: string[] = [];
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs, warn: msg => warnings.push(msg) });

    expect(
      warnings.some(w => w.includes("provider 'shared'") && w.includes('replaces prior'))
    ).toBe(true);
    const match = registry.findProviderForModel('shared-model');
    expect(match?.ownerExtension).toBe('bbb');
    expect(match?.config.apiKey).toBe('key-b');
  });

  it('reload re-discovers and applies the disabled set', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/aaa/index.js': `
        export default function (pi) {
          globalThis.__loaded = (globalThis.__loaded ?? 0) + 1;
          pi.on('session_start', () => {});
        }
      `,
      '/mnt/wiki/.pi/extensions/bbb/index.js': `
        export default function (pi) {
          pi.on('session_start', () => {});
        }
      `,
    });
    const g = globalThis as unknown as { __loaded?: number };
    g.__loaded = 0;
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    expect(
      registry
        .list()
        .map(e => e.name)
        .sort()
    ).toEqual(['aaa', 'bbb']);
    expect(registry.getKnownNames()).toEqual(['aaa', 'bbb']);
    expect(registry.getDisabled()).toEqual([]);

    registry.setDisabled(['aaa']);
    await registry.reload();
    expect(registry.list().map(e => e.name)).toEqual(['bbb']);
    expect(registry.getDisabled()).toEqual(['aaa']);
    expect(registry.getKnownNames()).toEqual(['aaa', 'bbb']);

    registry.setDisabled([]);
    await registry.reload();
    expect(
      registry
        .list()
        .map(e => e.name)
        .sort()
    ).toEqual(['aaa', 'bbb']);
    expect(g.__loaded).toBeGreaterThanOrEqual(2);
  });

  it('reload tears down the prior runner before re-instantiating', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/counter/index.js': `
        export default function (pi) {
          globalThis.__counterFactoryRuns = (globalThis.__counterFactoryRuns ?? 0) + 1;
          pi.registerCommand('count', { description: 'x', handler: async () => 'x' });
        }
      `,
    });
    const g = globalThis as unknown as { __counterFactoryRuns?: number };
    g.__counterFactoryRuns = 0;
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });
    expect(g.__counterFactoryRuns).toBe(1);
    expect(registry.listCommands()).toHaveLength(1);

    await registry.reload();
    expect(g.__counterFactoryRuns).toBe(2);
    expect(registry.listCommands()).toHaveLength(1);
  });

  it('reload throws when called before loadAll', async () => {
    const registry = new ExtensionRegistry();
    await expect(registry.reload()).rejects.toThrow(/loadAll/);
  });

  it('pi.registerProvider returns a Disposable that unregisters', async () => {
    const fs = fakeFs({
      '/mnt/wiki/.pi/extensions/custom/index.js': `
        export default function (pi) {
          const disposable = pi.registerProvider('custom-anthropic', {
            baseUrl: 'https://api.anthropic.com',
            apiKey: 'sk-test',
            api: 'anthropic-messages',
            models: [
              { id: 'm-1', name: 'M', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000, maxTokens: 100 },
            ],
          });
          globalThis.__disposeProvider = () => disposable.dispose();
        }
      `,
    });
    const g = globalThis as unknown as { __disposeProvider?: () => void };
    const registry = new ExtensionRegistry();
    await registry.loadAll({ mounts: [snap('wiki')], fs });

    expect(registry.listProviderModels()).toHaveLength(1);
    g.__disposeProvider?.();
    expect(registry.listProviderModels()).toHaveLength(0);
  });
});
