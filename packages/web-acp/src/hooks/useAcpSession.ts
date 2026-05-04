import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Dispatch, MutableRefObject } from 'react';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type {
  LoadSessionResponse,
  McpServerHttp,
  NewSessionResponse,
} from '@agentclientprotocol/sdk';
import { EMPTY_MCP_TOGGLES, type BodhiLoadSessionMeta, type SessionInfoView } from '@/acp/index';
import {
  ensureRuntime,
  getAuthPromise,
  getSession,
  getSessionPromise,
  setModelUpdatePromise,
  setSession,
  setSessionPromise,
  subscribeToSession,
} from '@/acp/runtime';
import { composeSessionMeta } from '@/acp/session-meta';
import type { AcpAction } from '@/acp/streaming-reducer';
import { getErrorMessage } from '@/lib/utils';
import type { McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import type { McpInstanceView } from '@/mcp/types';

export interface UseAcpSessionResult {
  sessions: SessionInfoView[];
  currentSessionId: string | null;
  isLoadingSession: boolean;
  /** Cursor for the next page, or `null` when the last page has loaded. */
  nextSessionsCursor: string | null;
  refreshSessions: () => Promise<void>;
  /** Append the next page of sessions; no-op if `nextSessionsCursor` is null. */
  loadMoreSessions: () => Promise<void>;
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
  streamingDispatch: Dispatch<AcpAction>;
  hydrateModelsFromSessionResponse: (
    state: NewSessionResponse['models'] | LoadSessionResponse['models'] | null | undefined
  ) => void;
  setMcpToggles: (toggles: McpToggleSnapshot) => void;
  setError: (msg: string | null) => void;
}

/**
 * Owns the ACP session lifecycle on the host side: `session/new`,
 * `session/load` with snapshot rehydration, `session/cancel` + state
 * reset, `_bodhi/sessions/delete`, and `Agent.listSessions`.
 * Cross-hook coordination flows through `streamingDispatch`.
 */
export function useAcpSession(deps: UseAcpSessionDeps): UseAcpSessionResult {
  const {
    isAuthenticated,
    mcpInstancesIsReady,
    composeCurrentMcpServers,
    requestedMcpUrlsRef,
    mcpInstancesRef,
    streamingDispatch,
    hydrateModelsFromSessionResponse,
    setMcpToggles,
    setError,
  } = deps;

  const [sessions, setSessions] = useState<SessionInfoView[]>([]);
  const [nextSessionsCursor, setNextSessionsCursor] = useState<string | null>(null);
  // Subscribe to the runtime singleton's `_session` so external `setSession` calls
  // (auth-loss effect, cancel path) repaint the picker without local mirror state.
  const currentSessionId = useSyncExternalStore(subscribeToSession, getSession, getSession);
  const [isLoadingSession, setIsLoadingSession] = useState(false);

  const refreshSessions = useCallback(async () => {
    if (!isAuthenticated) {
      setSessions([]);
      setNextSessionsCursor(null);
      return;
    }
    try {
      const runtime = ensureRuntime();
      await runtime.initialize;
      const { sessions: page, nextCursor } = await runtime.client.listSessions();
      // Re-check auth after the await — auth-loss can fire mid-flight from the prompt-end path.
      if (!isAuthenticated) return;
      setSessions(page);
      setNextSessionsCursor(nextCursor);
    } catch (err) {
      console.error('session/list failed:', err);
    }
  }, [isAuthenticated]);

  const loadMoreSessions = useCallback(async () => {
    if (!isAuthenticated) return;
    if (!nextSessionsCursor) return;
    try {
      const runtime = ensureRuntime();
      await runtime.initialize;
      const { sessions: page, nextCursor } = await runtime.client.listSessions(nextSessionsCursor);
      if (!isAuthenticated) return;
      // Append, dedup against any concurrently-deleted ids the picker
      // might still hold from the previous page.
      setSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        const additions = page.filter(s => !seen.has(s.id));
        return additions.length === 0 ? prev : [...prev, ...additions];
      });
      setNextSessionsCursor(nextCursor);
    } catch (err) {
      console.error('session/list (load-more) failed:', err);
    }
  }, [isAuthenticated, nextSessionsCursor]);

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
      streamingDispatch({
        type: 'config-options-init',
        configOptions: response.configOptions ?? [],
      });
      hydrateModelsFromSessionResponse(response.models);
      return response.sessionId;
    })();
    setSessionPromise(promise);
    try {
      const id = await promise;
      setMcpToggles(EMPTY_MCP_TOGGLES);
      return id;
    } finally {
      setSessionPromise(null);
    }
  }, [
    composeCurrentMcpServers,
    streamingDispatch,
    setMcpToggles,
    hydrateModelsFromSessionResponse,
    requestedMcpUrlsRef,
    mcpInstancesRef,
  ]);

  // Ensure a session exists once auth lands so feature defaults are
  // fetched before the user interacts with the feature panel and so
  // `setSessionConfigOption` has a sessionId to write against.
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
        const authPromise = getAuthPromise();
        if (authPromise) {
          try {
            await authPromise;
          } catch {
            /* handled by auth effect */
          }
        }
        // Close the prior active session so the agent releases MCP refcounts and
        // detaches the inline runtime; the persisted row stays intact.
        const priorSessionId = getSession();
        if (priorSessionId && priorSessionId !== sessionId) {
          try {
            await runtime.client.closeSession(priorSessionId);
          } catch {
            /* swallow — the agent may already have torn the prior session down */
          }
        }
        // Pass the FULL composed list — agent applies stored toggles
        // server-side before acquiring connections. The host is no
        // longer the source of truth for which servers are off.
        const servers = composeCurrentMcpServers();
        const sessionMeta = composeSessionMeta(
          requestedMcpUrlsRef.current,
          mcpInstancesRef.current
        );
        const loadResponse = await runtime.client.loadSession(sessionId, servers, sessionMeta);
        const meta = (loadResponse._meta?.bodhi ?? {}) as Partial<BodhiLoadSessionMeta>;
        const toggles = meta.mcpToggles ?? { servers: {}, tools: {} };
        const messages = Array.isArray(meta.messages) ? meta.messages : [];
        setSession(sessionId);
        // Drop any in-flight set-model promise owned by the prior session so
        // `sendMessage` doesn't await a stale round-trip and surface a spurious error.
        setModelUpdatePromise(null);
        setMcpToggles(toggles);
        streamingDispatch({
          type: 'config-options-init',
          configOptions: loadResponse.configOptions ?? [],
        });
        streamingDispatch({
          type: 'load-end',
          messages: messages as AgentMessage[],
        });
        hydrateModelsFromSessionResponse(loadResponse.models);
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
      hydrateModelsFromSessionResponse,
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
      // Cancel + close are fire-and-forget worker-side cleanup; the local UI reset below is what the user sees.
      void runtime.client.cancel(sessionId);
      void runtime.client.closeSession(sessionId).catch(() => undefined);
    }
    setSession(null);
    setModelUpdatePromise(null);
    setError(null);
    setMcpToggles(EMPTY_MCP_TOGGLES);
    streamingDispatch({ type: 'reset' });
  }, [streamingDispatch, setMcpToggles, setError]);

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
      setModelUpdatePromise(null);
    };
    void run();
  }, [isAuthenticated]);

  return {
    sessions,
    currentSessionId,
    isLoadingSession,
    nextSessionsCursor,
    refreshSessions,
    loadMoreSessions,
    ensureSession,
    loadSession,
    clearMessages,
    deleteSession,
  };
}
