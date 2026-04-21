import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDirectState, useBodhi } from '@bodhiapp/bodhi-js-react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import { getErrorMessage } from '@/lib/utils';
import { useWebAgent } from '@/providers/web-agent-context';
import { useSessionsList } from '@/hooks/useSessionsList';
import { BODHI_PROVIDER_TAG } from '@/worker-bodhi';
import type { McpToolDescriptor, ToolCallHandler } from '@/worker-agent';
import type { UiMessageMeta } from '@/worker-agent/core/session/types';
import {
  BUILTIN_COMMAND_NAMES,
  BUILTIN_SLASH_COMMANDS,
} from '@/worker-agent/core/commands/slash-commands';
import { nextTransientId, type TransientMessage } from '@/types/transient-message';

const ACTIVE_SESSION_STORAGE_KEY = 'web-agent.activeSessionId';

interface ActiveSession {
  id: string;
  name?: string;
}

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: Model<Api>[] = [];
const EMPTY_TRANSIENT: TransientMessage[] = [];

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
  const [models, setModels] = useState<Model<Api>[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModelState] = useState<string>('');
  const [activeSession, setActiveSession] = useState<ActiveSession | null>(null);
  const [messageMeta, setMessageMeta] = useState<UiMessageMeta[]>([]);
  const [transientMessages, setTransientMessages] = useState<TransientMessage[]>([]);
  const sessionSummaries = useSessionsList();

  const messagesRef = useRef<AgentMessage[]>(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const pushTransient = useCallback(
    (input: { kind: TransientMessage['kind']; title?: string; text: string }): TransientMessage => {
      const msg: TransientMessage = {
        id: nextTransientId(),
        kind: input.kind,
        title: input.title,
        text: input.text,
        createdAt: Date.now(),
        afterMessageIndex: messagesRef.current.length,
      };
      setTransientMessages(prev => [...prev, msg]);
      return msg;
    },
    []
  );

  const clearTransient = useCallback(() => {
    setTransientMessages([]);
  }, []);

  const isLoadingModelsRef = useRef(false);
  const sessionBootRef = useRef(false);

  // Push the auth credential envelope to the Worker on every change.
  // The Worker's BodhiProvider captures the token; the next streamFn /
  // compaction / catalog-fetch call reads it synchronously via
  // `getApiKeyAndHeaders(model)` or `getAvailableModels()`.
  useEffect(() => {
    const state = bodhiClient.getState();
    const baseUrl = isDirectState(state) && state.url ? state.url : undefined;
    void rpcClient.setAuthToken({
      provider: BODHI_PROVIDER_TAG,
      baseUrl,
      token: auth.accessToken ?? null,
    });
  }, [auth.accessToken, bodhiClient, rpcClient]);

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
  // new active-session meta, persist the id for reload, and apply the
  // restored model identifier the envelope now carries directly — the
  // Worker resolves `{ provider, id }` server-side before emitting, so
  // the main thread no longer needs a follow-up `getState` round trip.
  useEffect(() => {
    return rpcClient.onSessionLoaded(event => {
      setMessages(event.messages);
      setMessageMeta(event.messageMeta);
      setStreamingMessage(undefined);
      setIsStreaming(false);
      setError(null);
      setTransientMessages([]);
      setActiveSession({ id: event.sessionId, name: event.name });
      if (typeof window !== 'undefined') {
        try {
          window.localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, event.sessionId);
        } catch {
          // localStorage disabled or full — fall back to in-memory only.
        }
      }
      if (event.model) {
        setSelectedModelState(event.model.id);
      }
    });
  }, [rpcClient]);

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
      // The Worker's BodhiProvider owns the fetch against `/bodhi/v1/models`
      // — we just consume the `Model<Api>[]` it returns. No main-thread
      // mapping / metadata fabrication here.
      const list = await rpcClient.getAvailableModels();
      setModels(list);
      // If no model has been selected yet (fresh session) and the Worker
      // didn't already hand us a restored identifier via `session_loaded`,
      // fall back to the first entry so the combobox isn't blank.
      setSelectedModelState(prev => {
        if (prev) return prev;
        return list[0]?.id ?? '';
      });
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(getErrorMessage(err, 'Failed to fetch models'));
    } finally {
      setIsLoadingModels(false);
      isLoadingModelsRef.current = false;
    }
  }, [isAuthenticated, rpcClient]);

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

  const setSelectedModel = useCallback((id: string) => {
    setSelectedModelState(id);
  }, []);

  /**
   * Dispatch a builtin slash command. Returns `true` when the command
   * was a builtin and was handled locally (caller should NOT fall
   * through to `rpcClient.prompt`). Returns `false` for non-builtins
   * — they flow to the Worker which expands matching prompt templates
   * or forwards raw text to the LLM, matching coding-agent behaviour.
   *
   * Feedback (confirmations, help listing, session info, errors) is
   * surfaced via `pushTransient` — frontend-only bubbles that are not
   * persisted to the session JSONL and reset to `[]` on reload.
   */
  const tryDispatchBuiltin = useCallback(
    async (text: string): Promise<boolean> => {
      if (!text.startsWith('/')) return false;
      const spaceIdx = text.indexOf(' ');
      const name = spaceIdx === -1 ? text.slice(1) : text.slice(1, spaceIdx);
      const args = spaceIdx === -1 ? '' : text.slice(spaceIdx + 1).trim();
      if (!BUILTIN_COMMAND_NAMES.has(name)) return false;

      try {
        switch (name) {
          case 'new':
            await rpcClient.newSession();
            return true;
          case 'compact':
            setCompactionError(null);
            await rpcClient.compactNow();
            pushTransient({ kind: 'info', title: '/compact', text: 'Compaction requested.' });
            return true;
          case 'name':
            if (args) {
              await rpcClient.setSessionName(args);
              pushTransient({
                kind: 'info',
                title: '/name',
                text: `Session renamed to "${args}".`,
              });
            } else {
              pushTransient({
                kind: 'error',
                title: '/name',
                text: 'Usage: /name <new session name>',
              });
            }
            return true;
          case 'reload': {
            const list = await rpcClient.reloadCommands();
            const promptCount = list.filter(c => c.source === 'prompt').length;
            const skillCount = list.filter(c => c.source === 'skill').length;
            pushTransient({
              kind: 'info',
              title: '/reload',
              text:
                `Reloaded prompt templates — ${promptCount} prompt template(s), ` +
                `${skillCount} skill(s) available.`,
            });
            return true;
          }
          case 'session': {
            const meta = await rpcClient.getSessionMeta();
            if (!meta) {
              pushTransient({
                kind: 'info',
                title: '/session',
                text: 'No active session.',
              });
              return true;
            }
            const lines = [
              `id:       ${meta.id}`,
              meta.name ? `name:     ${meta.name}` : null,
              `messages: ${messagesRef.current.length}`,
              meta.parentSession ? `parent:   ${meta.parentSession}` : null,
              meta.cwd ? `cwd:      ${meta.cwd}` : null,
            ].filter(Boolean);
            pushTransient({
              kind: 'info',
              title: '/session',
              text: lines.join('\n'),
            });
            return true;
          }
          case 'help': {
            const longest = BUILTIN_SLASH_COMMANDS.reduce(
              (acc, c) => Math.max(acc, c.name.length),
              0
            );
            const body = BUILTIN_SLASH_COMMANDS.map(
              c => `/${c.name.padEnd(longest)}  ${c.description}`
            ).join('\n');
            pushTransient({
              kind: 'info',
              title: 'Available commands',
              text: body,
            });
            return true;
          }
          case 'model': {
            if (!args) {
              const current = selectedModel || '(none)';
              const catalog = models.length
                ? models.map(m => `  ${m.id}`).join('\n')
                : '  (no models loaded — sign in to populate the catalog)';
              pushTransient({
                kind: 'info',
                title: '/model',
                text: `Current model: ${current}\n\nAvailable models:\n${catalog}\n\nUsage: /model <model-id>`,
              });
              return true;
            }
            const exact = models.find(m => m.id === args);
            if (exact) {
              setSelectedModelState(exact.id);
              try {
                await rpcClient.setModel(exact.provider, exact.id);
              } catch (err) {
                console.error('[useAgent] /model setModel failed:', err);
              }
              pushTransient({
                kind: 'info',
                title: '/model',
                text: `Model set to ${exact.id}.`,
              });
              return true;
            }
            const needle = args.toLowerCase();
            const matches = models.filter(m => m.id.toLowerCase().includes(needle));
            const suggestions = matches.length
              ? `\n\nDid you mean:\n${matches.map(m => `  ${m.id}`).join('\n')}`
              : '';
            pushTransient({
              kind: 'error',
              title: '/model',
              text: `Unknown model "${args}".${suggestions}`,
            });
            return true;
          }
          case 'fork':
            pushTransient({
              kind: 'info',
              title: '/fork',
              text: 'Hover over an assistant message and click the fork icon to fork from that point.',
            });
            return true;
          case 'tree':
            pushTransient({
              kind: 'info',
              title: '/tree',
              text: 'Session tree navigation is coming soon. Use /resume to switch sessions.',
            });
            return true;
          case 'resume':
            pushTransient({
              kind: 'info',
              title: '/resume',
              text: 'Open the session picker in the sidebar to resume a different session.',
            });
            return true;
          default:
            return false;
        }
      } catch (err) {
        console.error(`[useAgent] builtin /${name} failed:`, err);
        pushTransient({
          kind: 'error',
          title: `/${name}`,
          text: getErrorMessage(err, `Builtin command /${name} failed`),
        });
        return true;
      }
    },
    [rpcClient, pushTransient, selectedModel, models]
  );

  const sendMessage = useCallback(
    async (prompt: string) => {
      if (await tryDispatchBuiltin(prompt)) return;

      if (!selectedModel) {
        setError('Please select a model first');
        return;
      }
      const match = models.find(m => m.id === selectedModel);
      if (!match) {
        setError('Selected model is no longer available. Pick another model and retry.');
        return;
      }
      setError(null);

      // System prompt is owned by the worker (built from loaded skills
      // + vault cwd in `WorkerAgentHost.rebuildSystemPrompt`). Main
      // thread no longer pushes a blank prompt on every send.
      await rpcClient.setModel(match.provider, match.id);

      try {
        await rpcClient.prompt(prompt);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to send message:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      }
    },
    [tryDispatchBuiltin, selectedModel, models, rpcClient]
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
    setSelectedModel,
    sendMessage,
    stop,
    clearMessages,
    error: isAuthenticated ? error : null,
    clearError,
    transientMessages: isAuthenticated ? transientMessages : EMPTY_TRANSIENT,
    clearTransient,
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
