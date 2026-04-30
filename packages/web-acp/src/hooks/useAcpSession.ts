import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { McpServerHttp } from '@agentclientprotocol/sdk';
import type { BodhiModelDescriptor, BodhiSessionSummary } from '@/acp/index';
import {
  ensureRuntime,
  getAuthModels,
  getAuthPromise,
  getSession,
  getSessionPromise,
  setSession,
  setSessionPromise,
} from '@/acp/runtime';
import { composeSessionMeta } from '@/acp/session-meta';
import type { StreamingAction } from '@/acp/streaming-reducer';
import { getErrorMessage } from '@/lib/utils';
import type { McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import type { McpInstanceView } from '@/mcp/types';

const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;

export interface UseAcpSessionResult {
  sessions: BodhiSessionSummary[];
  currentSessionId: string | null;
  isLoadingSession: boolean;
  refreshSessions: () => Promise<void>;
  ensureSession: () => Promise<string>;
  loadSession: (sessionId: string) => Promise<void>;
  clearMessages: () => void;
  deleteSession: (sessionId: string) => Promise<void>;
}

export interface UseAcpSessionDeps {
  isAuthenticated: boolean;
  mcpInstancesIsReady: boolean;
  composeCurrentMcpServers: (toggles?: McpToggleSnapshot) => McpServerHttp[];
  requestedMcpUrlsRef: MutableRefObject<string[]>;
  mcpInstancesRef: MutableRefObject<McpInstanceView[]>;
  streamingDispatch: Dispatch<StreamingAction>;
  refreshFeatures: (sessionId: string) => Promise<void>;
  clearFeatures: () => void;
  applyLastModel: (lastModelId: string, list: BodhiModelDescriptor[]) => void;
  setMcpToggles: (toggles: McpToggleSnapshot) => void;
  setError: (msg: string | null) => void;
}

/**
 * Owns the ACP session lifecycle on the host side: `session/new`
 * (`ensureSession`), `session/load` with snapshot rehydration
 * (`loadSession`), `session/cancel` + state reset (`clearMessages`),
 * `_bodhi/sessions/delete` (`deleteSession`), and the
 * `bodhi/listSessions` mirror (`refreshSessions`). Cross-hook
 * coordination flows through `streamingDispatch` (`load-start` /
 * `load-end` / `reset`) and the injected mutators for features /
 * MCP toggles.
 */
export function useAcpSession(deps: UseAcpSessionDeps): UseAcpSessionResult {
  const {
    isAuthenticated,
    mcpInstancesIsReady,
    composeCurrentMcpServers,
    requestedMcpUrlsRef,
    mcpInstancesRef,
    streamingDispatch,
    refreshFeatures,
    clearFeatures,
    applyLastModel,
    setMcpToggles,
    setError,
  } = deps;

  const [sessions, setSessions] = useState<BodhiSessionSummary[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [isLoadingSession, setIsLoadingSession] = useState(false);

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

  const ensureSession = useCallback(async (): Promise<string> => {
    const existing = getSession();
    if (existing) return existing;
    const pending = getSessionPromise();
    if (pending) return pending;
    const runtime = ensureRuntime();
    const promise = (async () => {
      await runtime.initialize;
      // Fresh session: no stored toggles yet so everything defaults to on.
      const servers = composeCurrentMcpServers();
      const sessionMeta = composeSessionMeta(requestedMcpUrlsRef.current, mcpInstancesRef.current);
      const response = await runtime.client.newSession(servers, sessionMeta);
      setSession(response.sessionId);
      return response.sessionId;
    })();
    setSessionPromise(promise);
    try {
      const id = await promise;
      setCurrentSessionId(id);
      setMcpToggles(EMPTY_MCP_TOGGLES);
      void refreshFeatures(id);
      return id;
    } finally {
      setSessionPromise(null);
    }
  }, [
    composeCurrentMcpServers,
    refreshFeatures,
    setMcpToggles,
    requestedMcpUrlsRef,
    mcpInstancesRef,
  ]);

  // Ensure a session exists once auth lands so feature defaults are
  // fetched before the user interacts with the feature panel. This
  // also gives `_bodhi/features/set` a sessionId to write against.
  //
  // The MCP instances fetch kicks off from `useMcpInstances` at the
  // same moment auth lands. We gate `ensureSession` on `isReady` —
  // which is cleared synchronously the instant auth flips — so the
  // worker pool receives the composed `McpServerHttp[]` on the very
  // first `session/new`. Fetch failures still flip `isReady: true`
  // with an empty list, so the gate never deadlocks.
  useEffect(() => {
    if (!isAuthenticated) return;
    if (currentSessionId) return;
    if (!mcpInstancesIsReady) return;
    let cancelled = false;
    const run = async () => {
      const authPromise = getAuthPromise();
      if (authPromise) {
        try {
          await authPromise;
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
  }, [isAuthenticated, currentSessionId, ensureSession, mcpInstancesIsReady]);

  const loadSession = useCallback(
    async (sessionId: string) => {
      const runtime = ensureRuntime();
      setError(null);
      setIsLoadingSession(true);
      streamingDispatch({ type: 'load-start' });
      try {
        await runtime.initialize;
        // If auth already landed we also want to ensure models are
        // loaded so the caller can re-select `lastModelId`.
        const authPromise = getAuthPromise();
        if (authPromise) {
          try {
            await authPromise;
          } catch {
            /* handled by auth effect */
          }
        }
        // Fetch the persisted snapshot (messages + lastModelId + toggles)
        // *before* `session/load` so we can filter the composed
        // `mcpServers` with the stored per-session toggles. `getSession`
        // reads straight from Dexie — it does not require the session
        // to be resident in the worker's in-memory map.
        const snapshot = await runtime.client.getSession(sessionId);
        const toggles = snapshot.mcpToggles ?? { servers: {}, tools: {} };
        const servers = composeCurrentMcpServers(toggles);
        const sessionMeta = composeSessionMeta(
          requestedMcpUrlsRef.current,
          mcpInstancesRef.current
        );
        await runtime.client.loadSession(sessionId, servers, sessionMeta);
        setSession(sessionId);
        setCurrentSessionId(sessionId);
        setMcpToggles(toggles);
        void refreshFeatures(sessionId);
        streamingDispatch({
          type: 'load-end',
          messages: (snapshot.messages ?? []) as AgentMessage[],
        });
        if (snapshot.lastModelId) {
          applyLastModel(snapshot.lastModelId, getAuthModels());
        }
      } catch (err) {
        console.error('session/load failed:', err);
        setError(getErrorMessage(err, 'Failed to load session'));
        streamingDispatch({ type: 'load-end' });
      } finally {
        setIsLoadingSession(false);
      }
    },
    [
      composeCurrentMcpServers,
      refreshFeatures,
      applyLastModel,
      streamingDispatch,
      setMcpToggles,
      setError,
      requestedMcpUrlsRef,
      mcpInstancesRef,
    ]
  );

  const clearMessages = useCallback(() => {
    const sessionId = getSession();
    if (sessionId) {
      const runtime = ensureRuntime();
      void runtime.client.cancel(sessionId);
    }
    setSession(null);
    setError(null);
    setCurrentSessionId(null);
    clearFeatures();
    setMcpToggles(EMPTY_MCP_TOGGLES);
    streamingDispatch({ type: 'reset' });
  }, [clearFeatures, streamingDispatch, setMcpToggles, setError]);

  const deleteSession = useCallback(
    async (sessionId: string) => {
      const runtime = ensureRuntime();
      try {
        await runtime.initialize;
        const isActive = sessionId === getSession();
        if (isActive) {
          // Cancel any in-flight prompt before the row is destroyed
          // so a late stream chunk can't reattach to a phantom row.
          try {
            await runtime.client.cancel(sessionId);
          } catch {
            /* swallow — worker may already have torn the session down */
          }
          clearMessages();
        }
        await runtime.client.deleteSession(sessionId);
      } catch (err) {
        console.error('_bodhi/sessions/delete failed:', err);
        setError(getErrorMessage(err, 'Failed to delete session'));
      } finally {
        await refreshSessions();
      }
    },
    [clearMessages, refreshSessions, setError]
  );

  // Auth-loss teardown: cancel any in-flight prompt and forget the
  // active session. The `isAuthenticated ? X : EMPTY_*` gating in the
  // facade masks the rest of the UI on its own.
  useEffect(() => {
    if (isAuthenticated || !getSession()) return;
    let cancelled = false;
    const run = async () => {
      const runtime = ensureRuntime();
      const sessionId = getSession();
      if (sessionId) {
        try {
          await runtime.client.cancel(sessionId);
        } catch {
          /* swallow — we're tearing down anyway */
        }
      }
      setSession(null);
      if (!cancelled) setCurrentSessionId(null);
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [isAuthenticated]);

  return {
    sessions,
    currentSessionId,
    isLoadingSession,
    refreshSessions,
    ensureSession,
    loadSession,
    clearMessages,
    deleteSession,
  };
}
