import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, builtinAvailableCommands, findBuiltin, isBuiltinName } from './index';
import type { BuiltinExtensionsHandle, BuiltinHandlerCtx } from './types';

function ctx(overrides: Partial<BuiltinHandlerCtx> = {}): BuiltinHandlerCtx {
  return {
    sessionId: 's1',
    modelId: null,
    serverUrl: null,
    sessionStats: { turnCount: 0, messageCount: 0 },
    mcpServersConnected: [],
    mcpInstances: [],
    requestedMcpUrls: [],
    advertisedCommands: [],
    inlineMessages: [],
    buildVersion: '0.0.0-test',
    acpSdkVersion: '0.21.0-test',
    ...overrides,
  };
}

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}

function assistantMsg(text: string): AgentMessage {
  return { role: 'assistant', content: [{ type: 'text', text }] } as unknown as AgentMessage;
}

describe('findBuiltin', () => {
  it.each([
    ['/help', 'help', ''],
    ['/help topic', 'help', 'topic'],
    ['/help   spaced  args  ', 'help', 'spaced  args'],
    ['/version', 'version', ''],
    ['/info', 'info', ''],
    ['/copy', 'copy', ''],
    ['/mcp', 'mcp', ''],
    ['/mcp add https://example.com/mcp', 'mcp', 'add https://example.com/mcp'],
    ['/mcp remove https://example.com/mcp', 'mcp', 'remove https://example.com/mcp'],
  ])('matches %s → cmd=%s args=%s', (input, name, args) => {
    const match = findBuiltin(input);
    expect(match).not.toBeNull();
    expect(match!.cmd.name).toBe(name);
    expect(match!.args).toBe(args);
  });

  it.each(['help', '/wiki:greet', '/help-but-longer', '/helpx', 'no slash', '/', ''])(
    'does not match %s',
    input => {
      expect(findBuiltin(input)).toBeNull();
    }
  );
});

describe('isBuiltinName', () => {
  it.each(['help', 'version', 'info', 'copy', 'mcp', 'extension'])('recognises %s', name => {
    expect(isBuiltinName(name)).toBe(true);
  });
  it.each(['HELP', 'wiki:greet', 'random', ''])('rejects %s', name => {
    expect(isBuiltinName(name)).toBe(false);
  });
});

describe('builtinAvailableCommands', () => {
  it('returns one AvailableCommand per registered built-in', () => {
    const list = builtinAvailableCommands();
    expect(list.map(c => c.name).sort()).toEqual([
      'copy',
      'extension',
      'help',
      'info',
      'mcp',
      'version',
    ]);
    for (const c of list) {
      expect(typeof c.description).toBe('string');
      expect(c.description.length).toBeGreaterThan(0);
    }
  });
});

describe('/help handler', () => {
  it('lists every advertised command, including built-ins and vault entries', async () => {
    const advertised: AvailableCommand[] = [
      ...builtinAvailableCommands(),
      { name: 'wiki:greet', description: 'Greet someone', input: { hint: '<name>' } },
    ];
    const help = BUILTIN_COMMANDS.find(c => c.name === 'help')!;
    const result = await help.handler('', ctx({ advertisedCommands: advertised }));
    expect(result.action).toBeUndefined();
    for (const name of ['help', 'version', 'info', 'copy', 'mcp', 'wiki:greet']) {
      expect(result.replyText).toContain(`/${name}`);
    }
    expect(result.replyText).toContain('Greet someone');
  });

  it('reports an empty list when nothing is advertised', async () => {
    const help = BUILTIN_COMMANDS.find(c => c.name === 'help')!;
    const result = await help.handler('', ctx({ advertisedCommands: [] }));
    expect(result.replyText).toMatch(/no slash commands/i);
  });
});

describe('/version handler', () => {
  it('includes the build, ACP SDK, model, and server URL', async () => {
    const version = BUILTIN_COMMANDS.find(c => c.name === 'version')!;
    const result = await version.handler(
      '',
      ctx({
        buildVersion: '1.2.3',
        acpSdkVersion: '0.99.0',
        modelId: 'gpt-test',
        serverUrl: 'https://example.bodhi',
      })
    );
    expect(result.action).toBeUndefined();
    expect(result.replyText).toContain('1.2.3');
    expect(result.replyText).toContain('0.99.0');
    expect(result.replyText).toContain('gpt-test');
    expect(result.replyText).toContain('https://example.bodhi');
  });

  it('falls back to placeholders when fields are unset', async () => {
    const version = BUILTIN_COMMANDS.find(c => c.name === 'version')!;
    const result = await version.handler('', ctx({ modelId: null, serverUrl: null }));
    expect(result.replyText).toContain('(none selected)');
    expect(result.replyText).toContain('(not connected)');
  });
});

