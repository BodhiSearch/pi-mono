import { useCallback, useEffect, useRef, useState } from 'react';
import type { MutableRefObject } from 'react';
import { toast } from 'sonner';
import { LoginOptionsBuilder, useBodhi } from '@bodhiapp/bodhi-js-react';
import type { McpServerHttp } from '@agentclientprotocol/sdk';
import type { AnyBodhiBuiltinAction } from '@/acp/index';
import { dispatchBuiltinAction } from '@/acp/builtin-dispatch';
import { ensureRuntime, getSession } from '@/acp/runtime';
import { composeSessionMeta } from '@/acp/session-meta';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { getErrorMessage } from '@/lib/utils';
import { getServerUrlOrThrow } from '@/lib/agent-model';
import { composeMcpServers, type McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import { loadRequestedMcps } from '@/mcp/requested-mcps-store';
import type { McpInstanceView } from '@/mcp/types';

const EMPTY_MCP_TOGGLES: McpToggleSnapshot = Object.freeze({
  servers: Object.freeze({}) as Record<string, boolean>,
  tools: Object.freeze({}) as Record<string, Record<string, boolean>>,
}) as McpToggleSnapshot;

export interface UseAcpMcpResult {
  mcpToggles: McpToggleSnapshot;
  setMcpToggles: (toggles: McpToggleSnapshot) => void;
  /** Per-session MCP toggle: server-level changes re-issue `session/load`. */
  setMcpToggle: (serverSlug: string, value: boolean, toolName?: string) => Promise<void>;
  /** Compose `mcpServers` for the current auth + instance set, applying optional toggles. */
  composeCurrentMcpServers: (toggles?: McpToggleSnapshot) => McpServerHttp[];
  /** Bind for `useAcpStreaming`'s `dispatchAction` parameter. */
  dispatchAction: (action: AnyBodhiBuiltinAction, messages: AgentMessage[]) => Promise<void>;
  /** Snapshot of approved MCP instances; consumed by useAcpAuth on rotation. */
  mcpInstancesRef: MutableRefObject<McpInstanceView[]>;
  /** Latest toggles snapshot; consumed by useAcpAuth on rotation. */
  mcpTogglesRef: MutableRefObject<McpToggleSnapshot>;
  /** User-requested MCP URLs (IDB-backed) for `composeSessionMeta`. */
  requestedMcpUrlsRef: MutableRefObject<string[]>;
}

export interface UseAcpMcpDeps {
  setError: (msg: string | null) => void;
  mcpInstances: { instances: McpInstanceView[]; isReady: boolean };
}

/**
 * Owns the host-side MCP slice: per-session toggles, server
 * composition for `session/new` / `session/load`, the
 * `_bodhi/mcp/toggles/set` mutation, the `/mcp add` / `/mcp remove`
 * built-in action dispatcher, and the requested-MCPs IDB hydration.
 *
 * Refs (`mcpInstancesRef`, `mcpTogglesRef`, `requestedMcpUrlsRef`) are
 * exposed back so `useAcpAuth` (token rotation) and `useAcpSession`
 * (`session/new`, `session/load`) can read the freshest snapshot
 * without re-rendering on every change.
 */
export function useAcpMcp(deps: UseAcpMcpDeps): UseAcpMcpResult {
  const { setError, mcpInstances } = deps;
  const { client: bodhiClient, auth, login, logout } = useBodhi();

  const [mcpToggles, setMcpTogglesState] = useState<McpToggleSnapshot>(EMPTY_MCP_TOGGLES);

  const mcpInstancesRef = useRef<McpInstanceView[]>([]);
  useEffect(() => {
    mcpInstancesRef.current = mcpInstances.instances;
  }, [mcpInstances.instances]);

  const mcpTogglesRef = useRef<McpToggleSnapshot>(EMPTY_MCP_TOGGLES);
  useEffect(() => {
    mcpTogglesRef.current = mcpToggles;
  }, [mcpToggles]);

  /**
   * Mirror of the persisted `web-acp:mcp-requested` IDB list. Hydrated
   * once on hook mount via `loadRequestedMcps()`, then updated whenever
   * `triggerLoginWithRequested(urls)` is called by `dispatchAction`
   * after `/mcp add` / `/mcp remove` (the dispatcher writes through
   * `addRequestedMcp` / `removeRequestedMcp` and passes the resulting
   * canonical list back here so the ref stays in sync without an
   * extra IDB round-trip). The ref is read by `composeSessionMeta`
   * at every `session/new` / `session/load` so the worker always
   * sees the freshest list.
   */
  const requestedMcpUrlsRef = useRef<string[]>([]);
  const requestedMcpsHydratedRef = useRef(false);
  useEffect(() => {
    if (requestedMcpsHydratedRef.current) return;
    requestedMcpsHydratedRef.current = true;
    void (async () => {
      requestedMcpUrlsRef.current = await loadRequestedMcps();
    })();
  }, []);

  const composeCurrentMcpServers = useCallback(
    (toggles?: McpToggleSnapshot): McpServerHttp[] => {
      const token = auth.accessToken;
      if (!token) return [];
      try {
        const baseUrl = getServerUrlOrThrow(bodhiClient.getState());
        return composeMcpServers(mcpInstancesRef.current, token, baseUrl, toggles);
      } catch (err) {
        console.warn('[useAcpMcp] composeMcpServers failed:', err);
        return [];
      }
    },
    [auth.accessToken, bodhiClient]
  );

  /**
   * Re-issue Bodhi login with a fresh requested-MCPs list. The Bodhi
   * SDK's `login()` short-circuits on an already-authenticated user
   * (`if (existingAuth.status === 'authenticated') return existingAuth;`),
   * so a vanilla `login(opts)` from inside `/mcp add` would no-op
   * silently. We call `logout()` first to clear the local token —
   * this does **not** sign the user out of the IDP (no
   * `end_session_endpoint` call), so the immediate `login(opts)` that
   * follows rides the live SSO session: Keycloak short-circuits the
   * authorize flow without a password prompt, Bodhi serves the
   * access-request approval screen for the new MCP scopes, the user
   * approves, the page redirects back, and the SDK's
   * `handleAccessRequestCallback` completes the OAuth PKCE.
   *
   * The `urls` argument is also written to `requestedMcpUrlsRef` so
   * any code that runs between here and the redirect (toast handlers,
   * etc.) sees the updated list.
   */
  const triggerLoginWithRequested = useCallback(
    async (urls: string[]): Promise<void> => {
      requestedMcpUrlsRef.current = urls;
      const builder = new LoginOptionsBuilder().setFlowType('redirect').setRole('scope_user_user');
      for (const url of urls) builder.addMcpServer(url);
      try {
        await logout();
        const authState = await login(builder.build());
        if (authState?.status === 'error' && authState.error) {
          toast.error(authState.error.message);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Login failed';
        toast.error(message);
      }
    },
    [login, logout]
  );

  // Bind the pure dispatcher to this hook's `triggerLogin` closure.
  // The `useBodhi` `login`/`logout` pair lives only in React land, so
  // we pass them in here while the IDB-mutation + toast logic stays
  // pure in `acp/builtin-dispatch.ts`.
  const dispatchAction = useCallback(
    (action: AnyBodhiBuiltinAction, messages: AgentMessage[]) =>
      dispatchBuiltinAction(action, messages, triggerLoginWithRequested),
    [triggerLoginWithRequested]
  );

  /**
   * Flip a per-session MCP toggle. `toolName` omitted toggles the
   * server; otherwise toggles the individual tool. The worker responds
   * with the full snapshot so we rehydrate local state in one shot.
   *
   * A server-level toggle change implies a new `mcpServers` composition
   * for the worker's pool (the disabled server must come off / come
   * back on). We re-issue `session/load` with the freshly composed
   * array so the worker releases / acquires the right connections —
   * tool-only toggles just trickle through to the next `prompt` turn
   * since the pool is unchanged.
   */
  const setMcpToggle = useCallback(
    async (serverSlug: string, value: boolean, toolName?: string) => {
      const sessionId = getSession();
      if (!sessionId) return;
      const runtime = ensureRuntime();
      try {
        const payload = await runtime.client.setMcpToggle(sessionId, serverSlug, value, toolName);
        const nextToggles = (payload.toggles ?? { servers: {}, tools: {} }) as McpToggleSnapshot;
        setMcpTogglesState(nextToggles);
        if (!toolName) {
          const servers = composeCurrentMcpServers(nextToggles);
          const sessionMeta = composeSessionMeta(
            requestedMcpUrlsRef.current,
            mcpInstancesRef.current
          );
          await runtime.client.loadSession(sessionId, servers, sessionMeta);
        }
      } catch (err) {
        console.error('_bodhi/mcp/toggles/set failed:', err);
        setError(getErrorMessage(err, 'Failed to toggle MCP'));
      }
    },
    [composeCurrentMcpServers, setError]
  );

  return {
    mcpToggles,
    setMcpToggles: setMcpTogglesState,
    setMcpToggle,
    composeCurrentMcpServers,
    dispatchAction,
    mcpInstancesRef,
    mcpTogglesRef,
    requestedMcpUrlsRef,
  };
}
