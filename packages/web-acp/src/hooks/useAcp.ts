import { useCallback, useMemo, useReducer, useState } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import {
  EMPTY_AVAILABLE_COMMANDS,
  EMPTY_MCP_STATES,
  EMPTY_MCP_TOGGLES,
  type SessionInfoView,
} from '@/acp/index';
import {
  type FeatureBag,
  FEATURE_KEY_BY_CONFIG_ID,
  FEATURE_KEY_TO_CONFIG_ID,
} from '@/acp/feature-keys';
import { initialPanelsState, panelsReducer } from '@/acp/panels-reducer';
import { ensureRuntime, getSession } from '@/acp/runtime';
import {
  type AcpAction,
  initialStreamingState,
  streamingReducer,
  type ToolCallView,
} from '@/acp/streaming-reducer';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import { getErrorMessage } from '@/lib/utils';
import type { McpInstanceView } from '@/mcp/types';
import { useMcpInstances } from '@/mcp/useMcpInstances';
import { useAcpAuth } from '@/hooks/useAcpAuth';
import { useAcpMcp } from '@/hooks/useAcpMcp';
import { useAcpModels } from '@/hooks/useAcpModels';
import { useAcpRuntime } from '@/hooks/useAcpRuntime';
import { useAcpSession } from '@/hooks/useAcpSession';
import { useAcpStreaming } from '@/hooks/useAcpStreaming';
import { type UseVolumesResult } from '@/hooks/useVolumes';

const EMPTY_MESSAGES: AgentMessage[] = [];
const EMPTY_MODELS: BodhiModelInfo[] = [];
const EMPTY_SESSIONS: SessionInfoView[] = [];
const EMPTY_FEATURES: FeatureBag = {};
const EMPTY_TOOL_CALLS: ToolCallView[] = [];
const EMPTY_MCP_INSTANCES: McpInstanceView[] = [];

export type { ToolCallView } from '@/acp/streaming-reducer';
export type { UseVolumesResult };

/**
 * Top-level facade for the host-side ACP wire. Composes the per-
 * concern slice hooks and applies the `isAuthenticated ? real :
 * EMPTY_*` gating in one place so consumers see empty fields the
 * instant auth flips rather than stale state from a previous login.
 */
export function useAcp() {
  const { isAuthenticated } = useBodhi();
  const mcpInstances = useMcpInstances();

  const [error, setError] = useState<string | null>(null);

  const { models, selectedModel, setSelectedModel, hydrateFromSessionResponse } =
    useAcpModels(setError);

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
    mcpInstancesRef,
    mcpTogglesRef,
    requestedMcpUrlsRef,
    mcpInstancesIsReady: mcpInstances.isReady,
  });

  const [streamingState, dispatchStreaming] = useReducer(streamingReducer, initialStreamingState);
  const [panelsState, dispatchPanels] = useReducer(panelsReducer, initialPanelsState);
  const dispatch = useCallback<React.Dispatch<AcpAction>>((action: AcpAction) => {
    dispatchStreaming(action);
    dispatchPanels(action);
  }, []);

  const features = useMemo<FeatureBag>(() => {
    const out: FeatureBag = {};
    for (const opt of panelsState.configOptions) {
      const featureKey = FEATURE_KEY_BY_CONFIG_ID[opt.id];
      if (!featureKey) continue;
      // Accept both stable `select` and legacy unstable `boolean` shapes so a stale agent build doesn't break the toggle UI.
      if (opt.type === 'select') {
        out[featureKey] = opt.currentValue === 'on';
      } else if (opt.type === 'boolean') {
        out[featureKey] = Boolean(opt.currentValue);
      }
    }
    return out;
  }, [panelsState.configOptions]);

  const setFeature = useCallback(
    async (key: string, value: boolean) => {
      const sessionId = getSession();
      if (!sessionId) return;
      const configId = FEATURE_KEY_TO_CONFIG_ID[key];
      if (!configId) return;
      try {
        await ensureRuntime().client.setSessionConfigOption(
          sessionId,
          configId,
          value ? 'on' : 'off'
        );
      } catch (err) {
        console.error('setSessionConfigOption failed:', err);
        setError(getErrorMessage(err, 'Failed to toggle feature'));
      }
    },
    [setError]
  );

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
    streamingDispatch: dispatch,
    hydrateModelsFromSessionResponse: hydrateFromSessionResponse,
    setMcpToggles,
    setError,
  });

  const { sendMessage, stop, clearError } = useAcpStreaming({
    state: streamingState,
    dispatch,
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
  const availableCommands = panelsState.availableCommands;
  const mcpStates = panelsState.mcpStates;

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
    models: isAuthenticated ? models : EMPTY_MODELS,
    sessions: isAuthenticated ? sessions : EMPTY_SESSIONS,
    refreshSessions,
    loadSession,
    deleteSession,
    currentSessionId: isAuthenticated ? currentSessionId : null,
    isLoadingSession: isAuthenticated ? isLoadingSession : false,
    volumes,
    features: isAuthenticated ? features : EMPTY_FEATURES,
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
