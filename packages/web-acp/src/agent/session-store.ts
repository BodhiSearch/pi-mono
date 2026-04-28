import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import Dexie, { type Table } from 'dexie';
import type { AnyBodhiBuiltinAction } from '@/acp';

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

// Adding a new kind here is on-disk compatible: the `entries` table
// stores `payload` as a polymorphic blob keyed only by `[sessionId+seq]`,
// so introducing `'builtin'` (M4 phase B) does not require a Dexie
// version bump. Old DBs that never wrote a 'builtin' row read back
// the same shape as before.
export type SessionEntryKind = 'notification' | 'turn' | 'builtin';

export interface TurnPayload {
  userText: string;
  finalMessages: AgentMessage[];
  modelId: string;
}

/**
 * Persisted record of a built-in slash-command exchange (M4 phase B).
 * Built-ins bypass the LLM — the worker recognises `/help` etc. in
 * `prompt()`, runs a handler, and writes one of these instead of a
 * `'turn'` entry. Because they are not `'turn'` entries, they are
 * naturally invisible to `inline.restoreMessages()` on reload, which
 * keeps the LLM blind to built-in exchanges on subsequent prompts.
 *
 * `action` is an optional client-action descriptor (e.g.
 * `{ kind: 'copy' }`); the client builds the actual payload at
 * dispatch time. `kind` is open-ended for future commands like
 * `/share`, `/export-html`, `/feedback`.
 */
export interface BuiltinPayload {
  command: string;
  userText: string;
  replyText: string;
  action?: AnyBodhiBuiltinAction;
}

export interface SessionEntry {
  sessionId: string;
  seq: number;
  at: number;
  kind: SessionEntryKind;
  payload: SessionNotification | TurnPayload | BuiltinPayload;
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
 * Per-session feature toggle row stored alongside sessions. Added in
 * M2 phase B; see `src/features/feature-store.ts` for the wrapper
 * contract and `features.md` for the public wire shape.
 */
export interface FeatureRow {
  sessionId: string;
  flags: Record<string, boolean>;
  updatedAt: number;
}

/**
 * Per-session MCP toggle row — one entry per ACP session storing the
 * user's per-server on/off flags and, nested under each server slug,
 * per-tool on/off flags. Added in M3 phase B (Dexie v3); see
 * `src/mcp/toggle-store.ts` for the wrapper contract and
 * `specs/web-acp/mcp.md` for the public wire shape returned by
 * `bodhi/getSession` + mutated via `_bodhi/mcp/toggles/set`.
 *
 * Semantics:
 * - **Absent keys mean "default on".** We never materialise a
 *   `true` entry just to mirror the default — that way the ACP wire
 *   shape stays compact and newly-discovered servers/tools opt in
 *   automatically.
 * - `servers[slug] === false` → skip server in the composed
 *   `McpServerHttp[]` passed to `session/load`.
 * - `tools[slug][toolName] === false` → server stays registered but
 *   that specific tool is filtered from the adapter's `setModel`
 *   registration.
 */
export interface McpTogglesRow {
  sessionId: string;
  servers: Record<string, boolean>;
  tools: Record<string, Record<string, boolean>>;
  updatedAt: number;
}

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
  listSummaries(): Promise<SessionSummary[]>;
  readEntries(id: string): Promise<SessionEntry[]>;
  getSession(id: string): Promise<SessionRow | undefined>;
  setTitle(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

export interface CreateSessionStoreOptions {
  dbName?: string;
}

export function openSessionDb(options: CreateSessionStoreOptions = {}): SessionStoreDb {
  const dbName = options.dbName ?? 'web-acp';
  return new SessionStoreDb(dbName);
}

export function createSessionStore(options: CreateSessionStoreOptions = {}): SessionStore {
  return createStoreFromDb(openSessionDb(options));
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

    async recordBuiltin(id, payload, at = Date.now()) {
      await db.transaction('rw', db.sessions, db.entries, async () => {
        const session = await db.sessions.get(id);
        if (!session) {
          throw new Error(`SessionStore.recordBuiltin: unknown session '${id}'`);
        }
        const seq = await nextSeq(db, id);
        await db.entries.put({ sessionId: id, seq, at, kind: 'builtin', payload });
        // Bumps `updatedAt` so the picker reflects activity, but does
        // NOT bump `turnCount` (this isn't a model turn) and does NOT
        // claim the title slot (the first real prompt still wins).
        await db.sessions.update(id, { updatedAt: at });
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
      await db.transaction('rw', db.sessions, db.entries, db.features, db.mcpToggles, async () => {
        await db.entries.where('sessionId').equals(id).delete();
        await db.features.delete(id);
        await db.mcpToggles.delete(id);
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
