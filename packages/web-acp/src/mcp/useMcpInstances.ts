import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import type { McpInstanceView } from './types';

/**
 * Live fetch of the user's MCP instance catalog from BodhiApp.
 *
 * We deliberately avoid persisting the list (no `idb-keyval` slot): the
 * authoritative source is `bodhiClient.mcps.list()`, so every time auth
 * changes (login, logout, token rotation) or the hook remounts we
 * re-fetch. The live-only decision is documented in
 * `specs/web-acp-client/mcp.md`.
 */
export interface UseMcpInstancesResult {
  instances: McpInstanceView[];
  isLoading: boolean;
  /**
   * True once the hook has completed at least one fetch attempt for
   * the current `isAuthenticated` window (or once we have explicitly
   * cleared `instances` because auth dropped out). Consumers that
   * need a deterministic "MCP catalog snapshot is fresh" signal
   * before kicking off `session/new` rely on this rather than on
   * `!isLoading`, which has a transient false value between auth
   * landing and the refresh effect firing.
   */
  isReady: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

const EMPTY_INSTANCES: McpInstanceView[] = [];

interface RawMcpRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  path: string;
  auth_type: string;
}

function toView(row: RawMcpRow): McpInstanceView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description ?? null,
    enabled: row.enabled,
    path: row.path,
    authType: row.auth_type,
  };
}

const UNAUTHENTICATED_TOKEN = '__unauth__';

export function useMcpInstances(): UseMcpInstancesResult {
  const { client: bodhiClient, auth, isAuthenticated } = useBodhi();
  const currentToken = isAuthenticated ? (auth.accessToken ?? '') : UNAUTHENTICATED_TOKEN;
  const [instances, setInstances] = useState<McpInstanceView[]>(EMPTY_INSTANCES);
  const [isLoading, setIsLoading] = useState(false);
  // Tracks the auth token the most recent successful (or empty) fetch
  // was performed for. When auth rotates, `currentToken` changes
  // immediately — so `isReady` naturally evaluates to `false` until
  // `refresh` writes the fresh token back here. No effect-driven
  // resetState dance is needed (which the `react-hooks/set-state-in-effect`
  // lint would flag).
  const [fetchedForToken, setFetchedForToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) {
      setInstances(EMPTY_INSTANCES);
      setError(null);
      setFetchedForToken(UNAUTHENTICATED_TOKEN);
      return;
    }
    if (loadingRef.current) return;
    loadingRef.current = true;
    setIsLoading(true);
    setError(null);
    try {
      // `bodhiClient.mcps` is typed as `Mcps` by bodhi-js-core but its
      // `list()` promise resolves to the raw ts-client payload which
      // wraps the array under `mcps`. We project into `McpInstanceView`
      // eagerly so downstream consumers never touch the raw shape.
      const raw = (await bodhiClient.mcps.list()) as { mcps?: RawMcpRow[] } | RawMcpRow[];
      const rows = Array.isArray(raw) ? raw : (raw.mcps ?? []);
      setInstances(rows.map(toView));
    } catch (err) {
      console.error('[useMcpInstances] list failed:', err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      loadingRef.current = false;
      setIsLoading(false);
      setFetchedForToken(currentToken);
    }
  }, [bodhiClient, isAuthenticated, currentToken]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      if (cancelled) return;
      await refresh();
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [refresh, auth.accessToken]);

  const isReady = fetchedForToken === currentToken;

  return useMemo(
    () => ({ instances, isLoading, isReady, error, refresh }),
    [instances, isLoading, isReady, error, refresh]
  );
}
