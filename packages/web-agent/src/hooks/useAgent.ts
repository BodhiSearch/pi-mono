import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { getErrorMessage } from '@/lib/utils';
import { apiFormatToProvider, buildModel, getServerUrlOrThrow } from '@/lib/agent-model';
import { fetchBodhiModels, type BodhiModelInfo } from '@/lib/bodhi-models';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { useWebAgent } from '@/providers/web-agent-context';
import { useSessionsList } from '@/hooks/useSessionsList';
import type { McpToolDescriptor, ToolCallHandler } from '@/web-agent';
import type { UiMessageMeta } from '@/web-agent/core/session/types';

const ACTIVE_SESSION_STORAGE_KEY = 'web-agent.activeSessionId';

interface ActiveSession {
  id: string;
  name?: string;
}

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];

interface UseAgentInput {
  /** MCP tool descriptors (plain data) shipped to the Worker. */
  mcpToolDescriptors: McpToolDescriptor[];
  /** Handler invoked when the Worker-side proxy tool upcalls. */
  toolCallHandler: ToolCallHandler;
}

export function useAgent({ mcpToolDescriptors, toolCallHandler }: UseAgentInput) {
  const { rpcClient } = useWebAgent();
  const { client: bodhiClient, auth, isAuthenticated, isReady } = useBodhi();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | undefined>(undefined);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<BodhiModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModelState] = useState<string>('');
  const [selectedApiFormat, setSelectedApiFormat] = useState<ApiFormat>('openai');
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [messageMeta, setMessageMeta] = useState<UiMessageMeta[]>([]);
  const sessionSummaries = useSessionsList();

  const isLoadingModelsRef = useRef(false);
  const sessionBootRef = useRef(false);
  /**
   * Holds the most recent `{ provider, modelId }` restored from a
   * session_loaded envelope when the `models` list wasn't ready yet.
   * The `models`-settles effect drains this and syncs the combobox.
   */
  const pendingRestoredModelRef = useRef<{ provider: string; modelId: string } | null>(null);
  /** Latest `models` snapshot, readable from event callbacks without stale closures. */
  const modelsRef = useRef<BodhiModelInfo[]>(EMPTY_MODELS);
  useEffect(() => {
    modelsRef.current = models;
  }, [models]);

  const applyRestoredModelIdentifier = useCallback(
    (id: { provider: string; modelId: string } | null) => {
      if (!id) {
        pendingRestoredModelRef.current = null;
        return;
      }
      const currentModels = modelsRef.current;
      if (currentModels.length === 0) {
        // Models not loaded yet — stash; the loadModels `getState` pass
        // or the drain effect will finish the apply later.
        pendingRestoredModelRef.current = id;
        return;
      }
      const match = currentModels.find(m => m.id === id.modelId);
      if (match) {
        setSelectedModelState(match.id);
        setSelectedApiFormat(match.apiFormat);
      } else {
        console.warn(
          `[useAgent] restored model ${id.provider}/${id.modelId} not in catalog — falling back`
        );
        setSelectedModelState(currentModels[0].id);
        setSelectedApiFormat(currentModels[0].apiFormat);
      }
      pendingRestoredModelRef.current = null;
    },
    []
  );

  // Push the auth token to the Worker on every change. The Worker's
  // streamFn closure reads this synchronously per request.
  useEffect(() => {
    void rpcClient.setAuthToken(auth.accessToken ?? null);
  }, [auth.accessToken, rpcClient]);

  // Register the handler that services Worker-side MCP tool upcalls.
  // Must be set before any prompt that could invoke an MCP tool.
  useEffect(() => {
    rpcClient.setToolCallHandler(toolCallHandler);
    return () => {
      rpcClient.setToolCallHandler(null);
    };
  }, [rpcClient, toolCallHandler]);

  // Push the MCP tool descriptors to the Worker so the agent's tool list
  // includes them. Vault tools live entirely Worker-side and are wired
  // by the WorkerAgentHost on mount_vault.
  useEffect(() => {
    void rpcClient.setMcpTools(mcpToolDescriptors);
  }, [rpcClient, mcpToolDescriptors]);

  useEffect(() => {
    const unsubscribe = rpcClient.subscribe(envelope => {
      switch (envelope.event.type) {
        case 'agent_start':
          setIsStreaming(true);
          setError(null);
          break;
        case 'message_update':
          setMessages(envelope.messages);
          setStreamingMessage(envelope.streamingMessage);
          break;
        case 'message_end':
          setMessages(envelope.messages);
          setStreamingMessage(undefined);
          break;
        case 'turn_end':
          setMessages(envelope.messages);
          break;
        case 'agent_end':
          setMessages(envelope.messages);
          setStreamingMessage(undefined);
          setIsStreaming(false);
          if (envelope.errorMessage) {
            setError(envelope.errorMessage);
          }
          break;
      }
    });
    return unsubscribe;
  }, [rpcClient]);

  // --------------------------------------------------------------------------
  // M7 — compaction lifecycle
  // --------------------------------------------------------------------------
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactionError, setCompactionError] = useState<string | null>(null);

  useEffect(() => {
    return rpcClient.onCompactionEvent(event => {
      if (event.type === 'compaction_start') {
        setIsCompacting(true);
        setCompactionError(null);
      } else if (event.type === 'compaction_end') {
        setIsCompacting(false);
        if (event.success === false && event.errorMessage) {
          setCompactionError(event.errorMessage);
        }
      }
    });
  }, [rpcClient]);

  // Session-loaded envelopes are the authoritative signal that the Worker
  // has swapped sessions. Replace the local message buffer, surface the
  // new active-session meta, and persist the id so a reload restores it.
  // The picker list is driven by `useSessionsList` (Dexie liveQuery), so
  // no manual refresh is needed — new/renamed/deleted sessions appear
  // automatically on cross-context write.
  useEffect(() => {
    return rpcClient.onSessionLoaded(event => {
      setMessages(event.messages);
      setMessageMeta(event.messageMeta);
      setStreamingMessage(undefined);
      setIsStreaming(false);
      setError(null);
      setActiveSession({ id: event.sessionId, name: event.name });
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, event.sessionId);
        } catch {
          // localStorage disabled or full — fall back to in-memory only.
        }
      }
      // Mirror coding-agent's TUI pattern: after a session swap, poll
      // `get_state` for the restored model and sync the combobox.
      // `models` may not be loaded yet (boot race) — `applyRestoredModelIdentifier`
      // stashes in that case and the drain effect below finishes the apply.
      void rpcClient
        .getState()
        .then(state => {
          applyRestoredModelIdentifier(
            state.model ? { provider: state.model.provider, modelId: state.model.id } : null
          );
        })
        .catch(err => {
          console.error('[useAgent] getState after session_loaded failed:', err);
        });
    });
  }, [rpcClient, applyRestoredModelIdentifier]);

  // Drain any pending restored-model identifier when `models` settles
  // (boot-time race: the first session_loaded fires before the catalog
  // is loaded, so the handler stashed the id). Runtime session-switches
  // apply directly from the handler — nothing to drain there.
  useEffect(() => {
    const pending = pendingRestoredModelRef.current;
    if (!pending || models.length === 0) return;
    applyRestoredModelIdentifier(pending);
  }, [models, applyRestoredModelIdentifier]);

  // Boot-time session restore: prefer the session id from localStorage so
  // reloads pick up where the user left off. StrictMode-safe via a ref.
  useEffect(() => {
    if (sessionBootRef.current) return;
    sessionBootRef.current = true;

    let storedId: string | null = null;
    if (typeof window !== 'undefined') {
      try {
        storedId = window.localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
      } catch {
        storedId = null;
      }
    }

    (async () => {
      if (storedId) {
        try {
          await rpcClient.loadSession(storedId);
          return;
        } catch {
          // Stored id is stale / file was deleted — fall through to new.
        }
      }
      try {
        await rpcClient.newSession();
      } catch (err) {
        console.error('[useAgent] failed to start a session:', err);
      }
    })();
  }, [rpcClient]);

  const loadModels = useCallback(async () => {
    if (isLoadingModelsRef.current) return;
    if (!isAuthenticated) {
      setError('Please log in to load models');
      return;
    }
    isLoadingModelsRef.current = true;
    setIsLoadingModels(true);
    setError(null);
    try {
      const list = await fetchBodhiModels(bodhiClient);
      setModels(list);
      // Seed the Worker-side model registry so `setModel(provider,
      // modelId)` can resolve identifiers. Coding-agent owns this
      // registry via config-file seed; we push from the main thread
      // because only it has the bodhiClient.
      const serverUrl = getServerUrlOrThrow(bodhiClient.getState());
      const resolved = list.map(m => buildModel(m.id, serverUrl, m.apiFormat));
      await rpcClient.setAvailableModels(resolved);
      // Seeding the registry triggers the Worker's boot-race recovery:
      // any persisted `model_change` that couldn't resolve earlier now
      // resolves and becomes the session's active model. Ask the Worker
      // for the authoritative state and pick that over the default. Only
      // falls back to `list[0]` when the session genuinely has no
      // restored model (fresh session, or stale id removed earlier).
      const restored = await rpcClient.getState();
      if (restored.model) {
        const match = list.find(m => m.id === restored.model?.id);
        if (match) {
          setSelectedModelState(match.id);
          setSelectedApiFormat(match.apiFormat);
        } else if (list.length > 0) {
          setSelectedModelState(list[0].id);
          setSelectedApiFormat(list[0].apiFormat);
        }
      } else if (list.length > 0 && !selectedModel) {
        setSelectedModelState(list[0].id);
        setSelectedApiFormat(list[0].apiFormat);
      }
      // Boot-time restore is now handled; any earlier stash is stale.
      pendingRestoredModelRef.current = null;
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(getErrorMessage(err, 'Failed to fetch models'));
    } finally {
      setIsLoadingModels(false);
      isLoadingModelsRef.current = false;
    }
  }, [bodhiClient, isAuthenticated, selectedModel, rpcClient]);

  useEffect(() => {
    if (isReady && isAuthenticated && models.length === 0 && !isLoadingModelsRef.current) {
      loadModels();
    }
  }, [isReady, isAuthenticated, models.length, loadModels]);

  useEffect(() => {
    if (!isAuthenticated) {
      void rpcClient.abort();
    }
  }, [isAuthenticated, rpcClient]);

  const setSelectedModel = useCallback((id: string, fmt: ApiFormat) => {
    setSelectedModelState(id);
    setSelectedApiFormat(fmt);
  }, []);

  const sendMessage = useCallback(
    async (prompt: string) => {
      if (!selectedModel) {
        setError('Please select a model first');
        return;
      }
      setError(null);

      const provider = apiFormatToProvider(selectedApiFormat);

      await rpcClient.setSystemPrompt('');
      await rpcClient.setModel(provider, selectedModel);

      try {
        await rpcClient.prompt(prompt);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to send message:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      }
    },
    [selectedModel, selectedApiFormat, rpcClient]
  );

  const stop = useCallback(() => {
    void rpcClient.abort();
  }, [rpcClient]);

  const clearMessages = useCallback(() => {
    // "Clear" in the UI starts a fresh persisted session so the existing
    // conversation stays accessible via the picker. The Worker emits
    // session_loaded, which resets local state + activeSession.
    void rpcClient.newSession().catch(err => {
      console.error('[useAgent] newSession failed:', err);
    });
  }, [rpcClient]);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // --------------------------------------------------------------------------
  // Sessions API (M5)
  // --------------------------------------------------------------------------

  const loadSession = useCallback((id: string) => rpcClient.loadSession(id), [rpcClient]);

  const newSession = useCallback(async () => {
    const { sessionId } = await rpcClient.newSession();
    return sessionId;
  }, [rpcClient]);

  const deleteSession = useCallback(
    async (id: string) => {
      await rpcClient.deleteSession(id);
    },
    [rpcClient]
  );

  const renameSession = useCallback(
    async (name: string) => {
      await rpcClient.setSessionName(name);
    },
    [rpcClient]
  );

  const forkSession = useCallback(
    async (entryId: string) => {
      const { sessionId } = await rpcClient.forkSession(entryId);
      return sessionId;
    },
    [rpcClient]
  );

  const navigateToLeaf = useCallback(
    async (entryId: string) => {
      await rpcClient.navigateToLeaf(entryId);
    },
    [rpcClient]
  );

  const compactNow = useCallback(async () => {
    setCompactionError(null);
    await rpcClient.compactNow();
  }, [rpcClient]);

  const messageEntryIds = useMemo(() => messageMeta.map(m => m?.entryId ?? ''), [messageMeta]);

  return {
    messages: isAuthenticated ? messages : EMPTY_MESSAGES,
    streamingMessage: isAuthenticated ? streamingMessage : undefined,
    isStreaming: isAuthenticated ? isStreaming : false,
    selectedModel: isAuthenticated ? selectedModel : '',
    selectedApiFormat,
    setSelectedModel,
    sendMessage,
    stop,
    clearMessages,
    error: isAuthenticated ? error : null,
    clearError,
    models: isAuthenticated ? models : EMPTY_MODELS,
    isLoadingModels: isAuthenticated ? isLoadingModels : false,
    loadModels,
    isCompacting,
    compactionError,
    sessions: {
      current: activeSession,
      list: sessionSummaries,
      load: loadSession,
      newSession,
      delete: deleteSession,
      rename: renameSession,
      fork: forkSession,
      navigateToLeaf,
      compactNow,
      messageMeta,
      messageEntryIds,
    },
  };
}