describe('/info handler', () => {
  it('renders session id, turn count, message count, and connected servers', async () => {
    const info = BUILTIN_COMMANDS.find(c => c.name === 'info')!;
    const result = await info.handler(
      '',
      ctx({
        sessionId: 'sess-42',
        sessionStats: { turnCount: 3, messageCount: 7 },
        mcpServersConnected: ['everything', 'deepwiki'],
        modelId: 'gpt-test',
      })
    );
    expect(result.action).toBeUndefined();
    expect(result.replyText).toContain('sess-42');
    expect(result.replyText).toContain('3');
    expect(result.replyText).toContain('7');
    expect(result.replyText).toContain('everything');
    expect(result.replyText).toContain('deepwiki');
  });

  it('says "none connected" when no MCP servers are live', async () => {
    const info = BUILTIN_COMMANDS.find(c => c.name === 'info')!;
    const result = await info.handler('', ctx({ mcpServersConnected: [] }));
    expect(result.replyText).toMatch(/none connected/i);
  });
});

describe('/copy handler', () => {
  it('emits a copy action when the LLM history contains an assistant turn', async () => {
    const copy = BUILTIN_COMMANDS.find(c => c.name === 'copy')!;
    const result = await copy.handler(
      '',
      ctx({
        inlineMessages: [userMsg('hi'), assistantMsg('hello there')],
      })
    );
    expect(result.action).toEqual({ kind: 'copy' });
    expect(result.replyText).toMatch(/copied/i);
  });

  it('emits no action when the conversation is empty', async () => {
    const copy = BUILTIN_COMMANDS.find(c => c.name === 'copy')!;
    const result = await copy.handler('', ctx({ inlineMessages: [] }));
    expect(result.action).toBeUndefined();
    expect(result.replyText).toMatch(/nothing to copy/i);
  });

  it('emits no action when only user messages exist (no assistant reply yet)', async () => {
    const copy = BUILTIN_COMMANDS.find(c => c.name === 'copy')!;
    const result = await copy.handler('', ctx({ inlineMessages: [userMsg('hi')] }));
    expect(result.action).toBeUndefined();
  });
});

