import { useReducer, useState } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import type { BodhiFeatureBag, BodhiSessionSummary } from '@/acp/index';
import { toBodhiModelInfo } from '@/acp/session-meta';
import {
  initialStreamingState,
  streamingReducer,
  type ToolCallView,
} from '@/acp/streaming-reducer';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import type { McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import type { McpConnectionMeta, McpInstanceView } from '@/mcp/types';
import { useMcpInstances } from '@/mcp/useMcpInstances';
import { useAcpAuth } from '@/hooks/useAcpAuth';
import { useAcpFeatures } from '@/hooks/useAcpFeatures';
import { useAcpMcp } from '@/hooks/useAcpMcp';
import { useAcpModels } from '@/hooks/useAcpModels';
import { useAcpRuntime } from '@/hooks/useAcpRuntime';
import { useAcpSession } from '@/hooks/useAcpSession';
import { useAcpStreaming } from '@/hooks/useAcpStreaming';
import { type UseVolumesResult } from '@/hooks/useVolumes';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];
const EMPTY_SESSIONS: BodhiSessionSummary[] = [];
const EMPTY_FEATURES: BodhiFeatureBag = {};
const EMPTY_TOOL_CALLS: ToolCallView[] = [];
const EMPTY_MCP_STATES: Record<string, McpConnectionMeta> = {};
const EMPTY_MCP_INSTANCES: McpInstanceView[] = [];
const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;
const EMPTY_AVAILABLE_COMMANDS: readonly AvailableCommand[] = Object.freeze([]);

export type { ToolCallView } from '@/acp/streaming-reducer';
export type { UseVolumesResult };

/**
 * Top-level facade for the host-side ACP wire. Composes the per-
 * concern slice hooks and applies the `isAuthenticated ? real :
 * EMPTY_*` gating in one place so consumers see empty fields the
 * instant auth flips rather than stale state from a previous login.
 *
 * See `ai-docs/web-acp/specs/web-acp-client/` for the engine-split
 * architecture; the wire surface is byte-identical to the pre-split
 * implementation.
 */
export function useAcp() {
  const { isAuthenticated } = useBodhi();
  const mcpInstances = useMcpInstances();

  const [error, setError] = useState<string | null>(null);

  const {
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
  } = useAcpModels(isAuthenticated, setError);

  const { features, featureDefaults, refreshFeatures, setFeature, clearFeatures } =
    useAcpFeatures(setError);

  const { volumes } = useAcpRuntime();

  const {
    mcpToggles,
    setMcpToggles,
    setMcpToggle,
    composeCurrentMcpServers,
    dispatchAction,
    mcpInstancesRef,
    mcpTogglesRef,
    requestedMcpUrlsRef,
  } = useAcpMcp({ setError, mcpInstances });

  useAcpAuth({
    setError,
    setModels,
    setIsLoadingModels,
    ensureDefaultModel,
    loadingModelsRef,
    mcpInstancesRef,
    mcpTogglesRef,
    requestedMcpUrlsRef,
  });

  const [streamingState, streamingDispatch] = useReducer(streamingReducer, initialStreamingState);

  const {
    sessions,
    currentSessionId,
    isLoadingSession,
    refreshSessions,
    ensureSession,
    loadSession,
    clearMessages,
    deleteSession,
  } = useAcpSession({
    isAuthenticated,
    mcpInstancesIsReady: mcpInstances.isReady,
    composeCurrentMcpServers,
    requestedMcpUrlsRef,
    mcpInstancesRef,
    streamingDispatch,
    refreshFeatures,
    clearFeatures,
    applyLastModel,
    setMcpToggles,
    setError,
  });

  const { sendMessage, stop, clearError } = useAcpStreaming({
    state: streamingState,
    dispatch: streamingDispatch,
    ensureSession,
    refreshSessions,
    dispatchAction,
    selectedModel,
    setError,
  });

  const messages = streamingState.messages;
  const streamingMessage = streamingState.streamingMessage;
  const isStreaming = streamingState.isStreaming;
  const toolCalls = Array.from(streamingState.toolCalls.values());
  const availableCommands = streamingState.availableCommands;
  const mcpStates = streamingState.mcpStates;

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
    deleteSession,
    currentSessionId: isAuthenticated ? currentSessionId : null,
    isLoadingSession: isAuthenticated ? isLoadingSession : false,
    volumes,
    features: isAuthenticated ? features : EMPTY_FEATURES,
    featureDefaults,
    setFeature,
    toolCalls: isAuthenticated ? toolCalls : EMPTY_TOOL_CALLS,
    availableCommands: isAuthenticated ? availableCommands : EMPTY_AVAILABLE_COMMANDS,
    mcp: {
      instances: isAuthenticated ? mcpInstances.instances : EMPTY_MCP_INSTANCES,
      states: isAuthenticated ? mcpStates : EMPTY_MCP_STATES,
      toggles: isAuthenticated ? mcpToggles : EMPTY_MCP_TOGGLES,
      isLoading: mcpInstances.isLoading,
      error: mcpInstances.error,
      refresh: mcpInstances.refresh,
      setToggle: setMcpToggle,
    },
  };
}
