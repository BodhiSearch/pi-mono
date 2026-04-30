import { useCallback, useState } from 'react';
import { ensureRuntime, getSession } from '@/acp/runtime';
import type { BodhiFeatureBag } from '@/acp/index';
import { getErrorMessage } from '@/lib/utils';

export interface UseAcpFeaturesResult {
  features: BodhiFeatureBag;
  featureDefaults: BodhiFeatureBag;
  /** Refetch the feature bag for an explicit session id (typically called from useAcpSession). */
  refreshFeatures: (sessionId: string) => Promise<void>;
  /** Toggle a feature on the active session and rehydrate from the worker's response. */
  setFeature: (key: string, value: boolean) => Promise<void>;
  /** Reset the per-session bag (`featureDefaults` is preserved). Used by `clearMessages`. */
  clearFeatures: () => void;
}

/**
 * Owns the `_bodhi/features/list` + `_bodhi/features/set` slice. The
 * features bag is per-session; this hook neither owns nor watches the
 * session id — `refreshFeatures(sessionId)` is invoked by the session
 * runtime hook on `session/new` / `session/load`, while `setFeature`
 * reads the active session from the runtime singleton.
 */
export function useAcpFeatures(setError: (msg: string | null) => void): UseAcpFeaturesResult {
  const [features, setFeatures] = useState<BodhiFeatureBag>({});
  const [featureDefaults, setFeatureDefaults] = useState<BodhiFeatureBag>({});

  const refreshFeatures = useCallback(async (sessionId: string) => {
    const runtime = ensureRuntime();
    try {
      await runtime.initialize;
      const payload = await runtime.client.listFeatures(sessionId);
      setFeatures(payload.features ?? {});
      setFeatureDefaults(payload.defaults ?? {});
    } catch (err) {
      console.error('_bodhi/features/list failed:', err);
    }
  }, []);

  const setFeature = useCallback(
    async (key: string, value: boolean) => {
      const sessionId = getSession();
      if (!sessionId) return;
      const runtime = ensureRuntime();
      try {
        const payload = await runtime.client.setFeature(sessionId, key, value);
        setFeatures(payload.features ?? {});
      } catch (err) {
        console.error('_bodhi/features/set failed:', err);
        setError(getErrorMessage(err, 'Failed to toggle feature'));
        await refreshFeatures(sessionId);
      }
    },
    [refreshFeatures, setError]
  );

  const clearFeatures = useCallback(() => setFeatures({}), []);

  return { features, featureDefaults, refreshFeatures, setFeature, clearFeatures };
}
