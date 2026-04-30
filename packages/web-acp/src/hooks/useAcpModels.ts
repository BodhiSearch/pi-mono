import { useCallback, useRef, useState } from 'react';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { ensureRuntime, setAuthModels } from '@/acp/runtime';
import type { BodhiModelDescriptor } from '@/acp/index';
import { getErrorMessage } from '@/lib/utils';

export interface UseAcpModelsResult {
  models: BodhiModelDescriptor[];
  isLoadingModels: boolean;
  selectedModel: string;
  selectedApiFormat: ApiFormat;
  setSelectedModel: (id: string, fmt: ApiFormat) => void;
  /** Manual refresh — used by the model-picker's "Reload" affordance. */
  loadModels: () => Promise<void>;

  // Mutators exposed for use by sibling hooks (`useAcpAuth` populates
  // `models` on auth effect; `useAcpSession.loadSession` re-applies
  // `lastModelId` after a snapshot fetch). Kept on the return surface
  // so the facade can wire cross-hook calls without context plumbing.
  setModels: (list: BodhiModelDescriptor[]) => void;
  setIsLoadingModels: (loading: boolean) => void;
  /** Pick the first model as default if no selection or current selection is gone. */
  ensureDefaultModel: (list: BodhiModelDescriptor[]) => void;
  /** After session/load: re-select the snapshot's `lastModelId` if present. */
  applyLastModel: (lastModelId: string, list: BodhiModelDescriptor[]) => void;
  /** Lock used by both the auth effect (deduping concurrent fetches) and `loadModels`. */
  loadingModelsRef: React.MutableRefObject<boolean>;
}

/**
 * Owns the model catalog slice: state + mutators for `models` /
 * `selectedModel` / `selectedApiFormat`, plus a manual `loadModels`
 * refresh path. The auth-driven population of `models` lives in
 * `useAcpAuth`; this hook simply exposes the setters that auth flow
 * uses, keeping the React state declarations co-located with the
 * picker UI surface.
 */
export function useAcpModels(
  isAuthenticated: boolean,
  setError: (msg: string | null) => void
): UseAcpModelsResult {
  const [models, setModels] = useState<BodhiModelDescriptor[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModelState] = useState<string>('');
  const [selectedApiFormat, setSelectedApiFormat] = useState<ApiFormat>('openai');
  const loadingModelsRef = useRef(false);

  const setSelectedModel = useCallback((id: string, fmt: ApiFormat) => {
    setSelectedModelState(id);
    setSelectedApiFormat(fmt);
  }, []);

  const ensureDefaultModel = useCallback((list: BodhiModelDescriptor[]) => {
    setSelectedModelState(prev => {
      if (prev && list.some(m => m.id === prev)) return prev;
      const first = list[0];
      if (first) {
        setSelectedApiFormat(first.apiFormat as ApiFormat);
        return first.id;
      }
      return prev;
    });
  }, []);

  const applyLastModel = useCallback((lastModelId: string, list: BodhiModelDescriptor[]) => {
    const match = list.find(m => m.id === lastModelId);
    if (match) {
      setSelectedModelState(match.id);
      setSelectedApiFormat(match.apiFormat as ApiFormat);
    }
  }, []);

  const loadModels = useCallback(async () => {
    if (loadingModelsRef.current) return;
    if (!isAuthenticated) {
      setError('Please log in to load models');
      return;
    }
    loadingModelsRef.current = true;
    setIsLoadingModels(true);
    setError(null);
    try {
      const runtime = ensureRuntime();
      await runtime.initialize;
      const list = await runtime.client.listModels();
      setAuthModels(list);
      setModels(list);
      ensureDefaultModel(list);
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(getErrorMessage(err, 'Failed to fetch models'));
    } finally {
      setIsLoadingModels(false);
      loadingModelsRef.current = false;
    }
  }, [isAuthenticated, setError, ensureDefaultModel]);

  return {
    models,
    isLoadingModels,
    selectedModel,
    selectedApiFormat,
    setSelectedModel,
    loadModels,
    setModels,
    setIsLoadingModels,
    ensureDefaultModel,
    applyLastModel,
    loadingModelsRef,
  };
}
