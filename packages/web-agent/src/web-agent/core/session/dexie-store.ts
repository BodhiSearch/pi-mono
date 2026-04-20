/**
 * Dexie-backed SessionStore.
 *
 * Schema:
 *   sessions: 'id, modifiedAt'
 *     — pk `id`, secondary index on `modifiedAt` for list ordering.
 *   entries: '[sessionId+id], sessionId, [sessionId+timestamp], [sessionId+type]'
 *     — compound pk `[sessionId+id]` for direct fetch, `sessionId` to gather
 *       all entries for a session, `[sessionId+timestamp]` for chronological
 *       reads, `[sessionId+type]` for `type`-scoped queries (M7/M8).
 *
 * Every append runs in a `rw` transaction that also bumps `sessions.modifiedAt`,
 * so the list ordering stays consistent with the entry log.
 *
 * `observeSessionList` and `observeEntries` wrap Dexie's `liveQuery`, which
 * uses BroadcastChannel internally to fan out invalidations across contexts
 * (Worker ↔ Main, tab A ↔ tab B).
 */

import Dexie, { liveQuery, type Subscription, type Table } from 'dexie';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { generateEntryId, generateSessionId } from './ids';
import type {
  BranchSummaryAppend,
  CompactionAppend,
  CreateSessionOptions,
  CustomMessageAppend,
  EntryRow,
  ForkSessionOptions,
  SessionRow,
  SessionStore,
} from './store';
import { walkPathToEntry } from './tree';
import {
  CURRENT_SESSION_VERSION,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type LabelEntry,
  type ModelChangeEntry,
  type SessionEntry,
  type SessionInfoEntry,
  type SessionMessageEntry,
  type SessionSummary,
  type ThinkingLevelChangeEntry,
} from './types';

export const DEFAULT_DB_NAME = 'web-agent';

export class WebAgentDB extends Dexie {
  sessions!: Table<SessionRow, string>;
  entries!: Table<EntryRow, [string, string]>;

  constructor(name: string = DEFAULT_DB_NAME) {
    super(name);
    this.version(1).stores({
      sessions: 'id, modifiedAt',
      entries: '[sessionId+id], sessionId, [sessionId+timestamp], [sessionId+type]',
    });
  }
}

export class DexieSessionStore implements SessionStore {
  private readonly db: WebAgentDB;
  /**
   * Per-session last-used numeric timestamp. Guarantees strict monotonic
   * ordering when two entries are produced inside the same millisecond
   * (Date.now() ties would otherwise flip under Dexie's compound-index
   * secondary sort, which is the random entry `id`).
   */
  private readonly lastTimestamp = new Map<string, number>();

  constructor(db: WebAgentDB = new WebAgentDB()) {
    this.db = db;
  }

