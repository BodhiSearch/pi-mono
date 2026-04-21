/**
 * Main-thread hook for the ExtensionsPanel + extension-error toasts.
 *
 * Composes:
 * - `ExtensionStore` (idb-keyval) — persisted per-extension enabled flags.
 * - Worker RPC — `list_extensions` / `set_extension_states` + the
 *   `extension_states` / `extension_error` push channels.
 *
 * Boot contract: the persisted enabled map is hydrated by
 * `WebAgentProvider` and forwarded to the Worker via the init
 * message, so by the time this hook runs the Worker already knows the
 * correct enable state. The hook fetches the descriptor list once to
 * catch up (the initial `extension_states` push may arrive before the
 * subscriber attaches), subscribes to future pushes, and reconciles
 * newly-discovered extensions by defaulting them to `enabled = true`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useWebAgent } from '@/providers/web-agent-context';
import { ExtensionStore, type ExtensionEnabledMap } from '@/extension-store/ExtensionStore';
import type { ExtensionDescriptor, ExtensionError, RpcExtensionErrorEvent } from '@/worker-agent';

const EMPTY_DESCRIPTORS: ExtensionDescriptor[] = [];
const EMPTY_ERRORS: ExtensionError[] = [];

export interface UseExtensionStateResult {
  /** Latest descriptor list from the worker (loaded + broken entries). */
  extensions: ExtensionDescriptor[];
  /** Most recent extension errors surfaced over RPC. Capped at 20 entries. */
  errors: ExtensionError[];
  /** Persisted enabled map. Defaults absent entries to `true`. */
  enabledMap: ExtensionEnabledMap;
  /** Toggle a single extension and push the change to the worker. */
  setEnabled: (name: string, enabled: boolean) => Promise<void>;
  /** Disable every currently-discovered extension. Satisfies the M8 trip-switch gate. */
  disableAll: () => Promise<void>;
  /** Clear the accumulated error list (e.g. when a toast is dismissed). */
  clearErrors: () => void;
}

export function useExtensionState(): UseExtensionStateResult {
  const { rpcClient } = useWebAgent();
  const [store] = useState(() => new ExtensionStore());
  const [extensions, setExtensions] = useState<ExtensionDescriptor[]>(EMPTY_DESCRIPTORS);
  const [errors, setErrors] = useState<ExtensionError[]>(EMPTY_ERRORS);
  const [enabledMap, setEnabledMap] = useState<ExtensionEnabledMap>({});

  // Hydrate the persisted map for the UI + catch up on the initial
  // descriptor snapshot. No `setExtensionStates` push needed here — the
  // Worker already received the map via its init message.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const loaded = await store.load();
      if (cancelled) return;
      setEnabledMap(loaded);
      try {
        const initial = await rpcClient.listExtensions();
        if (!cancelled) setExtensions(initial);
      } catch (err) {
        console.error('[useExtensionState] listExtensions failed:', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpcClient, store]);

  // Subscribe to worker-pushed state / error events. Cleanup disposers
  // on unmount so HMR reloads don't accumulate listeners.
  useEffect(() => {
    const offStates = rpcClient.onExtensionStates(evt => {
      setExtensions(evt.extensions);
      // Reconcile: any discovered extension missing from the persisted
      // map becomes enabled by default and is pushed back down.
      const current = store.snapshot();
      const additions: ExtensionEnabledMap = {};
      for (const descriptor of evt.extensions) {
        if (!(descriptor.name in current)) {
          additions[descriptor.name] = true;
        }
      }
      if (Object.keys(additions).length > 0) {
        void store.setMany(additions).then(next => {
          setEnabledMap(next);
          rpcClient.setExtensionStates(next).catch(err => {
            console.error('[useExtensionState] reconcile push failed:', err);
          });
        });
      }
    });
    const offErrors = rpcClient.onExtensionError((evt: RpcExtensionErrorEvent) => {
      const rest: ExtensionError = {
        extensionPath: evt.extensionPath,
        event: evt.event,
        error: evt.error,
        stack: evt.stack,
      };
      setErrors(prev => {
        const next = [...prev, rest];
        return next.length > 20 ? next.slice(next.length - 20) : next;
      });
    });
    return () => {
      offStates();
      offErrors();
    };
  }, [rpcClient, store]);

  const setEnabled = useCallback(
    async (name: string, enabled: boolean) => {
      const next = await store.setEnabled(name, enabled);
      setEnabledMap(next);
      try {
        await rpcClient.setExtensionStates({ [name]: enabled });
      } catch (err) {
        console.error('[useExtensionState] setExtensionStates failed:', err);
      }
    },
    [rpcClient, store]
  );

  const disableAll = useCallback(async () => {
    const names = extensions.map(e => e.name);
    const next = await store.disableAll(names);
    setEnabledMap(next);
    try {
      const payload: ExtensionEnabledMap = {};
      for (const n of names) payload[n] = false;
      await rpcClient.setExtensionStates(payload);
    } catch (err) {
      console.error('[useExtensionState] disableAll failed:', err);
    }
  }, [extensions, rpcClient, store]);

  const clearErrors = useCallback(() => {
    setErrors(EMPTY_ERRORS);
  }, []);

  return useMemo(
    () => ({
      extensions,
      errors,
      enabledMap,
      setEnabled,
      disableAll,
      clearErrors,
    }),
    [extensions, errors, enabledMap, setEnabled, disableAll, clearErrors]
  );
}
