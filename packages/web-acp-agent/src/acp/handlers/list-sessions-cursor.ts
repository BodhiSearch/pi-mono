/**
 * Cursor encoding for `Agent.listSessions`.
 *
 * Cursor is base64(`page=N&per_page=M&sort_by=updated_at&sort_seq=desc`).
 * Defaults: page=1, per_page=10. `sort_by` / `sort_seq` are pinned for
 * v1 — the picker shows most-recent-first; we encode them in the cursor
 * so future server-side changes won't silently re-order paginated
 * fetches in flight.
 */

export interface ListSessionsCursor {
  page: number;
  perPage: number;
  sortBy: 'updated_at';
  sortSeq: 'desc';
}

export const DEFAULT_PER_PAGE = 10;
const MAX_PER_PAGE = 100;

const DEFAULTS: ListSessionsCursor = {
  page: 1,
  perPage: DEFAULT_PER_PAGE,
  sortBy: 'updated_at',
  sortSeq: 'desc',
};

function base64Encode(input: string): string {
  if (typeof btoa === 'function') return btoa(input);
  return Buffer.from(input, 'utf-8').toString('base64');
}

function base64Decode(input: string): string {
  if (typeof atob === 'function') return atob(input);
  return Buffer.from(input, 'base64').toString('utf-8');
}

export function encodeCursor(cursor: ListSessionsCursor): string {
  const qs = `page=${cursor.page}&per_page=${cursor.perPage}&sort_by=${cursor.sortBy}&sort_seq=${cursor.sortSeq}`;
  return base64Encode(qs);
}

/**
 * Lenient decode: bad input falls back to defaults rather than throwing,
 * so a malformed cursor produces a clean first-page response instead of
 * surfacing a JSON-RPC error to the client.
 */
export function decodeCursor(raw: string | undefined): ListSessionsCursor {
  if (!raw) return { ...DEFAULTS };
  try {
    const decoded = base64Decode(raw);
    const params = new Map<string, string>();
    for (const part of decoded.split('&')) {
      const [k, v] = part.split('=');
      if (k && v !== undefined) params.set(k, v);
    }
    const pageRaw = parseInt(params.get('page') ?? '', 10);
    const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
    const perPageRaw = parseInt(params.get('per_page') ?? '', 10);
    const perPage = Number.isFinite(perPageRaw)
      ? Math.max(1, Math.min(MAX_PER_PAGE, perPageRaw))
      : DEFAULT_PER_PAGE;
    return { page, perPage, sortBy: 'updated_at', sortSeq: 'desc' };
  } catch {
    return { ...DEFAULTS };
  }
}
