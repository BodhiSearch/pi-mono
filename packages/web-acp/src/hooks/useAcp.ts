import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpClient } from '@/acp/client';
import { buildFsHandlers } from '@/acp/fs-handlers';
import type { BodhiFeatureBag, BodhiModelDescriptor, BodhiSessionSummary } from '@/acp/index';
import { createMessagePortStream } from '@/transport/worker-stream';
import { createVolumeControl, type VolumeControl } from '@/transport/volume-control';
import { getErrorMessage } from '@/lib/utils';
import { getServerUrlOrThrow } from '@/lib/agent-model';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import type { VolumeInit } from '@/agent/volume-mount';
import { MainZenfs } from '@/vault/main-zenfs';
import { useVolumes, type UseVolumesResult } from '@/hooks/useVolumes';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];
const EMPTY_SESSIONS: BodhiSessionSummary[] = [];
const EMPTY_FEATURES: BodhiFeatureBag = {};
const EMPTY_TOOL_CALLS: ToolCallView[] = [];

export interface ToolCallView {
  toolCallId: string;
  toolName: string;
  title: string;
  status: 'in_progress' | 'completed' | 'failed' | 'pending';
  rawInput?: unknown;
  rawOutput?: unknown;
  text: string;
  turn: number;
}

interface AcpRuntime {
  worker: Worker;
  client: AcpClient;
  volumeControl: VolumeControl;
  mainZenfs: MainZenfs;
  initialize: Promise<void>;
  resolveInit: (volumes: VolumeInit[]) => void;
}

// StrictMode double-mounts every effect; keep the worker + client at
// module scope so we spawn exactly one agent worker for the tab.
let _runtime: AcpRuntime | null = null;
let _authKey: string | null = null;
let _authPromise: Promise<void> | null = null;
let _authModels: BodhiModelDescriptor[] = [];
let _session: string | null = null;
let _sessionPromise: Promise<string> | null = null;

function ensureRuntime(): AcpRuntime {
  if (_runtime) return _runtime;
  const worker = new Worker(new URL('../agent/agent-worker.ts', import.meta.url), {
    type: 'module',
  });
  const channel = new MessageChannel();
  // `init` is posted lazily once the main thread has resolved the
  // initial volume list (FSA handles + dev/test seeds). The
  // `ClientSideConnection` below would otherwise dispatch requests
  // into a worker that hasn't constructed the agent yet.
  let resolveInit!: (volumes: VolumeInit[]) => void;
  let initPosted = false;
  const mainZenfs = new MainZenfs();
  const initPromise = new Promise<void>(resolve => {
    resolveInit = (volumes: VolumeInit[]) => {
      if (initPosted) return;
      initPosted = true;
      // Mount duplicate backends on the main thread for the fs/*
      // client handler seam. We don't block ACP init on this — the
      // worker owns the source of truth and the handlers defensively
      // check membership on every call — but we do start mounting
      // immediately so handlers see the right entries by the time
      // an external ACP agent calls fs/readTextFile.
      void mainZenfs.mountAll(volumes);
      worker.postMessage({ type: 'init', agentPort: channel.port2, volumes }, [channel.port2]);
      resolve();
    };
  });
  const { readable, writable } = createMessagePortStream(channel.port1);
  const stream = ndJsonStream(writable, readable);

  const holder: { client?: AcpClient } = {};
  const fsHandlers = buildFsHandlers({ view: { list: () => mainZenfs.list() } });
  const handler: Client = {
    async requestPermission() {
      throw new Error('requestPermission: not supported in web-acp M0');
    },
    async sessionUpdate(params: SessionNotification) {
      holder.client?.dispatchSessionUpdate(params);
    },
    async readTextFile(params) {
      return fsHandlers.readTextFile(params);
    },
    async writeTextFile(params) {
      return fsHandlers.writeTextFile(params);
    },
  };
  const conn = new ClientSideConnection(() => handler, stream);
  const client = new AcpClient(conn);
  holder.client = client;

  const initialize = initPromise.then(() => client.initialize()).then(() => undefined);
  const volumeControl = wrapVolumeControl(createVolumeControl(worker), mainZenfs);
  _runtime = { worker, client, volumeControl, mainZenfs, initialize, resolveInit };
  return _runtime;
}

/**
 * Mirror worker-side mount/unmount onto the main-thread ZenFS so the
 * `fs/*` handlers stay in sync with the volume registry. Worker-side
 * mount is authoritative — main-thread failures are logged but never
 * surfaced to the caller since the handler falls through to a
 * membership check anyway.
 */
