import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import {
  ensureRuntime,
  getAuthKey,
  getAuthModels,
  getAuthPromise,
  getSession,
  setAuthKey,
  setAuthModels,
  setAuthPromise,
} from '@/acp/runtime';
import type { BodhiModelDescriptor } from '@/acp/index';
import { authKeyOf, composeSessionMeta } from '@/acp/session-meta';
import { getErrorMessage } from '@/lib/utils';
import { getServerUrlOrThrow } from '@/lib/agent-model';
import { composeMcpServers, type McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import type { McpInstanceView } from '@/mcp/types';

export interface UseAcpAuthDeps {
  setError: (msg: string | null) => void;
  setModels: (list: BodhiModelDescriptor[]) => void;
  setIsLoadingModels: (loading: boolean) => void;
  ensureDefaultModel: (list: BodhiModelDescriptor[]) => void;
  loadingModelsRef: MutableRefObject<boolean>;
  /**
   * Snapshot of the currently approved MCP instance catalog. Read on
   * token rotation so the rebuilt `session/load` carries the same set
   * of servers that the auto-`ensureSession` path would compose.
   */
  mcpInstancesRef: MutableRefObject<McpInstanceView[]>;
  /** Latest snapshot of per-session MCP toggles for the rotation path. */
  mcpTogglesRef: MutableRefObject<McpToggleSnapshot>;
  /** Latest user-requested MCP URL list for the rotation path. */
  requestedMcpUrlsRef: MutableRefObject<string[]>;
}

/**
 * Owns the auth-side ACP wire. On `auth.accessToken` change:
 * - calls `acp.authenticate` + `bodhi/listModels` (deduped via
 *   `getAuthKey()` + `getAuthPromise()`),
 * - publishes the model catalog to `useAcpModels`,
 * - on rotation (token A → token B with an active session),
 *   re-issues `session/load` so the worker's MCP pool picks up the
 *   new `Bearer` header.
 *
 * Module-scope state in `acp/runtime.ts` (`_authKey` / `_authPromise`
 * / `_authModels`) survives StrictMode double-mounts, so the
 * dedupe key holds across the duplicate effect fire.
 */
export function useAcpAuth(deps: UseAcpAuthDeps): void {
  const {
    setError,
    setModels,
    setIsLoadingModels,
    ensureDefaultModel,
    loadingModelsRef,
    mcpInstancesRef,
    mcpTogglesRef,
    requestedMcpUrlsRef,
  } = deps;
  const { client: bodhiClient, auth, isReady } = useBodhi();

  // Remembers the last `auth.accessToken` we *handed to the worker*.
  // The first auth effect fire (token A after `null`) is the ordinary
  // login path; subsequent transitions (A → B, both non-null) are
  // rotations that force a `session/load` rebuild so the pool picks
  // up the new `Bearer` header. See `mcp.md` for the rotation
  // decision log.
  const lastWorkerTokenRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isReady) return;
    const token = auth.accessToken ?? null;
    const runtime = ensureRuntime();

    if (!token) {
      setAuthKey(null);
      setAuthPromise(null);
      setAuthModels([]);
      lastWorkerTokenRef.current = null;
      return;
    }

    loadingModelsRef.current = true;
    let cancelled = false;
    const prevWorkerToken = lastWorkerTokenRef.current;

    const run = async () => {
      setIsLoadingModels(true);
      setError(null);
      try {
        const serverUrl = getServerUrlOrThrow(bodhiClient.getState());
        const key = authKeyOf(token, serverUrl);
        if (key !== getAuthKey() || !getAuthPromise()) {
          setAuthKey(key);
          setAuthPromise(
            (async () => {
              await runtime.initialize;
              await runtime.client.authenticate({ token, baseUrl: serverUrl });
              setAuthModels(await runtime.client.listModels());
            })()
          );
        }
        await getAuthPromise();
        if (cancelled) return;
        lastWorkerTokenRef.current = token;
        const fetchedModels = getAuthModels();
        setModels(fetchedModels);
        if (fetchedModels.length > 0) ensureDefaultModel(fetchedModels);
        // Token *rotation* (A → B, both non-null) on an already-active
        // session: the worker's MCP pool still holds the stale
        // `Bearer A` header, so re-issue `session/load` with freshly
        // composed servers. The pool evicts + reconnects on the auth
        // fingerprint change. New-login (null → A) path is handled by
        // the auto-`ensureSession` effect in `useAcpSession`.
        const sessionId = getSession();
        if (prevWorkerToken && prevWorkerToken !== token && sessionId) {
          try {
            const servers = composeMcpServers(
              mcpInstancesRef.current,
              token,
              serverUrl,
              mcpTogglesRef.current
            );
            const sessionMeta = composeSessionMeta(
              requestedMcpUrlsRef.current,
              mcpInstancesRef.current
            );
            await runtime.client.loadSession(sessionId, servers, sessionMeta);
          } catch (rotErr) {
            console.error('[useAcpAuth] token-rotation session/load failed:', rotErr);
          }
        }
      } catch (err) {
        console.error('ACP authenticate/listModels failed:', err);
        setAuthKey(null);
        setAuthPromise(null);
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
  }, [
    auth.accessToken,
    bodhiClient,
    isReady,
    ensureDefaultModel,
    loadingModelsRef,
    setIsLoadingModels,
    setModels,
    setError,
    mcpInstancesRef,
    mcpTogglesRef,
    requestedMcpUrlsRef,
  ]);
}
