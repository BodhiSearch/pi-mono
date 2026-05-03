import { describe, expect, it } from 'vitest';
import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { initialPanelsState, panelsReducer, type PanelsState } from './panels-reducer';

function makeMsg(role: 'user' | 'assistant', text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

describe('panelsReducer', () => {
  it('available_commands_update populates the picker', () => {
    const notif = {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'help', description: '/help' }],
      },
    } as unknown as SessionNotification;
    const s = panelsReducer(initialPanelsState, { type: 'session-update', notif });
    expect(s.availableCommands).toHaveLength(1);
  });

  it('available_commands_update with empty list resets to the frozen sentinel', () => {
    const seeded: PanelsState = {
      ...initialPanelsState,
      availableCommands: [{ name: 'help', description: '/help' }] as never,
    };
    const notif = {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'available_commands_update',
        availableCommands: [],
      },
    } as unknown as SessionNotification;
    const s = panelsReducer(seeded, { type: 'session-update', notif });
    expect(s.availableCommands).toBe(initialPanelsState.availableCommands);
  });

  it('config_option_update replaces the wire-supplied list wholesale', () => {
    const notif = {
      sessionId: 'sess-1',
      update: {
        sessionUpdate: 'config_option_update',
        configOptions: [
          {
            type: 'select',
            id: '_bodhi/features/bashEnabled',
            name: 'Bash tool',
            currentValue: 'on',
            category: '_bodhi/feature',
            options: [
              { value: 'on', name: 'On' },
              { value: 'off', name: 'Off' },
            ],
          },
        ],
      },
    } as unknown as SessionNotification;
    const s = panelsReducer(initialPanelsState, { type: 'session-update', notif });
    expect(s.configOptions).toHaveLength(1);
    expect(s.configOptions[0].id).toBe('_bodhi/features/bashEnabled');
  });

  it('config-options-init seeds the slice from new/load response', () => {
    const s = panelsReducer(initialPanelsState, {
      type: 'config-options-init',
      configOptions: [
        {
          type: 'select',
          id: '_bodhi/features/bashEnabled',
          name: 'Bash tool',
          currentValue: 'off',
          category: '_bodhi/feature',
          options: [
            { value: 'on', name: 'On' },
            { value: 'off', name: 'Off' },
          ],
        },
      ],
    });
    expect(s.configOptions).toHaveLength(1);
    expect(s.configOptions[0].id).toBe('_bodhi/features/bashEnabled');
  });

  it('mcp-state merges per-server connection meta', () => {
    let s: PanelsState = panelsReducer(initialPanelsState, {
      type: 'mcp-state',
      meta: { server: 'srv-1', state: 'connected' },
    });
    expect(s.mcpStates['srv-1']).toEqual({ server: 'srv-1', state: 'connected' });

    s = panelsReducer(s, {
      type: 'mcp-state',
      meta: { server: 'srv-2', state: 'disconnected' },
    });
    expect(s.mcpStates['srv-2']?.state).toBe('disconnected');
    expect(s.mcpStates['srv-1']?.state).toBe('connected');
  });

  it('reset preserves mcpStates and configOptions but drops availableCommands', () => {
    let s: PanelsState = panelsReducer(initialPanelsState, {
      type: 'session-update',
      notif: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'available_commands_update',
          availableCommands: [{ name: 'help', description: '/help' }],
        },
      } as unknown as SessionNotification,
    });
    s = panelsReducer(s, {
      type: 'session-update',
      notif: {
        sessionId: 'sess-1',
        update: {
          sessionUpdate: 'config_option_update',
          configOptions: [
            {
              type: 'select',
              id: '_bodhi/features/bashEnabled',
              name: 'Bash tool',
              currentValue: 'on',
              category: '_bodhi/feature',
              options: [
                { value: 'on', name: 'On' },
                { value: 'off', name: 'Off' },
              ],
            },
          ],
        },
      } as unknown as SessionNotification,
    });
    s = panelsReducer(s, {
      type: 'mcp-state',
      meta: { server: 'srv-1', state: 'connected' },
    });
    expect(s.availableCommands).toHaveLength(1);
    expect(s.configOptions).toHaveLength(1);
    expect(s.mcpStates['srv-1']?.state).toBe('connected');

    const after = panelsReducer(s, { type: 'reset' });
    expect(after.availableCommands).toEqual([]);
    expect(after.configOptions).toBe(s.configOptions);
    expect(after.mcpStates).toBe(s.mcpStates);
  });

  it.each([
    {
      action: { type: 'turn-start', userMessage: makeMsg('user', 'hi') } as const,
      label: 'turn-start',
    },
    { action: { type: 'turn-end', stopReason: 'end_turn' } as const, label: 'turn-end' },
    { action: { type: 'load-start' } as const, label: 'load-start' },
    { action: { type: 'load-end' } as const, label: 'load-end' },
  ])('streaming-only action $label is a no-op on the panels reducer', ({ action }) => {
    const s = panelsReducer(initialPanelsState, action);
    expect(s).toBe(initialPanelsState);
  });
});