describe('/mcp handler', () => {
  const mcp = () => BUILTIN_COMMANDS.find(c => c.name === 'mcp')!;

  describe('list (no args)', () => {
    it('renders the empty-state hint when no MCPs are connected or requested', async () => {
      const result = await mcp().handler('', ctx());
      expect(result.action).toBeUndefined();
      expect(result.replyText).toMatch(/no MCP servers requested/i);
      expect(result.replyText).toContain('/mcp add');
    });

    it('matches a Connected instance back to a requested URL via the slug heuristic', async () => {
      const result = await mcp().handler(
        '',
        ctx({
          mcpInstances: [{ slug: 'deepwiki', name: 'DeepWiki', path: '/bodhi/v1/apps/mcps/x/mcp' }],
          requestedMcpUrls: ['https://mcp.deepwiki.com/mcp'],
          serverUrl: 'https://bodhi.example',
        })
      );
      expect(result.replyText).toContain('Connected (1)');
      expect(result.replyText).toContain('https://mcp.deepwiki.com/mcp');
      expect(result.replyText).not.toMatch(/pending or denied/i);
    });

    it('falls back to the Bodhi proxy URL when no requested URL maps to the instance', async () => {
      const result = await mcp().handler(
        '',
        ctx({
          mcpInstances: [{ slug: 'orphan', name: 'Orphan', path: '/bodhi/v1/apps/mcps/x/mcp' }],
          requestedMcpUrls: [],
          serverUrl: 'https://bodhi.example',
        })
      );
      expect(result.replyText).toContain('https://bodhi.example/bodhi/v1/apps/mcps/x/mcp');
    });

    it('lists Pending entries for requested URLs that have no matching instance', async () => {
      const result = await mcp().handler(
        '',
        ctx({
          mcpInstances: [],
          requestedMcpUrls: ['https://denied.example.com/mcp'],
        })
      );
      expect(result.replyText).toContain('Pending or denied (1)');
      expect(result.replyText).toContain('https://denied.example.com/mcp');
    });
  });

  describe('add', () => {
    it('emits an mcp-add action with the canonical URL on a fresh URL', async () => {
      const result = await mcp().handler('add https://Mcp.Example.com/path', ctx());
      expect(result.action).toEqual({
        kind: 'mcp-add',
        params: { url: 'https://mcp.example.com/path' },
      });
      expect(result.replyText).toContain('Re-authenticating');
    });

    it('rejects a malformed URL with no action', async () => {
      const result = await mcp().handler('add not-a-url', ctx());
      expect(result.action).toBeUndefined();
      expect(result.replyText).toMatch(/not a valid URL/i);
    });

    it('reports idempotency without an action when the URL is already requested', async () => {
      const url = 'https://mcp.deepwiki.com/mcp';
      const result = await mcp().handler(`add ${url}`, ctx({ requestedMcpUrls: [url] }));
      expect(result.action).toBeUndefined();
      expect(result.replyText).toMatch(/already in your requested list/i);
    });

    it('shows usage when called with no URL', async () => {
      const result = await mcp().handler('add', ctx());
      expect(result.action).toBeUndefined();
      expect(result.replyText).toMatch(/usage/i);
    });
  });

  describe('remove', () => {
    it('emits an mcp-remove action with the canonical URL when the URL is in the list', async () => {
      const url = 'https://mcp.deepwiki.com/mcp';
      const result = await mcp().handler(`remove ${url}`, ctx({ requestedMcpUrls: [url] }));
      expect(result.action).toEqual({ kind: 'mcp-remove', params: { url } });
      expect(result.replyText).toContain('Removing');
    });

    it('reports no-op without an action when the URL is missing', async () => {
      const result = await mcp().handler('remove https://other.example/mcp', ctx());
      expect(result.action).toBeUndefined();
      expect(result.replyText).toMatch(/not in your requested list/i);
    });

    it('rejects a malformed URL with no action', async () => {
      const result = await mcp().handler('remove not-a-url', ctx());
      expect(result.action).toBeUndefined();
      expect(result.replyText).toMatch(/not a valid URL/i);
    });
  });

  it('rejects an unknown subcommand', async () => {
    const result = await mcp().handler('toggle some-slug', ctx());
    expect(result.action).toBeUndefined();
    expect(result.replyText).toMatch(/unknown subcommand/i);
  });
});

