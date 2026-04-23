import { describe, expect, test, vi } from 'vitest';
import { Type } from '@sinclair/typebox';
import type { ExtensionContext, ExtensionUIContext, RegisteredTool } from './types';
import { wrapRegisteredTool, wrapRegisteredTools } from './wrapper';

const noopUI: ExtensionUIContext = {
  notify: () => {},
  setStatus: () => {},
  setTitle: () => {},
  setWidget: () => {},
  setEditorText: () => {},
  editor: async () => undefined,
  select: async () => undefined,
  confirm: async () => false,
  input: async () => undefined,
};

function makeRegistered(): RegisteredTool {
  return {
    definition: {
      name: 'greet',
      description: 'greet someone',
      parameters: Type.Object({
        name: Type.String(),
      }),
      async execute(id, params, _signal, _onUpdate, ctx) {
        const { name } = params as { name: string };
        return {
          content: [{ type: 'text', text: `${id}:${name}:${ctx.cwd}` }],
          details: { greeted: name },
        };
      },
    },
    extensionPath: '/vault/.pi/extensions/greet',
  };
}

describe('wrapRegisteredTool', () => {
  test('adapts execute signature and supplies live context', async () => {
    let current: ExtensionContext = {
      cwd: '/vault',
      isIdle: () => true,
      abort: () => {},
      ui: noopUI,
      hasUI: true,
      session: null,
    };
    const wrapped = wrapRegisteredTool(makeRegistered(), () => current);

    expect(wrapped.name).toBe('greet');
    expect(wrapped.description).toBe('greet someone');

    const first = await wrapped.execute('call-1', { name: 'Alice' }, undefined, undefined);
    expect(first.content[0]).toMatchObject({ text: 'call-1:Alice:/vault' });

    current = {
      cwd: '/other',
      isIdle: () => false,
      abort: () => {},
      ui: noopUI,
      hasUI: true,
      session: null,
    };
    const second = await wrapped.execute('call-2', { name: 'Bob' }, undefined, undefined);
    expect(second.content[0]).toMatchObject({ text: 'call-2:Bob:/other' });
  });

  test('wrapRegisteredTools preserves order', () => {
    const ctx: ExtensionContext = {
      cwd: undefined,
      isIdle: () => true,
      abort: () => {},
      ui: noopUI,
      hasUI: true,
      session: null,
    };
    const a = makeRegistered();
    const b = makeRegistered();
    b.definition = { ...b.definition, name: 'other' };
    const wrapped = wrapRegisteredTools([a, b], () => ctx);
    expect(wrapped.map(t => t.name)).toEqual(['greet', 'other']);
  });

  test('forwards prepareArguments and executionMode when defined', () => {
    const registered = makeRegistered();
    const prepare = vi.fn().mockReturnValue({ name: 'X' });
    registered.definition = {
      ...registered.definition,
      prepareArguments: prepare,
      executionMode: 'sequential',
    };
    const wrapped = wrapRegisteredTool(registered, () => ({
      cwd: undefined,
      isIdle: () => true,
      abort: () => {},
      ui: noopUI,
      hasUI: true,
      session: null,
    }));
    expect(wrapped.prepareArguments).toBe(prepare);
    expect(wrapped.executionMode).toBe('sequential');
  });
});