function wrapVolumeControl(inner: VolumeControl, mainZenfs: MainZenfs): VolumeControl {
  return {
    async mount(init) {
      await inner.mount(init);
      try {
        await mainZenfs.mount(init);
      } catch (err) {
        console.warn('[useAcp] main-zenfs mount failed:', err);
      }
    },
    async unmount(mountName) {
      await inner.unmount(mountName);
      try {
        await mainZenfs.unmount(mountName);
      } catch (err) {
        console.warn('[useAcp] main-zenfs unmount failed:', err);
      }
    },
    dispose() {
      inner.dispose();
    },
  };
}

function authKeyOf(token: string, baseUrl: string): string {
  return `${baseUrl}::${token}`;
}

function toBodhiModelInfo(model: BodhiModelDescriptor): BodhiModelInfo {
  return { id: model.id, apiFormat: model.apiFormat as ApiFormat };
}

function emptyAssistantMessage(): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: '' }],
  } as unknown as AgentMessage;
}

function getAssistantText(msg: AgentMessage): string {
  const content = (msg as unknown as { content: unknown }).content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type: unknown }).type === 'text' &&
      'text' in block
    ) {
      parts.push((block as { text: string }).text);
    }
  }
  return parts.join('');
}

function withAssistantText(msg: AgentMessage, text: string): AgentMessage {
  return {
    ...(msg as unknown as Record<string, unknown>),
    role: 'assistant',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

function userMessage(text: string): AgentMessage {
  return {
    role: 'user',
    content: [{ type: 'text', text }],
  } as unknown as AgentMessage;
}

function toolCallContentText(
  content:
    | Array<{ type?: unknown; content?: { type?: unknown; text?: unknown } }>
    | null
    | undefined
): string {
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (
      block &&
      block.type === 'content' &&
      block.content &&
      block.content.type === 'text' &&
      typeof block.content.text === 'string'
    ) {
      parts.push(block.content.text);
    }
  }
  return parts.join('\n');
}

function mapToolStatus(
  status: string | undefined
): 'in_progress' | 'completed' | 'failed' | 'pending' | undefined {
  if (status === 'in_progress' || status === 'completed' || status === 'failed') return status;
  if (status === 'pending') return 'pending';
  return undefined;
}

export function useAcp() {
  const { client: bodhiClient, auth, isAuthenticated, isReady } = useBodhi();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | undefined>(undefined);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<BodhiModelDescriptor[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModelState] = useState<string>('');
  const [selectedApiFormat, setSelectedApiFormat] = useState<ApiFormat>('openai');
  const [sessions, setSessions] = useState<BodhiSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [features, setFeatures] = useState<BodhiFeatureBag>({});
  const [featureDefaults, setFeatureDefaults] = useState<BodhiFeatureBag>({});
  const [toolCalls, setToolCalls] = useState<ToolCallView[]>([]);
  const toolCallsRef = useRef<Map<string, ToolCallView>>(new Map());
  const turnIndexRef = useRef(0);

  const streamingRef = useRef<AgentMessage | undefined>(undefined);
  const streamingMessageIdRef = useRef<string | undefined>(undefined);
  const loadingModelsRef = useRef(false);
  // When `session/load` is replaying stored notifications back at us, we
  // ignore them in the live stream handler — the UI rehydrates from
  // the `bodhi/getSession` snapshot instead, which is already the
  // collapsed transcript and has a defined `lastModelId`.
  const isReplayingRef = useRef(false);

  // Worker + client stay alive across re-renders; initialize once.
  useEffect(() => {
    ensureRuntime();
  }, []);

  const runtime = useMemo(() => ensureRuntime(), []);
  const volumeControl = runtime.volumeControl;

  const handleInitialVolumes = useCallback(
    (initial: VolumeInit[]) => {
      runtime.resolveInit(initial);
    },
    [runtime]
  );

  const volumes = useVolumes({ volumeControl, onInitialVolumes: handleInitialVolumes });

  // Route session/update → streaming message state.
  useEffect(() => {
    const runtime = ensureRuntime();
    const unsub = runtime.client.onSessionUpdate(notification => {
      if (isReplayingRef.current) return;
      const update = notification.update;
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        if (!content || content.type !== 'text') return;
        const delta = content.text ?? '';
        if (!delta) return;

        const messageId = update.messageId ?? undefined;
        if (messageId && messageId !== streamingMessageIdRef.current) {
          streamingMessageIdRef.current = messageId;
          streamingRef.current = emptyAssistantMessage();
        }

        const current = streamingRef.current ?? emptyAssistantMessage();
        const nextText = getAssistantText(current) + delta;
        const next = withAssistantText(current, nextText);
        streamingRef.current = next;
        setStreamingMessage(next);
        return;
      }
      if (update.sessionUpdate === 'tool_call') {
        const view: ToolCallView = {
          toolCallId: update.toolCallId,
          toolName: update.title?.split(':')[0] ?? 'tool',
          title: update.title ?? update.toolCallId,
          status: update.status === 'pending' ? 'pending' : 'in_progress',
          rawInput: update.rawInput,
          text: toolCallContentText(update.content),
          turn: turnIndexRef.current,
        };
        toolCallsRef.current.set(update.toolCallId, view);
        setToolCalls(Array.from(toolCallsRef.current.values()));
        return;
      }
      if (update.sessionUpdate === 'tool_call_update') {
        const existing = toolCallsRef.current.get(update.toolCallId);
        if (!existing) return;
        const next: ToolCallView = {
          ...existing,
          status: mapToolStatus(update.status) ?? existing.status,
          rawOutput: update.rawOutput ?? existing.rawOutput,
          text: update.content ? toolCallContentText(update.content) : existing.text,
        };
        toolCallsRef.current.set(update.toolCallId, next);
        setToolCalls(Array.from(toolCallsRef.current.values()));
        return;
      }
    });
    return unsub;
  }, []);

  useEffect(() => {
    if (!isReady) return;
    const token = auth.accessToken ?? null;
    const runtime = ensureRuntime();

    if (!token) {
      _authKey = null;
      _authPromise = null;
      _authModels = [];
      return;
    }

    loadingModelsRef.current = true;
    let cancelled = false;

    const run = async () => {
      setIsLoadingModels(true);
      setError(null);
      try {
        const serverUrl = getServerUrlOrThrow(bodhiClient.getState());
        const key = authKeyOf(token, serverUrl);
        if (key !== _authKey || !_authPromise) {
          _authKey = key;
          _authPromise = (async () => {
            await runtime.initialize;
            await runtime.client.authenticate({ token, baseUrl: serverUrl });
            _authModels = await runtime.client.listModels();
          })();
        }
        await _authPromise;
        if (cancelled) return;
        setModels(_authModels);
        if (_authModels.length > 0) {
          setSelectedModelState(prev => {
            if (prev && _authModels.some(m => m.id === prev)) return prev;
            const first = _authModels[0];
            setSelectedApiFormat(first.apiFormat as ApiFormat);
            return first.id;
          });
        }
      } catch (err) {
        console.error('ACP authenticate/listModels failed:', err);
        _authKey = null;
        _authPromise = null;
        if (!cancelled) {
          setError(getErrorMessage(err, 'Failed to connect to agent'));
        }
      } finally {
        loadingModelsRef.current = false;
        if (!cancelled) setIsLoadingModels(false);
      }
    };

    void run();
    return () => {
      cancelled = true;
    };
  }, [auth.accessToken, bodhiClient, isReady]);

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
      _authModels = list;
      setModels(list);
      if (list.length > 0) {
        setSelectedModelState(prev => {
          if (prev && list.some(m => m.id === prev)) return prev;
          const first = list[0];
          setSelectedApiFormat(first.apiFormat as ApiFormat);
          return first.id;
        });
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(getErrorMessage(err, 'Failed to fetch models'));
    } finally {
      setIsLoadingModels(false);
      loadingModelsRef.current = false;
    }
  }, [isAuthenticated]);

  const setSelectedModel = useCallback((id: string, fmt: ApiFormat) => {
    setSelectedModelState(id);
    setSelectedApiFormat(fmt);
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!isAuthenticated) {
      setSessions([]);
      return;
    }
    try {
      const runtime = ensureRuntime();
      await runtime.initialize;
      const list = await runtime.client.listSessions();
      setSessions(list);
    } catch (err) {
      console.error('bodhi/listSessions failed:', err);
    }
  }, [isAuthenticated]);

  // Refresh sessions once auth is in place; list persists across reload
  // because the worker writes to IndexedDB. `refreshSessions` already
  // clears state when unauthenticated.
  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await refreshSessions();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [refreshSessions]);

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
      if (!_session) return;
      const runtime = ensureRuntime();
      try {
        const payload = await runtime.client.setFeature(_session, key, value);
        setFeatures(payload.features ?? {});
      } catch (err) {
        console.error('_bodhi/features/set failed:', err);
        setError(getErrorMessage(err, 'Failed to toggle feature'));
        await refreshFeatures(_session);
      }
    },
    [refreshFeatures]
  );

  const ensureSession = useCallback(async (): Promise<string> => {
    if (_session) return _session;
    if (_sessionPromise) return _sessionPromise;
    const runtime = ensureRuntime();
    _sessionPromise = (async () => {
      await runtime.initialize;
      const response = await runtime.client.newSession();
      _session = response.sessionId;
      return _session;
    })();
    try {
      const id = await _sessionPromise;
      setCurrentSessionId(id);
      void refreshFeatures(id);
      return id;
    } finally {
      _sessionPromise = null;
    }
  }, [refreshFeatures]);

  // Ensure a session exists once auth lands so feature defaults are
  // fetched before the user interacts with the feature panel. This
  // also gives `_bodhi/features/set` a sessionId to write against.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (currentSessionId) return;
    let cancelled = false;
    const run = async () => {
      if (_authPromise) {
        try {
          await _authPromise;
        } catch {
          return;
        }
      }
      if (cancelled) return;
      try {
        await ensureSession();
      } catch (err) {
        console.error('auto-ensureSession failed:', err);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated, currentSessionId, ensureSession]);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const runtime = ensureRuntime();
      setError(null);
      setIsLoadingSession(true);
      isReplayingRef.current = true;
      streamingRef.current = undefined;
      streamingMessageIdRef.current = undefined;
      setStreamingMessage(undefined);
      try {
        await runtime.initialize;
        // If auth already landed we also want to ensure models are
        // loaded so the caller can re-select `lastModelId`.
        if (_authPromise) {
          try {
            await _authPromise;
          } catch {
            /* handled by auth effect */
          }
        }
        await runtime.client.loadSession(sessionId);
        const snapshot = await runtime.client.getSession(sessionId);
        _session = sessionId;
        setCurrentSessionId(sessionId);
        setMessages((snapshot.messages ?? []) as AgentMessage[]);
        void refreshFeatures(sessionId);
        toolCallsRef.current.clear();
        turnIndexRef.current = 0;
        setToolCalls([]);
        if (snapshot.lastModelId) {
          const match = _authModels.find(m => m.id === snapshot.lastModelId);
          if (match) {
            setSelectedModelState(match.id);
            setSelectedApiFormat(match.apiFormat as ApiFormat);
          }
        }
      } catch (err) {
        console.error('session/load failed:', err);
        setError(getErrorMessage(err, 'Failed to load session'));
      } finally {
        isReplayingRef.current = false;
        setIsLoadingSession(false);
      }
    },
    [refreshFeatures]
  );

  const sendMessage = useCallback(
    async (prompt: string) => {
      if (!selectedModel) {
        setError('Please select a model first');
        return;
      }
      const runtime = ensureRuntime();
      setError(null);

      // Wait for auth to land before sending the first prompt.
      if (_authPromise) {
        try {
          await _authPromise;
        } catch {
          // error surfaced by the auth effect; abort send
          return;
        }
      }

      turnIndexRef.current += 1;
      setMessages(prev => [...prev, userMessage(prompt)]);
      streamingRef.current = undefined;
      streamingMessageIdRef.current = undefined;
      setStreamingMessage(undefined);
      setIsStreaming(true);

      try {
        const sessionId = await ensureSession();
        const response = await runtime.client.prompt(sessionId, prompt, selectedModel);
        const finalMsg = streamingRef.current;
        if (finalMsg && response.stopReason !== 'cancelled') {
          setMessages(prev => [...prev, finalMsg]);
        }
        void refreshSessions();
      } catch (err) {
        console.error('session/prompt failed:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      } finally {
        streamingRef.current = undefined;
        streamingMessageIdRef.current = undefined;
        setStreamingMessage(undefined);
        setIsStreaming(false);
      }
    },
    [selectedModel, ensureSession, refreshSessions]
  );

  const stop = useCallback(() => {
    if (!_session) return;
    const runtime = ensureRuntime();
    void runtime.client.cancel(_session);
  }, []);

  const clearMessages = useCallback(() => {
    if (_session) {
      const runtime = ensureRuntime();
      void runtime.client.cancel(_session);
    }
    _session = null;
    streamingRef.current = undefined;
    streamingMessageIdRef.current = undefined;
    setMessages([]);
    setStreamingMessage(undefined);
    setError(null);
    setCurrentSessionId(null);
    setFeatures({});
    toolCallsRef.current.clear();
    turnIndexRef.current = 0;
    setToolCalls([]);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    if (isAuthenticated || !_session) return;
    let cancelled = false;
    const run = async () => {
      const runtime = ensureRuntime();
      try {
        await runtime.client.cancel(_session!);
      } catch {
        /* swallow — we're tearing down anyway */
      }
      _session = null;
      if (!cancelled) setCurrentSessionId(null);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  const displayModels = models.map(toBodhiModelInfo);

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
    models: isAuthenticated ? displayModels : EMPTY_MODELS,
    isLoadingModels: isAuthenticated ? isLoadingModels : false,
    loadModels,
    sessions: isAuthenticated ? sessions : EMPTY_SESSIONS,
    refreshSessions,
    loadSession,
    currentSessionId: isAuthenticated ? currentSessionId : null,
    isLoadingSession: isAuthenticated ? isLoadingSession : false,
    volumes,
    features: isAuthenticated ? features : EMPTY_FEATURES,
    featureDefaults,
    setFeature,
    toolCalls: isAuthenticated ? toolCalls : EMPTY_TOOL_CALLS,
  };
}

export type { UseVolumesResult };