describe('/extension handler', () => {
  const ext = () => BUILTIN_COMMANDS.find(c => c.name === 'extension')!;

  function fakeExtensionsHandle(initial: {
    active: string[];
    disabled: string[];
    known: string[];
  }): BuiltinExtensionsHandle & {
    calls: { setDisabled: string[][]; add: { spec: string; registryUrl?: string }[] };
  } {
    const state = {
      active: [...initial.active],
      disabled: [...initial.disabled],
      known: [...initial.known],
    };
    const calls = {
      setDisabled: [] as string[][],
      add: [] as { spec: string; registryUrl?: string }[],
    };
    return {
      calls,
      active: () => state.active.map(name => ({ name, mountName: 'wiki' })),
      disabled: () => state.disabled,
      known: () => state.known,
      async setDisabled(names) {
        const dedup = Array.from(new Set(names));
        calls.setDisabled.push(dedup);
        state.disabled = dedup;
        state.active = state.known.filter(n => !dedup.includes(n));
        return {
          active: state.active.map(name => ({ name })),
          disabled: state.disabled,
        };
      },
      async add(spec, options) {
        calls.add.push({
          spec,
          ...(options?.registryUrl ? { registryUrl: options.registryUrl } : {}),
        });
        const installed = `${spec.replace('@', '__')}@1.0.0`;
        if (!state.known.includes(installed)) state.known.push(installed);
        if (!state.active.includes(installed)) state.active.push(installed);
        return {
          name: spec,
          version: '1.0.0',
          extensionName: installed,
          installPath: `/mnt/wiki/.pi/extensions/${installed}`,
          active: state.active.map(name => ({ name })),
        };
      },
    };
  }

  it('renders active and disabled extensions on `/extension list`', async () => {
    const handle = fakeExtensionsHandle({
      active: ['pirate', 'hello-tool'],
      disabled: ['session-counter'],
      known: ['pirate', 'hello-tool', 'session-counter'],
    });
    const result = await ext().handler('list', ctx({ extensions: handle }));
    expect(result.replyText).toContain('Active:');
    expect(result.replyText).toContain('`pirate`');
    expect(result.replyText).toContain('`hello-tool`');
    expect(result.replyText).toContain('Disabled:');
    expect(result.replyText).toContain('`session-counter`');
  });

  it('disables an active extension and confirms the new state', async () => {
    const handle = fakeExtensionsHandle({
      active: ['pirate', 'hello-tool'],
      disabled: [],
      known: ['pirate', 'hello-tool'],
    });
    const result = await ext().handler('off pirate', ctx({ extensions: handle }));
    expect(handle.calls.setDisabled).toEqual([['pirate']]);
    expect(result.replyText).toContain('`pirate` is now disabled');
    expect(result.replyText).toContain('Disabled:');
    expect(result.replyText).toContain('`pirate`');
  });

  it('re-enables a disabled extension', async () => {
    const handle = fakeExtensionsHandle({
      active: ['hello-tool'],
      disabled: ['pirate'],
      known: ['pirate', 'hello-tool'],
    });
    const result = await ext().handler('on pirate', ctx({ extensions: handle }));
    expect(handle.calls.setDisabled).toEqual([[]]);
    expect(result.replyText).toContain('`pirate` is now enabled');
  });

  it('rejects unknown extension names without mutating state', async () => {
    const handle = fakeExtensionsHandle({
      active: ['pirate'],
      disabled: [],
      known: ['pirate'],
    });
    const result = await ext().handler('off ghost', ctx({ extensions: handle }));
    expect(handle.calls.setDisabled).toEqual([]);
    expect(result.replyText).toMatch(/Unknown extension `ghost`/);
  });

  it('rejects an unknown subcommand with usage hint', async () => {
    const handle = fakeExtensionsHandle({ active: [], disabled: [], known: [] });
    const result = await ext().handler('toggle pirate', ctx({ extensions: handle }));
    expect(handle.calls.setDisabled).toEqual([]);
    expect(result.replyText).toMatch(/Unknown subcommand `toggle`/);
    expect(result.replyText).toMatch(/Usage/);
  });

  it('installs a package via `/extension add` and confirms the new state', async () => {
    const handle = fakeExtensionsHandle({
      active: ['pirate'],
      disabled: [],
      known: ['pirate'],
    });
    const result = await ext().handler('add pi-hello-world', ctx({ extensions: handle }));
    expect(handle.calls.add).toEqual([{ spec: 'pi-hello-world' }]);
    expect(result.replyText).toMatch(/Installed `pi-hello-world@1\.0\.0`/);
    expect(result.replyText).toContain('Wrote to `/mnt/wiki/.pi/extensions/pi-hello-world@1.0.0`');
  });

  it('parses `--registry <url>` and passes it through', async () => {
    const handle = fakeExtensionsHandle({ active: [], disabled: [], known: [] });
    await ext().handler(
      'add pi-hello-world --registry https://registry.example.test',
      ctx({ extensions: handle })
    );
    expect(handle.calls.add).toEqual([
      { spec: 'pi-hello-world', registryUrl: 'https://registry.example.test' },
    ]);
  });

  it('parses `--registry=<url>` (equals form)', async () => {
    const handle = fakeExtensionsHandle({ active: [], disabled: [], known: [] });
    await ext().handler(
      'add --registry=https://r.example pi-hello-world',
      ctx({ extensions: handle })
    );
    expect(handle.calls.add).toEqual([
      { spec: 'pi-hello-world', registryUrl: 'https://r.example' },
    ]);
  });

  it('rejects `/extension add` without a spec', async () => {
    const handle = fakeExtensionsHandle({ active: [], disabled: [], known: [] });
    const result = await ext().handler('add', ctx({ extensions: handle }));
    expect(handle.calls.add).toEqual([]);
    expect(result.replyText).toMatch(/requires a package spec/i);
  });

  it('reports install failures from the handle', async () => {
    const handle: BuiltinExtensionsHandle = {
      ...fakeExtensionsHandle({ active: [], disabled: [], known: [] }),
      add: async () => {
        throw new Error('extensions:no-agent-wd-volume — boom');
      },
    };
    const result = await ext().handler('add pi-hello-world', ctx({ extensions: handle }));
    expect(result.replyText).toMatch(/Install failed: extensions:no-agent-wd-volume/);
  });

  it('explains when the extensions registry is not configured', async () => {
    const result = await ext().handler('list', ctx());
    expect(result.replyText).toMatch(/registry not configured/i);
  });
});
