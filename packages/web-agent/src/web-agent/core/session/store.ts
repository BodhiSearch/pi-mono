/**
 * SessionStore — storage-agnostic CRUD + append surface for sessions.
 *
 * Implementations:
 *   - `MemorySessionStore` for tests and jsdom (no IndexedDB).
 *   - `DexieSessionStore` for production (Dexie on IndexedDB).
 *
 * Design notes:
 *   - Stateless interface. Active-session state (leaf pointer, in-memory
 *     entry cache, session id) lives in `SessionManager`, not the store.
 *   - `SessionRow` stores timestamps as epoch-ms so IDB can index them
 *     without date-string collation. `SessionSummary` (from `./types`) is
 *     the public shape returned to callers; stores map epoch-ms → ISO at
 *     the boundary so the RPC + picker wire format stays unchanged.
 *   - Full `SessionEntry` union coverage on append so M7/M8 (compaction,
 *     branches, custom entries) land without widening the interface.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type {
  BranchSummaryEntry,
  CompactionEntry,
  CustomMessageEntry,
  SessionEntry,
  SessionSummary,
} from './types';

/** Persisted session metadata. Epoch-ms so IDB indexes sort numerically. */
export interface SessionRow {
  id: string;
  /** Denormalised from the latest `session_info` entry; `null` if never named. */
  name: string | null;
  cwd: string;
  parentSession: string | null;
  createdAt: number;
  modifiedAt: number;
  /** Schema version for the entry payloads — matches `CURRENT_SESSION_VERSION`. */
  entryVersion: number;
}

/**
 * Row shape for the `entries` table. Duplicates `timestamp` + `type` + `parentId`
 * out of `data` so Dexie can index/query without parsing every row.
 */
export interface EntryRow {
  sessionId: string;
  id: string;
  parentId: string | null;
  timestamp: number;
  type: SessionEntry['type'];
  data: SessionEntry;
}

export type CreateSessionOptions = {
  id?: string;
  cwd: string;
  parentSession?: string;
};

export type CompactionAppend = Omit<CompactionEntry, 'id' | 'parentId' | 'timestamp' | 'type'>;
export type BranchSummaryAppend = Omit<
  BranchSummaryEntry,
  'id' | 'parentId' | 'timestamp' | 'type'
>;
export type CustomMessageAppend = Omit<
  CustomMessageEntry,
  'id' | 'parentId' | 'timestamp' | 'type'
>;

export interface SessionStore {
  // -- Lifecycle ------------------------------------------------------------
  createSession(opts: CreateSessionOptions): Promise<SessionRow>;
  deleteSession(sessionId: string): Promise<void>;
  /**
   * Rename a session. Implementations update the denormalised `SessionRow.name`
   * cache and also append a `session_info` entry so the wire format is preserved
   * for extensions / JSONL export. `parentId` is the current leaf pointer owned
   * by the caller (`SessionManager`).
   */
  setSessionName(sessionId: string, name: string, parentId: string | null): Promise<string>;
  /** Bump `modifiedAt` without appending — used when only ordering changes. */
  touchSession(sessionId: string): Promise<void>;

  // -- Reads ----------------------------------------------------------------
  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  getEntries(sessionId: string): Promise<SessionEntry[]>;
  getEntry(sessionId: string, entryId: string): Promise<SessionEntry | null>;

  // -- Appends --------------------------------------------------------------
  appendMessage(sessionId: string, message: AgentMessage, parentId: string | null): Promise<string>;
  appendModelChange(
    sessionId: string,
    provider: string,
    modelId: string,
    parentId: string | null
  ): Promise<string>;
  appendThinkingLevelChange(
    sessionId: string,
    thinkingLevel: string,
    parentId: string | null
  ): Promise<string>;
  appendSessionInfo(sessionId: string, name: string, parentId: string | null): Promise<string>;
  appendCompaction(
    sessionId: string,
    payload: CompactionAppend,
    parentId: string | null
  ): Promise<string>;
  appendBranchSummary(
    sessionId: string,
    payload: BranchSummaryAppend,
    parentId: string | null
  ): Promise<string>;
  appendLabel(
    sessionId: string,
    targetId: string,
    label: string | undefined,
    parentId: string | null
  ): Promise<string>;
  appendCustomEntry(
    sessionId: string,
    customType: string,
    data: unknown,
    parentId: string | null
  ): Promise<string>;
  appendCustomMessageEntry(
    sessionId: string,
    entry: CustomMessageAppend,
    parentId: string | null
  ): Promise<string>;

  // -- Live observation (optional) -----------------------------------------
  /**
   * Optional reactive read channel. Dexie implements via `liveQuery`; memory
   * store omits (tests that need change notifications poll). Returns an
   * unsubscribe function.
   */
  observeSessionList?(cb: (summaries: SessionSummary[]) => void): () => void;
  observeEntries?(sessionId: string, cb: (entries: SessionEntry[]) => void): () => void;
}
