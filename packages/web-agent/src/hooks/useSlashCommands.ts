/**
 * Main-thread hook for the slash-command autocomplete palette.
 *
 * Owns a cached `SlashCommandInfo[]` sourced from the Worker over RPC
 * (`list_commands`), refreshes it on `session_loaded` (vault mount
 * ordering means templates may not have been ready on the initial
 * fetch), and exposes a `filter(prefix)` for the palette component.
 *
 * Templates and builtins share the same listing so users don't need to
 * know which is which — badges in the UI distinguish them.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebAgent } from '@/providers/web-agent-context';
import type { SlashCommandInfo } from '@/worker-agent';

const EMPTY: SlashCommandInfo[] = [];

export interface UseSlashCommandsResult {
  commands: SlashCommandInfo[];
  filter: (prefix: string) => SlashCommandInfo[];
  reload: () => Promise<void>;
}

export function useSlashCommands(): UseSlashCommandsResult {
  const { rpcClient } = useWebAgent();
  const [commands, setCommands] = useState<SlashCommandInfo[]>(EMPTY);

  const refresh = useCallback(async () => {
    try {
      const list = await rpcClient.listCommands();
      setCommands(list);
    } catch (err) {
      console.error('[useSlashCommands] listCommands failed:', err);
    }
  }, [rpcClient]);

  const reload = useCallback(async () => {
    try {
      const list = await rpcClient.reloadCommands();
      setCommands(list);
    } catch (err) {
      console.error('[useSlashCommands] reloadCommands failed:', err);
    }
  }, [rpcClient]);

  // Initial fetch is dispatched on a microtask so `refresh()`'s
  // setState isn't synchronously reachable from the effect body
  // (react-hooks/set-state-in-effect). See `useMcpList` for the same
  // pattern.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => {
      if (!cancelled) void refresh();
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Re-fetch after session_loaded — the Worker emits this on boot and
  // after loadSession/newSession/forkSession/etc. Any of those paths
  // may race with an initial mountVault, so a second fetch picks up
  // templates that arrived after the first call returned.
  useEffect(() => {
    return rpcClient.onSessionLoaded(() => {
      void refresh();
    });
  }, [rpcClient, refresh]);

  // Re-fetch after extension_states — extensions can register slash
  // commands, and their load lifecycle is independent of session
  // transitions. Without this the palette stays stale when the
  // extension runner finishes its initial scan after the first
  // session_loaded (boot race) or after a per-extension toggle flips
  // visibility on/off.
  useEffect(() => {
    return rpcClient.onExtensionStates(() => {
      void refresh();
    });
  }, [rpcClient, refresh]);

  const filter = useCallback(
    (prefix: string): SlashCommandInfo[] => {
      const needle = prefix.toLowerCase();
      if (!needle) return commands;
      return commands.filter(c => c.name.toLowerCase().startsWith(needle));
    },
    [commands]
  );

  return useMemo(() => ({ commands, filter, reload }), [commands, filter, reload]);
}
