import { useCallback, useEffect, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import { streamSimple } from '@mariozechner/pi-ai';
import type { AgentMessage, AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import { getErrorMessage } from '@/lib/utils';
import { buildModel, getServerUrlOrThrow } from '@/lib/agent-model';
import { fetchBodhiModels, type BodhiModelInfo } from '@/lib/bodhi-models';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { AgentSession, createInProcessTransportPair, RpcClient, RpcServer } from '@/web-agent';

const SENTINEL_API_KEY = 'bodhiapp_sentinel_api_key_ignored';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];

let _session: AgentSession | null = null;
let _rpcClient: RpcClient | null = null;
let _tokenGetter: () => string | null = () => null;

function getStreamFn(): StreamFn {
  return (model, context, options) => {
    const token = _tokenGetter();
    const headers = token
      ? { ...model.headers, Authorization: `Bearer ${token}`, 'x-api-key': token }
      : model.headers;
    const patchedModel = headers !== model.headers ? { ...model, headers } : model;
    return streamSimple(patchedModel, context, options);
  };
}

function ensureSession(): { session: AgentSession; rpcClient: RpcClient } {
  if (!_session || !_rpcClient) {
    _session = new AgentSession({
      streamFn: getStreamFn(),
      getApiKey: () => SENTINEL_API_KEY,
    });
    const { client, server } = createInProcessTransportPair();
    // Server retains itself via the transport's event-listener closure —
    // we don't need to hold a reference to prevent GC.
    new RpcServer(server, _session);
    _rpcClient = new RpcClient(client);
  }
  return { session: _session, rpcClient: _rpcClient };
}

export function useAgent(tools: AgentTool[]) {
  const { client: bodhiClient, auth, isAuthenticated, isReady } = useBodhi();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | undefined>(undefined);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<BodhiModelInfo[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModelState] = useState<string>('');
  const [selectedApiFormat, setSelectedApiFormat] = useState<ApiFormat>('openai');

  const authTokenRef = useRef<string | null>(auth.accessToken);
  const toolsRef = useRef<AgentTool[]>(tools);
  const isLoadingModelsRef = useRef(false);

  useEffect(() => {
    authTokenRef.current = auth.accessToken;
    _tokenGetter = () => authTokenRef.current;
  }, [auth.accessToken]);

  useEffect(() => {
    toolsRef.current = tools;
  }, [tools]);

  useEffect(() => {
    const { rpcClient } = ensureSession();
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
  }, []);

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
      if (list.length > 0 && !selectedModel) {
        setSelectedModelState(list[0].id);
        setSelectedApiFormat(list[0].apiFormat);
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(getErrorMessage(err, 'Failed to fetch models'));
    } finally {
      setIsLoadingModels(false);
      isLoadingModelsRef.current = false;
    }
  }, [bodhiClient, isAuthenticated, selectedModel]);

  useEffect(() => {
    if (isReady && isAuthenticated && models.length === 0 && !isLoadingModelsRef.current) {
      loadModels();
    }
  }, [isReady, isAuthenticated, models.length, loadModels]);

  useEffect(() => {
    if (!isAuthenticated) {
      void _rpcClient?.abort();
    }
  }, [isAuthenticated]);

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

      const serverUrl = getServerUrlOrThrow(bodhiClient.getState());
      const { session, rpcClient } = ensureSession();
      const model = buildModel(selectedModel, serverUrl, selectedApiFormat);

      // Host-side configuration: tools carry non-cloneable execute closures,
      // so they bypass RPC and are set directly on the session. Phase 4 will
      // replace this with a MessagePort-backed ProxyTool pattern.
      session.setTools(toolsRef.current);
      session.setSystemPrompt('');

      await rpcClient.setModel(model);

      try {
        await rpcClient.prompt(prompt);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to send message:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      }
    },
    [bodhiClient, selectedModel, selectedApiFormat]
  );

  const stop = useCallback(() => {
    void _rpcClient?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    void _rpcClient?.reset();
    setMessages([]);
    setStreamingMessage(undefined);
    setError(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

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
  };
}
