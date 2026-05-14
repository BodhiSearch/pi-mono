import { useEffect, useState } from 'react';
import {
  BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD,
  type BodhiExtensionDescriptor,
  type BodhiExtensionsStateNotificationParams,
} from '@/acp/index';
import { ensureRuntime } from '@/acp/runtime';

export interface UseExtensionsResult {
  entries: BodhiExtensionDescriptor[];
  error: string | null;
}

const EMPTY_ENTRIES: BodhiExtensionDescriptor[] = [];

export const EMPTY_EXTENSIONS: UseExtensionsResult = {
  entries: EMPTY_ENTRIES,
  error: null,
};

/**
 * Boot-time fetch of `_bodhi/extensions/list` once auth is ready, plus a
 * subscription to `_bodhi/extensions/state` so `/extension on|off` and
 * `_bodhi/extensions/reload` propagate to consumers without polling.
 *
 * State is intentionally NOT reset on un-auth — `useAcp` substitutes
 * the `EMPTY_EXTENSIONS` sentinel via top-level gating so a logout
 * never leaks stale entries to consumers.
 */
export function useExtensions(isAuthenticated: boolean): UseExtensionsResult {
  const [state, setState] = useState<UseExtensionsResult>(EMPTY_EXTENSIONS);

  useEffect(() => {
    if (!isAuthenticated) return;
    let cancelled = false;
    // Sequence guard: if a `_bodhi/extensions/state` notification arrives
    // before the initial `listExtensions()` resolves (e.g. an
    // `_bodhi/extensions/reload` racing with first-paint), the notification's
    // newer state must not be overwritten by the stale list snapshot.
    let seq = 0;
    const initialSeq = ++seq;
    const runtime = ensureRuntime();
    runtime.client
      .listExtensions()
      .then(list => {
        if (cancelled) return;
        if (seq !== initialSeq) return; // a notification raced in; drop the stale snapshot.
        setState({ entries: list, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (seq !== initialSeq) return;
        console.error('[useExtensions] listExtensions failed:', err);
        setState({
          entries: EMPTY_ENTRIES,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    const unsubscribe = runtime.client.onExtNotification((method, params) => {
      if (method !== BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD) return;
      const payload = params as BodhiExtensionsStateNotificationParams;
      const next = Array.isArray(payload.extensions) ? payload.extensions : EMPTY_ENTRIES;
      seq += 1;
      setState({ entries: next, error: null });
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isAuthenticated]);

  return state;
}
