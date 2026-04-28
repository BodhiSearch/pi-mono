/**
 * Main-thread IDB persistence for the user's "requested MCP servers"
 * list. Mirrors `vault/fsa-handle-store.ts` — single `idb-keyval`
 * key, swallow-on-error reads/writes, no Dexie schema.
 *
 * The list drives both:
 *  - the `LoginOptionsBuilder` chain in `Header.tsx` (login click sends
 *    `addMcpServer(url)` for each entry),
 *  - the `_meta.bodhi.requestedMcpUrls` payload pushed into the worker
 *    on `session/new` / `session/load` so `/mcp` can render Pending
 *    entries and `/mcp add` / `/mcp remove` can give correct
 *    idempotency feedback.
 *
 * Source of truth lives here. The worker treats it as read-only state.
 */
import { del, get, set } from 'idb-keyval';
import { canonicalizeMcpUrl } from './url-canonical';

export const REQUESTED_MCPS_IDB_KEY = 'web-acp:mcp-requested';

export async function loadRequestedMcps(): Promise<string[]> {
  try {
    const stored = await get<unknown>(REQUESTED_MCPS_IDB_KEY);
    if (!Array.isArray(stored)) return [];
    return dedupeKeepOrder(stored.filter((u): u is string => typeof u === 'string'));
  } catch {
    return [];
  }
}

export async function saveRequestedMcps(urls: string[]): Promise<void> {
  const cleaned = dedupeKeepOrder(urls);
  if (cleaned.length === 0) {
    try {
      await del(REQUESTED_MCPS_IDB_KEY);
    } catch {
      /* ignore */
    }
    return;
  }
  try {
    await set(REQUESTED_MCPS_IDB_KEY, cleaned);
  } catch (err) {
    console.warn('[requested-mcps-store] saveRequestedMcps failed:', err);
  }
}

export async function clearRequestedMcps(): Promise<void> {
  try {
    await del(REQUESTED_MCPS_IDB_KEY);
  } catch {
    /* ignore */
  }
}

export interface AddRequestedMcpResult {
  list: string[];
  added: boolean;
  /** Canonicalised input. `null` when the URL failed to parse. */
  canonical: string | null;
}

/**
 * Add `inputUrl` to the persisted list. Idempotent — a URL already in
 * the list returns `added: false` with the unchanged list. Failed URL
 * parsing returns `added: false` with `canonical: null` so callers can
 * surface a parse error instead of writing garbage.
 */
export async function addRequestedMcp(inputUrl: string): Promise<AddRequestedMcpResult> {
  const canonical = canonicalizeMcpUrl(inputUrl);
  const current = await loadRequestedMcps();
  if (canonical === null) {
    return { list: current, added: false, canonical: null };
  }
  if (current.includes(canonical)) {
    return { list: current, added: false, canonical };
  }
  const next = [...current, canonical];
  await saveRequestedMcps(next);
  return { list: next, added: true, canonical };
}

export interface RemoveRequestedMcpResult {
  list: string[];
  removed: boolean;
  /** Canonicalised input. `null` when the URL failed to parse. */
  canonical: string | null;
}

/**
 * Remove `inputUrl` from the persisted list. Idempotent — a URL not
 * in the list returns `removed: false` with the unchanged list.
 */
export async function removeRequestedMcp(inputUrl: string): Promise<RemoveRequestedMcpResult> {
  const canonical = canonicalizeMcpUrl(inputUrl);
  const current = await loadRequestedMcps();
  if (canonical === null) {
    return { list: current, removed: false, canonical: null };
  }
  if (!current.includes(canonical)) {
    return { list: current, removed: false, canonical };
  }
  const next = current.filter(u => u !== canonical);
  await saveRequestedMcps(next);
  return { list: next, removed: true, canonical };
}

function dedupeKeepOrder(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const url of urls) {
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}
