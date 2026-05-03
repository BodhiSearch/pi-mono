import Dexie, { type Table } from 'dexie';
import type { FeatureRow, McpTogglesRow, SessionEntry, SessionRow } from '@bodhiapp/web-acp-agent';

/**
 * Dexie/IndexedDB schema backing the browser host's `SessionStore`,
 * `FeatureStore`, and `McpToggleStore`. The table shapes mirror the
 * agent-package interfaces; nothing here is loaded into the agent
 * itself — host code in `runtime/storage-dexie/*-store.ts` adapts
 * Dexie tables to the agent's interfaces.
 *
 * Schema versions:
 *   v1 — sessions + entries.
 *   v2 — per-session features table.
 *   v3 — per-session mcpToggles table.
 *
 * `dbName` defaults to `'web-acp'`; do NOT rename this without a
 * migration plan — the constant is on-disk identity for every
 * existing installation.
 */
export const DEFAULT_SESSION_DB_NAME = 'web-acp';

export class SessionStoreDb extends Dexie {
  sessions!: Table<SessionRow, string>;
  entries!: Table<SessionEntry, [string, number]>;
  features!: Table<FeatureRow, string>;
  mcpToggles!: Table<McpTogglesRow, string>;

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
  }
}

export interface OpenSessionDbOptions {
  dbName?: string;
}

export function openSessionDb(options: OpenSessionDbOptions = {}): SessionStoreDb {
  const dbName = options.dbName ?? DEFAULT_SESSION_DB_NAME;
  return new SessionStoreDb(dbName);
}
