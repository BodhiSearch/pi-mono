import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import Dexie, { type Table } from 'dexie';

/**
 * Worker-owned persistence for ACP sessions.
 *
 * The object of record is whatever `session/new` returned plus the
 * transcript of `session/update` events. We store:
 *
 * - `sessions`: one row per ACP session with cached derived fields
 *   (title, turnCount, lastModelId, createdAt, updatedAt) so the
 *   session picker can render without scanning entries.
 * - `entries`: append-only log of two kinds — `notification` (raw
 *   `SessionNotification` payload as emitted by the adapter) and
 *   `turn` (synthetic end-of-turn summary with `userText`,
 *   `finalMessages` from `InlineAgent.getMessages()`, and the
 *   `modelId` the turn ran against). The `turn` entry is what lets
 *   `session/load` restore both the transcript and the last-used
 *   model so the UI re-selects it.
 *
 * There is **no** bespoke `schemaVersion` column — ACP does not define
 * one at this granularity and inventing one now would only complicate
 * migration later. If the on-disk shape ever drifts, we'll add version
 * gating in the milestone that needs it.
 */

export type SessionEntryKind = 'notification' | 'turn';

export interface TurnPayload {
  userText: string;
  finalMessages: AgentMessage[];
  modelId: string;
}

export interface SessionEntry {
  sessionId: string;
  seq: number;
  at: number;
  kind: SessionEntryKind;
  payload: SessionNotification | TurnPayload;
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

export class SessionStoreDb extends Dexie {
  sessions!: Table<SessionRow, string>;
  entries!: Table<SessionEntry, [string, number]>;

  constructor(dbName: string) {
    super(dbName);
    this.version(1).stores({
      sessions: '&id, updatedAt',
      entries: '&[sessionId+seq], sessionId',
    });
  }
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
  listSummaries(): Promise<SessionSummary[]>;
  readEntries(id: string): Promise<SessionEntry[]>;
  getSession(id: string): Promise<SessionRow | undefined>;
  setTitle(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export interface CreateSessionStoreOptions {
  dbName?: string;
}

export function createSessionStore(options: CreateSessionStoreOptions = {}): SessionStore {
  const dbName = options.dbName ?? 'web-acp';
  const db = new SessionStoreDb(dbName);
  return createStoreFromDb(db);
}

export function createStoreFromDb(db: SessionStoreDb): SessionStore {
  return {
    async createSession(id, at = Date.now()) {
      await db.sessions.put({
        id,
        createdAt: at,
        updatedAt: at,
        title: null,
        turnCount: 0,
        lastModelId: null,
      });
    },

    async recordNotification(id, notification, at = Date.now()) {
      await db.transaction('rw', db.sessions, db.entries, async () => {
        const session = await db.sessions.get(id);
        if (!session) {
          throw new Error(`SessionStore.recordNotification: unknown session '${id}'`);
        }
        const seq = await nextSeq(db, id);
        await db.entries.put({
          sessionId: id,
          seq,
          at,
          kind: 'notification',
          payload: notification,
        });
        await db.sessions.update(id, { updatedAt: at });
      });
    },

    async recordTurn(id, userText, finalMessages, modelId, at = Date.now()) {
      await db.transaction('rw', db.sessions, db.entries, async () => {
        const session = await db.sessions.get(id);
        if (!session) {
          throw new Error(`SessionStore.recordTurn: unknown session '${id}'`);
        }
        const seq = await nextSeq(db, id);
        const payload: TurnPayload = { userText, finalMessages, modelId };
        await db.entries.put({ sessionId: id, seq, at, kind: 'turn', payload });
        const nextTitle = session.title ?? (session.turnCount === 0 ? deriveTitle(userText) : null);
        await db.sessions.update(id, {
          updatedAt: at,
          turnCount: session.turnCount + 1,
          title: nextTitle,
          lastModelId: modelId,
        });
      });
    },

    async listSummaries() {
      const rows = await db.sessions.orderBy('updatedAt').reverse().toArray();
      return rows.map(row => ({
        id: row.id,
        title: row.title,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        turnCount: row.turnCount,
        lastModelId: row.lastModelId,
      }));
    },

    async readEntries(id) {
      return db.entries.where('sessionId').equals(id).sortBy('seq');
    },

    async getSession(id) {
      return db.sessions.get(id);
    },

    async setTitle(id, title) {
      await db.sessions.update(id, { title, updatedAt: Date.now() });
    },

    async deleteSession(id) {
      await db.transaction('rw', db.sessions, db.entries, async () => {
        await db.entries.where('sessionId').equals(id).delete();
        await db.sessions.delete(id);
      });
    },
  };
}

async function nextSeq(db: SessionStoreDb, sessionId: string): Promise<number> {
  // Called from inside a `rw` transaction on `entries`. Dexie serialises
  // writes on a table within a transaction, so `count()` + `seq = count`
  // is monotonic as long as entries for a given session are never
  // individually deleted (only whole-session deletion).
  return db.entries.where('sessionId').equals(sessionId).count();
}
