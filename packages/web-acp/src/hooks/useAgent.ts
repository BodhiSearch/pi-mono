import { useCallback, useEffect, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { AgentEvent, AgentMessage } from '@mariozechner/pi-agent-core';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { getErrorMessage } from '@/lib/utils';
import { getServerUrlOrThrow } from '@/lib/agent-model';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import { BODHI_PROVIDER_TAG, BodhiProvider, apiFormatOfModel } from '@/agent/bodhi-provider';
import { createStreamFn } from '@/agent/stream-fn';
import { createInlineAgent, type InlineAgent } from '@/agent/inline-agent';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];

// Singletons kept at module scope so the agent survives across
// `useBodhi()` re-renders in StrictMode.
let _provider: BodhiProvider | null = null;
let _agent: InlineAgent | null = null;
let _agentUnsub: (() => void) | null = null;

function getProvider(): BodhiProvider {
  if (!_provider) _provider = new BodhiProvider();
  return _provider;
}

function getAgent(): InlineAgent {
  if (!_agent) {
    _agent = createInlineAgent(createStreamFn(getProvider()));
  }
  return _agent;
}

function toBodhiModelInfo(model: Model<Api>): BodhiModelInfo {
  return { id: model.id, apiFormat: apiFormatOfModel(model) };
}

export function useAgent() {
  const { client, auth, isAuthenticated, isReady } = useBodhi();

  const [messages, setMessages] = useState<AgentMessage[]>([]);
  const [streamingMessage, setStreamingMessage] = useState<AgentMessage | undefined>(undefined);
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<Model<Api>[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [selectedModel, setSelectedModelState] = useState<string>('');
  const [selectedApiFormat, setSelectedApiFormat] = useState<ApiFormat>('openai');

  const isLoadingModelsRef = useRef(false);

  // Rotate the Bodhi token into the provider whenever it changes.
  useEffect(() => {
    const provider = getProvider();
    const serverUrl = isReady ? getServerUrlOrThrow(client.getState()) : undefined;
    if (auth.accessToken && serverUrl) {
      provider.setAuthToken({
        provider: BODHI_PROVIDER_TAG,
        token: auth.accessToken,
        baseUrl: serverUrl,
      });
    } else {
      provider.setAuthToken(null);
    }
  }, [auth.accessToken, client, isReady]);

  useEffect(() => {
    const agent = getAgent();
    _agentUnsub?.();
    _agentUnsub = agent.subscribe((event: AgentEvent) => {
      switch (event.type) {
        case 'agent_start':
          setIsStreaming(true);
          setError(null);
          break;
        case 'message_update':
          setMessages(agent.getMessages());
          setStreamingMessage(event.message);
          break;
        case 'message_end':
          setMessages(agent.getMessages());
          setStreamingMessage(undefined);
          break;
        case 'turn_end':
          setMessages(agent.getMessages());
          break;
        case 'agent_end':
          setMessages(agent.getMessages());
          setStreamingMessage(undefined);
          setIsStreaming(false);
          {
            const errMsg = agent.getErrorMessage();
            if (errMsg) setError(errMsg);
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
      const list = await getProvider().getAvailableModels();
      setModels(list);
      if (list.length > 0 && !selectedModel) {
        const first = list[0];
        setSelectedModelState(first.id);
        setSelectedApiFormat(apiFormatOfModel(first));
      }
    } catch (err) {
      console.error('Failed to fetch models:', err);
      setError(getErrorMessage(err, 'Failed to fetch models'));
    } finally {
      setIsLoadingModels(false);
      isLoadingModelsRef.current = false;
    }
  }, [isAuthenticated, selectedModel]);

  useEffect(() => {
    if (isReady && isAuthenticated && models.length === 0 && !isLoadingModelsRef.current) {
      loadModels();
    }
  }, [isReady, isAuthenticated, models.length, loadModels]);

  useEffect(() => {
    if (!isAuthenticated) _agent?.cancel();
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

      const match = models.find(m => m.id === selectedModel);
      if (!match) {
        setError('Selected model is not in the current catalog');
        return;
      }

      const agent = getAgent();
      agent.setModel(match);

      try {
        await agent.prompt(prompt);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to send message:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      }
    },
    [models, selectedModel]
  );

  const stop = useCallback(() => {
    _agent?.cancel();
  }, []);

  const clearMessages = useCallback(() => {
    _agent?.clearMessages();
    setMessages([]);
    setStreamingMessage(undefined);
    setError(null);
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

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
