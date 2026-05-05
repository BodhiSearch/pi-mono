import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { AnyBodhiBuiltinAction } from '../wire';

/**
 * Worker-owned persistence interface for ACP sessions.
 *
 * The agent package owns only the **shape** types and store interfaces;
 * the host runtime supplies a concrete implementation (the browser
 * uses Dexie/IndexedDB, future backends could use SQLite, Postgres,
 * etc.). The object of record is whatever `session/new` returned plus
 * the transcript of `session/update` events.
 */

// Adding a new SessionEntryKind stays on-disk compatible: `entries.payload`
// is an opaque blob keyed by [sessionId+seq], so new kinds (e.g. `builtin`,
// `extension`) do not require a Dexie schema bump.
export type SessionEntryKind = 'notification' | 'turn' | 'builtin' | 'extension';

export interface TurnPayload {
  userText: string;
  finalMessages: AgentMessage[];
  modelId: string;
}

/**
 * Persisted built-in slash-command exchange. The worker handles `/help`, etc.
 * in `prompt()`, emits the reply on the wire, and stores this instead of a
 * `turn` row. `inline.restoreMessages()` replays only `turn` payloads so
 * the LLM never sees built-in text on follow-up prompts; the UI transcript
 * still includes built-ins via `bodhi/getSession`, which walks `builtin` rows.
 *
 * `action` is an optional client-action descriptor (e.g. `{ kind: 'copy' }`);
 * the client materialises the concrete notification. `kind` stays open for
 * future commands such as `/share`.
 */
export interface BuiltinPayload {
  command: string;
  userText: string;
  replyText: string;
  action?: AnyBodhiBuiltinAction;
}

/**
 * Custom session entry written by a `pi.session.appendEntry`
 * call. The payload is opaque to the agent runtime — it is
 * persisted verbatim and replayed on `session/load` so the host
 * UI can re-render the entry in chronological order. `data` is
 * whatever the extension passed; the host decides how to render
 * it (and may ignore unknown `customType`s without breaking
 * replay).
 */
export interface ExtensionPayload {
  extensionName: string;
  customType: string;
  data: unknown;
  /**
   * Optional free-form label attached via `pi.session.setLabel`.
   * Mutates in place when the host's bridge asks the store to
   * update an existing entry; treated as a hint, not load-bearing
   * state for the agent runtime.
   */
  label?: string;
}

export interface SessionEntry {
  sessionId: string;
  seq: number;
  at: number;
  kind: SessionEntryKind;
  payload: SessionNotification | TurnPayload | BuiltinPayload | ExtensionPayload;
}

export interface SessionRow {
  id: string;
  createdAt: number;
  updatedAt: number;
  title: string | null;
  turnCount: number;
  lastModelId: string | null;
}

export interface SessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastModelId: string | null;
}

const MAX_TITLE_LENGTH = 60;

/**
 * Derive a one-line title from the first user prompt. Keeps the picker
 * readable without needing an LLM call.
 */
export function deriveTitle(userText: string): string {
  const single = userText.replace(/\s+/g, ' ').trim();
  if (single.length <= MAX_TITLE_LENGTH) return single;
  return `${single.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}

/**
 * Pagination contract for `listSummariesPage`. Page is 1-indexed.
 * `total` is the count across all pages (post-filter), used by the
 * handler to decide whether to emit a `nextCursor`.
 */
export interface SessionSummaryPage {
  rows: SessionSummary[];
  total: number;
}

export interface SessionStore {
  createSession(id: string, at?: number): Promise<void>;
  recordNotification(id: string, notification: SessionNotification, at?: number): Promise<void>;
  recordTurn(
    id: string,
    userText: string,
    finalMessages: AgentMessage[],
    modelId: string,
    at?: number
  ): Promise<void>;
  recordBuiltin(id: string, payload: BuiltinPayload, at?: number): Promise<void>;
  /**
   * Append a custom extension entry. Returns the assigned `seq`
   * so the host can mint a stable `entryId` for `setLabel`.
   */
  recordExtension(id: string, payload: ExtensionPayload, at?: number): Promise<number>;
  /**
   * Best-effort label update for an extension entry identified by
   * `seq`. No-op when the entry is missing or is not an extension
   * kind (e.g. a `'turn'` row).
   */
  setExtensionLabel(id: string, seq: number, label: string | undefined): Promise<void>;
  /** Full unpaginated list, sorted by `updatedAt` desc. */
  listSummaries(): Promise<SessionSummary[]>;
  /** Paginated read, sorted by `updatedAt` desc. Page is 1-indexed. */
  listSummariesPage(opts: { page: number; perPage: number }): Promise<SessionSummaryPage>;
  readEntries(id: string): Promise<SessionEntry[]>;
  getSession(id: string): Promise<SessionRow | undefined>;
  setTitle(id: string, title: string | null): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
