/**
 * In-memory SessionStore — used by unit tests and jsdom where IndexedDB is
 * absent (or where the test would rather not pay the fake-indexeddb cost).
 *
 * Contract parity with `DexieSessionStore` is validated by the parallel
 * test suites (`memory-store.test.ts` + `dexie-store.test.ts`).
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { generateEntryId, generateSessionId } from './ids';
import type {
  BranchSummaryAppend,
  CompactionAppend,
  CreateSessionOptions,
  CustomMessageAppend,
  EntryRow,
  SessionRow,
  SessionStore,
} from './store';
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

export class MemorySessionStore implements SessionStore {
  private readonly sessions = new Map<string, SessionRow>();
  private readonly entries = new Map<string, EntryRow[]>();

  async createSession(opts: CreateSessionOptions): Promise<SessionRow> {
    const now = Date.now();
    const id = opts.id ?? generateSessionId();
    const row: SessionRow = {
      id,
      name: null,
      cwd: opts.cwd,
      parentSession: opts.parentSession ?? null,
      createdAt: now,
      modifiedAt: now,
      entryVersion: CURRENT_SESSION_VERSION,
    };
    this.sessions.set(id, row);
    this.entries.set(id, []);
    return { ...row };
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
    this.entries.delete(sessionId);
  }

  async setSessionName(sessionId: string, name: string, parentId: string | null): Promise<string> {
    const row = this.sessions.get(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const trimmed = name.trim();
    const entry: SessionInfoEntry = {
      type: 'session_info',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      name: trimmed,
    };
    const id = this._appendEntry(sessionId, entry);
    row.name = trimmed || null;
    return id;
  }

  async touchSession(sessionId: string): Promise<void> {
    const row = this.sessions.get(sessionId);
    if (!row) return;
    row.modifiedAt = Date.now();
  }

  async listSessions(): Promise<SessionSummary[]> {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.modifiedAt - a.modifiedAt)
      .map(row => this._buildSummary(row));
  }

  async getSession(sessionId: string): Promise<SessionRow | null> {
    const row = this.sessions.get(sessionId);
    return row ? { ...row } : null;
  }

  async getEntries(sessionId: string): Promise<SessionEntry[]> {
    const rows = this.entries.get(sessionId);
    return rows ? rows.map(r => r.data) : [];
  }

  async getEntry(sessionId: string, entryId: string): Promise<SessionEntry | null> {
    const rows = this.entries.get(sessionId);
    if (!rows) return null;
    const row = rows.find(r => r.id === entryId);
    return row ? row.data : null;
  }

  async appendMessage(
    sessionId: string,
    message: AgentMessage,
    parentId: string | null
  ): Promise<string> {
    const entry: SessionMessageEntry = {
      type: 'message',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      message,
    };
    return this._appendEntry(sessionId, entry);
  }

  async appendModelChange(
    sessionId: string,
    provider: string,
    modelId: string,
    parentId: string | null
  ): Promise<string> {
    const entry: ModelChangeEntry = {
      type: 'model_change',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    return this._appendEntry(sessionId, entry);
  }

  async appendThinkingLevelChange(
    sessionId: string,
    thinkingLevel: string,
    parentId: string | null
  ): Promise<string> {
    const entry: ThinkingLevelChangeEntry = {
      type: 'thinking_level_change',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    };
    return this._appendEntry(sessionId, entry);
  }

  async appendSessionInfo(
    sessionId: string,
    name: string,
    parentId: string | null
  ): Promise<string> {
    const row = this.sessions.get(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const trimmed = name.trim();
    const entry: SessionInfoEntry = {
      type: 'session_info',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      name: trimmed,
    };
    const id = this._appendEntry(sessionId, entry);
    row.name = trimmed || null;
    return id;
  }

  async appendCompaction(
    sessionId: string,
    payload: CompactionAppend,
    parentId: string | null
  ): Promise<string> {
    const entry: CompactionEntry = {
      type: 'compaction',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    return this._appendEntry(sessionId, entry);
  }

  async appendBranchSummary(
    sessionId: string,
    payload: BranchSummaryAppend,
    parentId: string | null
  ): Promise<string> {
    const entry: BranchSummaryEntry = {
      type: 'branch_summary',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    return this._appendEntry(sessionId, entry);
  }

  async appendLabel(
    sessionId: string,
    targetId: string,
    label: string | undefined,
    parentId: string | null
  ): Promise<string> {
    const entry: LabelEntry = {
      type: 'label',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    return this._appendEntry(sessionId, entry);
  }

  async appendCustomEntry(
    sessionId: string,
    customType: string,
    data: unknown,
    parentId: string | null
  ): Promise<string> {
    const entry: CustomEntry = {
      type: 'custom',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      customType,
      data,
    };
    return this._appendEntry(sessionId, entry);
  }

  async appendCustomMessageEntry(
    sessionId: string,
    payload: CustomMessageAppend,
    parentId: string | null
  ): Promise<string> {
    const entry: CustomMessageEntry = {
      type: 'custom_message',
      id: this._allocateEntryId(sessionId),
      parentId,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    return this._appendEntry(sessionId, entry);
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private _allocateEntryId(sessionId: string): string {
    const rows = this.entries.get(sessionId);
    const ids = new Set(rows?.map(r => r.id));
    return generateEntryId({ has: (id: string) => ids.has(id) });
  }

  private _appendEntry(sessionId: string, entry: SessionEntry): string {
    const row = this.sessions.get(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const rows = this.entries.get(sessionId);
    if (!rows) throw new Error(`Session entries missing: ${sessionId}`);
    const entryRow: EntryRow = {
      sessionId,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: Date.parse(entry.timestamp),
      type: entry.type,
      data: entry,
    };
    rows.push(entryRow);
    row.modifiedAt = Date.now();
    return entry.id;
  }

  private _buildSummary(row: SessionRow): SessionSummary {
    const rows = this.entries.get(row.id) ?? [];
    let messageCount = 0;
    let firstMessage = '';
    let name: string | undefined = row.name ?? undefined;
    for (const r of rows) {
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
