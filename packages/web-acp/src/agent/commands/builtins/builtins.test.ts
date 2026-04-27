import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import { BUILTIN_COMMANDS, builtinAvailableCommands, findBuiltin, isBuiltinName } from './index';
import type { BuiltinHandlerCtx } from './types';

function ctx(overrides: Partial<BuiltinHandlerCtx> = {}): BuiltinHandlerCtx {
  return {
    sessionId: 's1',
    modelId: null,
    serverUrl: null,
    sessionStats: { turnCount: 0, messageCount: 0 },
    mcpServersConnected: [],
    advertisedCommands: [],
    inlineMessages: [],
    buildVersion: '0.0.0-test',
    acpSdkVersion: '0.17.0-test',
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
    ['/session', 'session', ''],
    ['/copy', 'copy', ''],
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
  it.each(['help', 'version', 'session', 'copy'])('recognises %s', name => {
    expect(isBuiltinName(name)).toBe(true);
  });
  it.each(['HELP', 'wiki:greet', 'random', ''])('rejects %s', name => {
    expect(isBuiltinName(name)).toBe(false);
  });
});

describe('builtinAvailableCommands', () => {
  it('returns one AvailableCommand per registered built-in', () => {
    const list = builtinAvailableCommands();
    expect(list.map(c => c.name).sort()).toEqual(['copy', 'help', 'session', 'version']);
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
    for (const name of ['help', 'version', 'session', 'copy', 'wiki:greet']) {
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

describe('/session handler', () => {
  it('renders session id, turn count, message count, and connected servers', async () => {
    const session = BUILTIN_COMMANDS.find(c => c.name === 'session')!;
    const result = await session.handler(
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
    const session = BUILTIN_COMMANDS.find(c => c.name === 'session')!;
    const result = await session.handler('', ctx({ mcpServersConnected: [] }));
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
