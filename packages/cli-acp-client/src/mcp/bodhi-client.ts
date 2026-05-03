/**
 * Minimal Bodhi REST client for the CLI host.
 *
 * The browser host uses `bodhi-js-react` (a React-bound wrapper over
 * `bodhi-js-core`) to fetch the user's MCP instance catalog. The CLI
 * runs in plain Node with no React surface, so we drop a hand-rolled
 * `fetch` against the same endpoint instead of pulling the whole
 * SDK. The shape is documented in `specs/web-acp-agent/mcp.md`.
 *
 * Auth: the caller passes the current Bodhi access token; we attach
 * it as `Authorization: Bearer <token>`. The CLI mirrors the
 * browser host's "live-only catalog" decision — no IDB / sqlite
 * caching of the list itself; the source of truth is BodhiApp.
 */

export interface RawMcpRow {
  id: string;
  slug: string;
  name: string;
  description?: string | null;
  enabled: boolean;
  path: string;
  auth_type: string;
}

export interface McpInstanceView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  enabled: boolean;
  /** MCP proxy path, e.g. `/bodhi/v1/apps/mcps/{id}/mcp` (server-relative). */
  path: string;
  /** `public` | `header` | `oauth`. Surfaced for future hints; never branched on today. */
  authType: string;
}

const APP_MCPS_PATH = '/bodhi/v1/apps/mcps';

export interface ListMcpsOptions {
  /** Bodhi base URL (e.g. `https://bodhi.example.com`). */
  baseUrl: string;
  /** Bodhi access token (without the `Bearer ` prefix). */
  token: string;
  /** Optional fetch override; tests pass `vi.fn()`. */
  fetch?: typeof fetch;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export async function listMcpInstances(opts: ListMcpsOptions): Promise<McpInstanceView[]> {
  const fetcher = opts.fetch ?? fetch;
  const base = opts.baseUrl.replace(/\/+$/, '');
  const url = `${base}${APP_MCPS_PATH}`;
  const res = await fetcher(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${opts.token}`,
    },
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await safeReadBody(res);
    throw new Error(
      `GET ${APP_MCPS_PATH} failed: ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}`
    );
  }
  const raw = (await res.json()) as { mcps?: RawMcpRow[] } | RawMcpRow[];
  const rows = Array.isArray(raw) ? raw : (raw.mcps ?? []);
  return rows.map(toView);
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

async function safeReadBody(res: Response): Promise<string> {
  try {
    const text = await res.text();
    return text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return '';
  }
}
