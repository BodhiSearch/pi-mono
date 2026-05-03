import { useCallback, useState } from 'react';
import type { LoadSessionResponse, NewSessionResponse } from '@agentclientprotocol/sdk';
import {
  ensureRuntime,
  getModelUpdatePromise,
  getSession,
  setModelUpdatePromise,
} from '@/acp/runtime';
import { getErrorMessage } from '@/lib/utils';
import type { BodhiModelInfo } from '@/lib/bodhi-models';

export interface UseAcpModelsResult {
  models: BodhiModelInfo[];
  selectedModel: string;
  setSelectedModel: (id: string) => void;

  /** Hydrate the catalog + selected model from `NewSessionResponse.models` / `LoadSessionResponse.models`. */
  hydrateFromSessionResponse: (
    state: NewSessionResponse['models'] | LoadSessionResponse['models'] | null | undefined
  ) => void;
}

/**
 * Owns the model catalog slice: state + mutators for `models` and
 * `selectedModel`. The catalog arrives on `NewSessionResponse.models`
 * / `LoadSessionResponse.models` (`SessionModelState`), so
 * `useAcpSession` populates it; this hook owns the picker UI surface
 * and pushes the user's choice to the agent via
 * `Agent.unstable_setSessionModel`.
 */
export function useAcpModels(setError: (msg: string | null) => void): UseAcpModelsResult {
  const [models, setModels] = useState<BodhiModelInfo[]>([]);
  const [selectedModel, setSelectedModelState] = useState<string>('');

  const setSelectedModel = useCallback(
    (id: string) => {
      setSelectedModelState(id);
      const sessionId = getSession();
      if (!sessionId) return;
      const runtime = ensureRuntime();
      // Publish the in-flight set-model promise so `sendMessage` awaits it before
      // issuing the next `prompt` — otherwise the prompt races ahead of the agent's
      // `SessionState.currentModelId` update.
      const promise = runtime.client.setSessionModel(sessionId, id);
      setModelUpdatePromise(promise);
      promise.catch(err => {
        console.error('session/setModel failed:', err);
        setError(getErrorMessage(err, 'Failed to set model'));
      });
      void promise
        .finally(() => {
          if (getModelUpdatePromise() === promise) setModelUpdatePromise(null);
        })
        .catch(() => undefined);
    },
    [setError]
  );

  const hydrateFromSessionResponse = useCallback(
    (state: NewSessionResponse['models'] | LoadSessionResponse['models'] | null | undefined) => {
      if (!state) {
        setModels([]);
        return;
      }
      const list: BodhiModelInfo[] = state.availableModels.map(m => ({ id: m.modelId }));
      setModels(list);
      // Prefer snapshot's `currentModelId`; fall back to first available so a stale id from a vanished provider doesn't break the picker.
      setSelectedModelState(prev => {
        if (state.currentModelId && list.some(m => m.id === state.currentModelId)) {
          return state.currentModelId;
        }
        if (prev && list.some(m => m.id === prev)) return prev;
        return list[0]?.id ?? prev;
      });
    },
    []
  );

  return {
    models,
    selectedModel,
    setSelectedModel,
    hydrateFromSessionResponse,
  };
}