  /** Close the underlying Dexie connection. Tests reuse instances so only call when truly done. */
  close(): void {
    this.db.close();
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionRow> {
    const now = Date.now();
    const row: SessionRow = {
      id: opts.id ?? generateSessionId(),
      name: null,
      cwd: opts.cwd,
      parentSession: opts.parentSession ?? null,
      createdAt: now,
      modifiedAt: now,
      entryVersion: CURRENT_SESSION_VERSION,
    };
    await this.db.sessions.add(row);
    return { ...row };
  }

  async forkSession(opts: ForkSessionOptions): Promise<SessionRow> {
    return this.db.transaction('rw', [this.db.sessions, this.db.entries], async () => {
      const source = await this.db.sessions.get(opts.sourceSessionId);
      if (!source) throw new Error(`Session not found: ${opts.sourceSessionId}`);

      const sourceEntries = await this.getEntries(opts.sourceSessionId);
      const path = walkPathToEntry(sourceEntries, opts.upToEntryId);

      const now = Date.now();
      const newRow: SessionRow = {
        id: opts.id ?? generateSessionId(),
        name: null,
        cwd: source.cwd,
        parentSession: source.id,
        createdAt: now,
        modifiedAt: now,
        entryVersion: source.entryVersion,
      };
      await this.db.sessions.add(newRow);

      let maxTs = 0;
      for (const entry of path) {
        if (entry.type === 'label') continue;
        const ts = Date.parse(entry.timestamp);
        if (ts > maxTs) maxTs = ts;
        // Bypass _writeEntry's monotonic-timestamp bump so copied timestamps
        // stay verbatim — critical for preserving causal ordering in the fork.
        await this.db.entries.add({
          sessionId: newRow.id,
          id: entry.id,
          parentId: entry.parentId,
          timestamp: ts,
          type: entry.type,
          data: entry,
        });
      }
      // Seed the monotonic cursor so future appends on the child stay > copied entries.
      if (maxTs > 0) this.lastTimestamp.set(newRow.id, maxTs);

      return { ...newRow };
    });
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.db.transaction('rw', [this.db.sessions, this.db.entries], async () => {
      await this.db.sessions.delete(sessionId);
      await this.db.entries.where({ sessionId }).delete();
    });
  }

  async setSessionName(sessionId: string, name: string, parentId: string | null): Promise<string> {
    const trimmed = name.trim();
    return this._appendInTx(sessionId, async () => {
      const entry: SessionInfoEntry = {
        type: 'session_info',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        name: trimmed,
      };
      await this._writeEntry(sessionId, entry);
      await this.db.sessions.update(sessionId, { name: trimmed || null });
      return entry.id;
    });
  }

  async touchSession(sessionId: string): Promise<void> {
    await this.db.sessions.update(sessionId, { modifiedAt: Date.now() });
  }

  async listSessions(): Promise<SessionSummary[]> {
    return this._buildSummaries();
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const row = await this.db.sessions.get(sessionId);
    return row ?? null;
  }

  async getEntries(sessionId: string): Promise<SessionEntry[]> {
    const rows = await this.db.entries
      .where('[sessionId+timestamp]')
      .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
      .toArray();
    return rows.map(r => r.data);
  }

  async getEntry(sessionId: string, entryId: string): Promise<SessionEntry | null> {
    const row = await this.db.entries.get([sessionId, entryId]);
    return row ? row.data : null;
  }

  async appendMessage(
    sessionId: string,
    message: AgentMessage,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: SessionMessageEntry = {
        type: 'message',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        message,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  async appendModelChange(
    sessionId: string,
    provider: string,
    modelId: string,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: ModelChangeEntry = {
        type: 'model_change',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        provider,
        modelId,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  async appendThinkingLevelChange(
    sessionId: string,
    thinkingLevel: string,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: ThinkingLevelChangeEntry = {
        type: 'thinking_level_change',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        thinkingLevel,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  async appendSessionInfo(
    sessionId: string,
    name: string,
    parentId: string | null
  ): Promise<string> {
    const trimmed = name.trim();
    return this._appendInTx(sessionId, async () => {
      const entry: SessionInfoEntry = {
        type: 'session_info',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        name: trimmed,
      };
      await this._writeEntry(sessionId, entry);
      await this.db.sessions.update(sessionId, { name: trimmed || null });
      return entry.id;
    });
  }

  async appendCompaction(
    sessionId: string,
    payload: CompactionAppend,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: CompactionEntry = {
        type: 'compaction',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        ...payload,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  async appendBranchSummary(
    sessionId: string,
    payload: BranchSummaryAppend,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: BranchSummaryEntry = {
        type: 'branch_summary',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        ...payload,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  async appendLabel(
    sessionId: string,
    targetId: string,
    label: string | undefined,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: LabelEntry = {
        type: 'label',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        targetId,
        label,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  async appendCustomEntry(
    sessionId: string,
    customType: string,
    data: unknown,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: CustomEntry = {
        type: 'custom',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        customType,
        data,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  async appendCustomMessageEntry(
    sessionId: string,
    payload: CustomMessageAppend,
    parentId: string | null
  ): Promise<string> {
    return this._appendInTx(sessionId, async () => {
      const entry: CustomMessageEntry = {
        type: 'custom_message',
        id: await this._allocateEntryId(sessionId),
        parentId,
        timestamp: new Date().toISOString(),
        ...payload,
      };
      await this._writeEntry(sessionId, entry);
      return entry.id;
    });
  }

  observeSessionList(cb: (summaries: SessionSummary[]) => void): () => void {
    const subscription: Subscription = liveQuery(() => this._buildSummaries()).subscribe({
      next: value => cb(value),
      error: err => console.error('[DexieSessionStore] observeSessionList error:', err),
    });
    return () => subscription.unsubscribe();
  }

  observeEntries(sessionId: string, cb: (entries: SessionEntry[]) => void): () => void {
    const subscription: Subscription = liveQuery(() => this.getEntries(sessionId)).subscribe({
      next: value => cb(value),
      error: err => console.error('[DexieSessionStore] observeEntries error:', err),
    });
    return () => subscription.unsubscribe();
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  /** Runs `fn` inside a `rw` tx over sessions+entries; bumps modifiedAt. */
  private async _appendInTx<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.transaction('rw', [this.db.sessions, this.db.entries], async () => {
      const exists = await this.db.sessions.get(sessionId);
      if (!exists) throw new Error(`Session not found: ${sessionId}`);
      const result = await fn();
      await this.db.sessions.update(sessionId, { modifiedAt: Date.now() });
      return result;
    });
  }

  private async _writeEntry(sessionId: string, entry: SessionEntry): Promise<void> {
    const prev = this.lastTimestamp.get(sessionId) ?? 0;
    const numericTimestamp = Math.max(Date.now(), prev + 1);
    this.lastTimestamp.set(sessionId, numericTimestamp);
    const patched = {
      ...entry,
      timestamp: new Date(numericTimestamp).toISOString(),
    } as SessionEntry;
    const row: EntryRow = {
      sessionId,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: numericTimestamp,
      type: entry.type,
      data: patched,
    };
    await this.db.entries.add(row);
  }

  private async _allocateEntryId(sessionId: string): Promise<string> {
    const existing = await this.db.entries
      .where('[sessionId+timestamp]')
      .between([sessionId, Dexie.minKey], [sessionId, Dexie.maxKey])
      .primaryKeys();
    const ids = new Set(existing.map(([, id]) => id));
    return generateEntryId({ has: id => ids.has(id) });
  }

  private async _buildSummaries(): Promise<SessionSummary[]> {
    const rows = await this.db.sessions.orderBy('modifiedAt').reverse().toArray();
    if (rows.length === 0) return [];

    const sessionIds = rows.map(r => r.id);
    const allEntries = await this.db.entries.where('sessionId').anyOf(sessionIds).toArray();
    const byId = new Map<string, EntryRow[]>();
    for (const e of allEntries) {
      const list = byId.get(e.sessionId);
      if (list) list.push(e);
      else byId.set(e.sessionId, [e]);
    }

    return rows.map(row => buildSummary(row, byId.get(row.id) ?? []));
  }
}

function buildSummary(row: SessionRow, rows: EntryRow[]): SessionSummary {
  let messageCount = 0;
  let firstMessage = '';
  let name: string | undefined = row.name ?? undefined;
  const sorted = rows.slice().sort((a, b) => a.timestamp - b.timestamp);
  for (const r of sorted) {
    const e = r.data;
    if (e.type === 'session_info') {
      const infoName = (e as SessionInfoEntry).name?.trim();
      if (infoName) name = infoName;
      continue;
    }
    if (e.type !== 'message') continue;
    messageCount++;
    if (!firstMessage) {
      const msg = (e as SessionMessageEntry).message;
      if ((msg as { role?: string }).role === 'user') {
        firstMessage = extractText(msg);
      }
    }
  }
  return {
    id: row.id,
    path: row.id,
    name,
    cwd: row.cwd,
    created: new Date(row.createdAt).toISOString(),
    modified: new Date(row.modifiedAt).toISOString(),
    messageCount,
    firstMessage: firstMessage || '(no messages)',
    parentSessionPath: row.parentSession ?? undefined,
  };
}

function extractText(message: AgentMessage): string {
  const m = message as { content?: unknown };
  if (typeof m.content === 'string') return m.content;
  if (!Array.isArray(m.content)) return '';
  return m.content
    .filter(
      (b: unknown): b is { type: 'text'; text: string } =>
        !!b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
    )
    .map(b => b.text)
    .join(' ');
}
