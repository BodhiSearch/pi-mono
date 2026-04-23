import { useCallback, useEffect, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';
import type { Client, SessionNotification } from '@agentclientprotocol/sdk';
import { AcpClient } from '@/acp/client';
import type { BodhiModelDescriptor } from '@/acp/index';
import { createMessagePortStream } from '@/transport/worker-stream';
import { getErrorMessage } from '@/lib/utils';
import { getServerUrlOrThrow } from '@/lib/agent-model';
import type { BodhiModelInfo } from '@/lib/bodhi-models';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];

interface AcpRuntime {
  worker: Worker;
  client: AcpClient;
  initialize: Promise<void>;
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
  worker.postMessage({ type: 'init', agentPort: channel.port2 }, [channel.port2]);
  const { readable, writable } = createMessagePortStream(channel.port1);
  const stream = ndJsonStream(writable, readable);

  const holder: { client?: AcpClient } = {};
  const handler: Client = {
    async requestPermission() {
      throw new Error('requestPermission: not supported in web-acp M0');
    },
    async sessionUpdate(params: SessionNotification) {
      holder.client?.dispatchSessionUpdate(params);
    },
  };
  const conn = new ClientSideConnection(() => handler, stream);
  const client = new AcpClient(conn);
  holder.client = client;

  const initialize = client.initialize().then(() => undefined);
  _runtime = { worker, client, initialize };
  return _runtime;
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

  const streamingRef = useRef<AgentMessage | undefined>(undefined);
  const streamingMessageIdRef = useRef<string | undefined>(undefined);
  const loadingModelsRef = useRef(false);

  // Worker + client stay alive across re-renders; initialize once.
  useEffect(() => {
    ensureRuntime();
  }, []);

  // Route session/update → streaming message state.
  useEffect(() => {
    const runtime = ensureRuntime();
    const unsub = runtime.client.onSessionUpdate(notification => {
      const update = notification.update;
      if (update.sessionUpdate !== 'agent_message_chunk') return;
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
      return await _sessionPromise;
    } finally {
      _sessionPromise = null;
    }
  }, []);

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
    [selectedModel, ensureSession]
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
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  useEffect(() => {
    if (!isAuthenticated && _session) {
      const runtime = ensureRuntime();
      void runtime.client.cancel(_session);
      _session = null;
    }
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
  };
}
