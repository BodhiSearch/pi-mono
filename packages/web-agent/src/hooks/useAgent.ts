import { useCallback, useEffect, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { getErrorMessage } from '@/lib/utils';
import { buildModel, getServerUrlOrThrow } from '@/lib/agent-model';
import { fetchBodhiModels, type BodhiModelInfo } from '@/lib/bodhi-models';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';
import { useWebAgent } from '@/providers/web-agent-context';
import type { McpToolDescriptor } from '@/web-agent';
import type { ToolCallHandler } from '@/web-agent';

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

  const isLoadingModelsRef = useRef(false);

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

      const serverUrl = getServerUrlOrThrow(bodhiClient.getState());
      const model = buildModel(selectedModel, serverUrl, selectedApiFormat);

      await rpcClient.setSystemPrompt('');
      await rpcClient.setModel(model);

      try {
        await rpcClient.prompt(prompt);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.error('Failed to send message:', err);
        setError(getErrorMessage(err, 'Failed to send message'));
      }
    },
    [bodhiClient, selectedModel, selectedApiFormat, rpcClient]
  );

  const stop = useCallback(() => {
    void rpcClient.abort();
  }, [rpcClient]);

  const clearMessages = useCallback(() => {
    void rpcClient.reset();
    setMessages([]);
    setStreamingMessage(undefined);
    setError(null);
  }, [rpcClient]);

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
