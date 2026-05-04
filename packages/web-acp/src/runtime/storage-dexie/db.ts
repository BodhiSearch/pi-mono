import Dexie, { type Table } from 'dexie';
import type { SessionEntry, SessionRow } from '@bodhiapp/web-acp-agent';

/**
 * Dexie/IndexedDB schema backing the browser host's `SessionStore`
 * and `PreferenceStore`. The table shapes mirror the agent-package
 * interfaces; nothing here is loaded into the agent itself — host
 * code in `runtime/storage-dexie/*-store.ts` adapts Dexie tables to
 * the agent's interfaces.
 *
 * Schema versions:
 *   v1 — sessions + entries.
 *   v2 — per-session features table.
 *   v3 — per-session mcpToggles table.
 *   v4 — features + mcpToggles unified into preferences (sessionId+key).
 *
 * `dbName` defaults to `'web-acp'`; do NOT rename this without a
 * migration plan — the constant is on-disk identity for every
 * existing installation.
 */
export const DEFAULT_SESSION_DB_NAME = 'web-acp';

export interface PreferenceRow {
  sessionId: string;
  key: string;
  value: unknown;
  updatedAt: number;
}

export class SessionStoreDb extends Dexie {
  sessions!: Table<SessionRow, string>;
  entries!: Table<SessionEntry, [string, number]>;
  preferences!: Table<PreferenceRow, [string, string]>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      sessions: '&id, updatedAt',
      entries: '&[sessionId+seq], sessionId',
    });
    this.version(2).stores({
      sessions: '&id, updatedAt',
      entries: '&[sessionId+seq], sessionId',
      features: '&sessionId',
    });
    this.version(3).stores({
      sessions: '&id, updatedAt',
      entries: '&[sessionId+seq], sessionId',
      features: '&sessionId',
      mcpToggles: '&sessionId',
    });
    // v4 — features + mcpToggles drop; unified preferences table replaces them.
    // Existing dev-only data on disk is dropped (the migration deletes the
    // legacy tables). Per-session toggles reset to defaults on first load.
    this.version(4)
      .stores({
        sessions: '&id, updatedAt',
        entries: '&[sessionId+seq], sessionId',
        features: null,
        mcpToggles: null,
        preferences: '&[sessionId+key], sessionId',
      })
      .upgrade(() => {
        // No data carry-over — toggles re-default on first use.
      });
  }
}

export interface OpenSessionDbOptions {
  dbName?: string;
}

export function openSessionDb(options: OpenSessionDbOptions = {}): SessionStoreDb {
  const dbName = options.dbName ?? DEFAULT_SESSION_DB_NAME;
  return new SessionStoreDb(dbName);
}
