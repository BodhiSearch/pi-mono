/**
 * Tests for `useSlashCommands`.
 *
 * Exercises the hook via a fake `WebAgentContext` that captures the
 * `RpcClient` interface the hook actually touches — no real RPC
 * transport, no Worker. The session_loaded stream is simulated through
 * the captured listener.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { ReactNode } from 'react';
import { WebAgentContext } from '@/providers/web-agent-context';
import type { RpcClient, SlashCommandInfo } from '@/worker-agent';
import { useSlashCommands } from './useSlashCommands';

function makeFakeClient(initial: SlashCommandInfo[]) {
  const sessionListeners = new Set<() => void>();
  const extensionListeners = new Set<() => void>();
  let current = initial;

  const client = {
    listCommands: vi.fn(async () => current),
    reloadCommands: vi.fn(async () => current),
    onSessionLoaded: vi.fn((listener: () => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    }),
    // M8 — `useSlashCommands` also listens for extension_states pushes so
    // the palette refreshes whenever an extension registers or drops a
    // command. The fake just records subscribers; tests that need to drive
    // the channel call `emitExtensionStates`.
    onExtensionStates: vi.fn((listener: () => void) => {
      extensionListeners.add(listener);
      return () => extensionListeners.delete(listener);
    }),
  } as unknown as RpcClient;

  return {
    client,
    setCommands(next: SlashCommandInfo[]) {
      current = next;
    },
    emitSessionLoaded() {
      for (const l of sessionListeners) l();
    },
    emitExtensionStates() {
      for (const l of extensionListeners) l();
    },
  };
}

function wrapperFor(client: RpcClient) {
  return ({ children }: { children: ReactNode }) => (
    <WebAgentContext.Provider value={{ rpcClient: client, vfsPort: null, hasWorker: false }}>
      {children}
    </WebAgentContext.Provider>
  );
}

const BUILTIN: SlashCommandInfo = { name: 'new', description: 'New', source: 'builtin' };
const TEMPLATE: SlashCommandInfo = { name: 'greet', description: 'Greet', source: 'prompt' };

describe('useSlashCommands', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('fetches the command list on mount', async () => {
    const fake = makeFakeClient([BUILTIN, TEMPLATE]);
    const { result } = renderHook(() => useSlashCommands(), {
      wrapper: wrapperFor(fake.client),
    });
    await waitFor(() => {
      expect(result.current.commands).toEqual([BUILTIN, TEMPLATE]);
    });
    expect(fake.client.listCommands).toHaveBeenCalledTimes(1);
  });

  test('filter() matches by case-insensitive name prefix', async () => {
    const fake = makeFakeClient([BUILTIN, TEMPLATE]);
    const { result } = renderHook(() => useSlashCommands(), {
      wrapper: wrapperFor(fake.client),
    });
    await waitFor(() => expect(result.current.commands.length).toBe(2));
    expect(result.current.filter('GR')).toEqual([TEMPLATE]);
    expect(result.current.filter('n')).toEqual([BUILTIN]);
    expect(result.current.filter('')).toEqual([BUILTIN, TEMPLATE]);
    expect(result.current.filter('xyz')).toEqual([]);
  });

  test('reload() refreshes the command list via RPC', async () => {
    const fake = makeFakeClient([BUILTIN]);
    const { result } = renderHook(() => useSlashCommands(), {
      wrapper: wrapperFor(fake.client),
    });
    await waitFor(() => expect(result.current.commands).toEqual([BUILTIN]));

    fake.setCommands([BUILTIN, TEMPLATE]);
    await act(async () => {
      await result.current.reload();
    });
    expect(result.current.commands).toEqual([BUILTIN, TEMPLATE]);
    expect(fake.client.reloadCommands).toHaveBeenCalledTimes(1);
  });

  test('re-fetches after session_loaded events', async () => {
    const fake = makeFakeClient([BUILTIN]);
    const { result } = renderHook(() => useSlashCommands(), {
      wrapper: wrapperFor(fake.client),
    });
    await waitFor(() => expect(result.current.commands).toEqual([BUILTIN]));
    expect(fake.client.listCommands).toHaveBeenCalledTimes(1);

    fake.setCommands([BUILTIN, TEMPLATE]);
    act(() => {
      fake.emitSessionLoaded();
    });
    await waitFor(() => expect(result.current.commands).toEqual([BUILTIN, TEMPLATE]));
    expect(fake.client.listCommands).toHaveBeenCalledTimes(2);
  });

  test('re-fetches after extension_states events', async () => {
    const fake = makeFakeClient([BUILTIN]);
    const { result } = renderHook(() => useSlashCommands(), {
      wrapper: wrapperFor(fake.client),
    });
    await waitFor(() => expect(result.current.commands).toEqual([BUILTIN]));
    expect(fake.client.listCommands).toHaveBeenCalledTimes(1);

    // Simulate the worker pushing a new extension_states snapshot — e.g.
    // right after an initial scan that landed after session_loaded. The
    // palette must pick up the newly registered extension command without
    // waiting for another session transition.
    fake.setCommands([BUILTIN, TEMPLATE]);
    act(() => {
      fake.emitExtensionStates();
    });
    await waitFor(() => expect(result.current.commands).toEqual([BUILTIN, TEMPLATE]));
    expect(fake.client.listCommands).toHaveBeenCalledTimes(2);
  });
});
