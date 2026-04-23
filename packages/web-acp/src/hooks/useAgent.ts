import { useCallback, useEffect, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import { streamSimple } from '@mariozechner/pi-ai';
import { Agent } from '@mariozechner/pi-agent-core';
import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '@mariozechner/pi-agent-core';
import { getErrorMessage } from '@/lib/utils';
import { buildModel, getServerUrlOrThrow } from '@/lib/agent-model';
import { fetchBodhiModels, type BodhiModelInfo } from '@/lib/bodhi-models';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';

const SENTINEL_API_KEY = 'bodhiapp_sentinel_api_key_ignored';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];

let _agent: Agent | null = null;
let _agentUnsub: (() => void) | null = null;
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

function getOrCreateAgent(): Agent {
  if (!_agent) {
    _agent = new Agent({
      streamFn: getStreamFn(),
      getApiKey: () => SENTINEL_API_KEY,
    });
  }
  return _agent;
}

export function useAgent(tools: AgentTool[]) {
  const { client, auth, isAuthenticated, isReady } = useBodhi();

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
    const agent = getOrCreateAgent();
    _agentUnsub?.();
    _agentUnsub = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          setIsStreaming(true);
          setError(null);
          break;
        case 'message_update':
          setMessages([...agent.state.messages]);
          setStreamingMessage(event.message);
          break;
        case 'message_end':
          setMessages([...agent.state.messages]);
          setStreamingMessage(undefined);
          break;
        case 'turn_end':
          setMessages([...agent.state.messages]);
          break;
        case 'agent_end':
          setMessages([...agent.state.messages]);
          setStreamingMessage(undefined);
          setIsStreaming(false);
          if (agent.state.errorMessage) {
            setError(agent.state.errorMessage);
          }
          break;
      }
    });
    return () => {
      _agentUnsub?.();
      _agentUnsub = null;
    };
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
      const list = await fetchBodhiModels(client);
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
  }, [client, isAuthenticated, selectedModel]);

  useEffect(() => {
    if (isReady && isAuthenticated && models.length === 0 && !isLoadingModelsRef.current) {
      loadModels();
    }
  }, [isReady, isAuthenticated, models.length, loadModels]);

  useEffect(() => {
    if (!isAuthenticated) {
      _agent?.abort();
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

      const serverUrl = getServerUrlOrThrow(client.getState());
      const agent = getOrCreateAgent();
      agent.state.model = buildModel(selectedModel, serverUrl, selectedApiFormat);
      agent.state.tools = toolsRef.current;
      agent.state.systemPrompt = '';

      try {
        await agent.prompt(prompt);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to send message:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      }
    },
    [client, selectedModel, selectedApiFormat]
  );

  const stop = useCallback(() => {
    _agent?.abort();
  }, []);

  const clearMessages = useCallback(() => {
    _agent?.abort();
    if (_agent) _agent.state.messages = [];
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
