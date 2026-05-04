import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import {
  ensureRuntime,
  getAuthKey,
  getAuthPromise,
  getSession,
  setAuthKey,
  setAuthPromise,
} from '@/acp/runtime';
import { authKeyOf, composeSessionMeta } from '@/acp/session-meta';
import { getErrorMessage } from '@/lib/utils';
import { getServerUrlOrThrow } from '@/lib/agent-model';
import { composeMcpServers, type McpToggleSnapshot } from '@/mcp/compose-mcp-servers';
import type { McpInstanceView } from '@/mcp/types';

export interface UseAcpAuthDeps {
  setError: (msg: string | null) => void;
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
  /**
   * Gate the token-rotation `session/load` rebuild on the MCP catalog
   * being hydrated. Without this, a rotation that lands before the
   * IDB-backed instance list resolves would compose an empty server array
   * and the worker pool would drop every connected MCP.
   */
  mcpInstancesIsReady: boolean;
}

/**
 * Owns the auth-side ACP wire. On `auth.accessToken` change:
 * - calls `acp.authenticate` (deduped via `getAuthKey()` +
 *   `getAuthPromise()`),
 * - on rotation (token A → token B with an active session),
 *   re-issues `session/load` so the worker's MCP pool picks up the
 *   new `Bearer` header.
 *
 * Module-scope state in `acp/runtime.ts` (`_authKey` / `_authPromise`)
 * survives StrictMode double-mounts, so the dedupe key holds across
 * the duplicate effect fire.
 */
export function useAcpAuth(deps: UseAcpAuthDeps): void {
  const { setError, mcpInstancesRef, mcpTogglesRef, requestedMcpUrlsRef, mcpInstancesIsReady } =
    deps;
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
      lastWorkerTokenRef.current = null;
      return;
    }

    let cancelled = false;
    const prevWorkerToken = lastWorkerTokenRef.current;

    const run = async () => {
      setError(null);
      try {
        const serverUrl = getServerUrlOrThrow(bodhiClient.getState());
        const key = authKeyOf(token, serverUrl);
        if (key !== getAuthKey() || !getAuthPromise()) {
          setAuthKey(key);
          setAuthPromise(
            (async () => {
              await runtime.initialize;
              const resp = await runtime.client.authenticate({ token, baseUrl: serverUrl });
              const meta = resp?._meta as { bodhi?: { providerInfo?: unknown } } | undefined;
              const providerInfo = meta?.bodhi?.providerInfo;
              if (providerInfo !== undefined) {
                console.info('[acp/auth] BodhiApp probe:', providerInfo);
              }
            })()
          );
        }
        await getAuthPromise();
        if (cancelled) return;
        lastWorkerTokenRef.current = token;
        // Token *rotation* (A → B, both non-null) on an already-active
        // session: the worker's MCP pool still holds the stale
        // `Bearer A` header, so re-issue `session/load` with freshly
        // composed servers. The pool evicts + reconnects on the auth
        // fingerprint change. New-login (null → A) path is handled by
        // the auto-`ensureSession` effect in `useAcpSession`.
        const sessionId = getSession();
        if (prevWorkerToken && prevWorkerToken !== token && sessionId) {
          // Skip the rebuild until the MCP catalog is ready; composing
          // with an empty list would tell the worker to drop every
          // connection. The effect re-runs when `mcpInstancesIsReady`
          // flips true, giving us a second chance once the catalog hydrates.
          if (!mcpInstancesIsReady) return;
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
        console.error('ACP authenticate failed:', err);
        setAuthKey(null);
        setAuthPromise(null);
        if (!cancelled) {
          setError(getErrorMessage(err, 'Failed to connect to agent'));
        }
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
    setError,
    mcpInstancesRef,
    mcpTogglesRef,
    requestedMcpUrlsRef,
    mcpInstancesIsReady,
  ]);
}
