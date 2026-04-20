/**
 * SessionManager — thin wrapper over a `SessionStore` that owns the
 * in-memory tree state (fileEntries, byId, labels, leaf pointer) for a
 * single active session.
 *
 * Responsibilities:
 *   - Track the current leaf pointer so callers don't have to.
 *   - Mirror each append into an in-memory cache so reads (`getBranch`,
 *     `getTree`, `buildSessionContext`) are synchronous and cheap.
 *   - Surface the full `ReadonlySessionManager` shape so extensions (M8)
 *     see the same contract coding-agent ships.
 *
 * Differences from the M5 ZenFS/JSONL version (superseded by Dexie):
 *   - Persistence is delegated to `SessionStore`; no `fs/promises`, no
 *     lazy-flush window, no write-chain serialisation (each IDB append
 *     is its own atomic transaction).
 *   - Factories shrank to `create` + `load`; file-path static helpers
 *     (`open`, `list`, `delete`, `inMemory`) are gone — callers work
 *     directly with `SessionStore` for those.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent, TextContent } from '@mariozechner/pi-ai';
import type { SessionStore } from './store';
import {
  CURRENT_SESSION_VERSION,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type LabelEntry,
  type ModelChangeEntry,
  type NewSessionOptions,
  type ReadonlySessionManager,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
  type SessionInfoEntry,
  type SessionMessageEntry,
  type SessionTreeNode,
  type ThinkingLevelChangeEntry,
} from './types';

const DEFAULT_CWD = '/vault';

interface SessionManagerArgs {
  store: SessionStore;
  sessionId: string;
  cwd: string;
  parentSession?: string;
  createdAt: string;
  name: string | null;
  entries: SessionEntry[];
}

export class SessionManager implements ReadonlySessionManager {
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly cwd: string;
  private readonly parentSession?: string;
  private readonly createdAt: string;
  private name: string | null;

  private fileEntries: SessionEntry[] = [];
  private byId = new Map<string, SessionEntry>();
  private labelsById = new Map<string, string>();
  private labelTimestampsById = new Map<string, string>();
  private leafId: string | null = null;

  private constructor(args: SessionManagerArgs) {
    this.store = args.store;
    this.sessionId = args.sessionId;
    this.cwd = args.cwd;
    this.parentSession = args.parentSession;
    this.createdAt = args.createdAt;
    this.name = args.name;
    this.fileEntries = [...args.entries];
    this._buildIndex();
  }

  // ==========================================================================
  // Factories
  // ==========================================================================

  static async create(
    store: SessionStore,
    options: NewSessionOptions & { cwd?: string } = {}
  ): Promise<SessionManager> {
    const row = await store.createSession({
      id: options.id,
      cwd: options.cwd ?? DEFAULT_CWD,
      parentSession: options.parentSession,
    });
    return new SessionManager({
      store,
      sessionId: row.id,
      cwd: row.cwd,
      parentSession: row.parentSession ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      name: row.name,
      entries: [],
    });
  }

  static async load(store: SessionStore, sessionId: string): Promise<SessionManager> {
    const row = await store.getSession(sessionId);
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const entries = await store.getEntries(sessionId);
    return new SessionManager({
      store,
      sessionId: row.id,
      cwd: row.cwd,
      parentSession: row.parentSession ?? undefined,
      createdAt: new Date(row.createdAt).toISOString(),
      name: row.name,
      entries,
    });
  }

  // ==========================================================================
  // ReadonlySessionManager surface
  // ==========================================================================

  getCwd(): string {
    return this.cwd;
  }

  /** Legacy: the filesystem-backed manager used this for path arithmetic. Store-backed returns ''. */
  getSessionDir(): string {
    return '';
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Legacy: returns undefined for store-backed sessions (no JSONL file path). */
  getSessionFile(): string | undefined {
    return undefined;
  }

  getHeader(): SessionHeader | null {
    return {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp: this.createdAt,
      cwd: this.cwd,
      parentSession: this.parentSession,
    };
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.slice();
  }

  getEntry(id: string): SessionEntry | undefined {
    return this.byId.get(id);
  }

  getLeafId(): string | null {
    return this.leafId;
  }

  getLeafEntry(): SessionEntry | undefined {
    return this.leafId ? this.byId.get(this.leafId) : undefined;
  }

  getLabel(id: string): string | undefined {
    return this.labelsById.get(id);
  }

  getBranch(fromId?: string): SessionEntry[] {
    const path: SessionEntry[] = [];
    const startId = fromId ?? this.leafId;
    let current = startId ? this.byId.get(startId) : undefined;
    while (current) {
      path.unshift(current);
      current = current.parentId ? this.byId.get(current.parentId) : undefined;
    }
    return path;
  }

  getTree(): SessionTreeNode[] {
    const entries = this.fileEntries;
    const nodeMap = new Map<string, SessionTreeNode>();
    const roots: SessionTreeNode[] = [];
    for (const entry of entries) {
      const label = this.labelsById.get(entry.id);
      const labelTimestamp = this.labelTimestampsById.get(entry.id);
      nodeMap.set(entry.id, { entry, children: [], label, labelTimestamp });
    }
    for (const entry of entries) {
      const node = nodeMap.get(entry.id);
      if (!node) continue;
      if (entry.parentId === null || entry.parentId === entry.id) {
        roots.push(node);
        continue;
      }
      const parent = nodeMap.get(entry.parentId);
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  getSessionName(): string | undefined {
    for (let i = this.fileEntries.length - 1; i >= 0; i--) {
      const e = this.fileEntries[i];
      if (e.type === 'session_info') {
        const trimmed = (e as SessionInfoEntry).name?.trim();
        if (trimmed) return trimmed;
      }
    }
    return this.name?.trim() || undefined;
  }

  buildSessionContext(): SessionContext {
    const path = this.getBranch();
    const messages: AgentMessage[] = [];
    let thinkingLevel = 'off';
    let model: { provider: string; modelId: string } | null = null;
    for (const entry of path) {
      if (entry.type === 'message') {
        messages.push((entry as SessionMessageEntry).message);
      } else if (entry.type === 'model_change') {
        const m = entry as ModelChangeEntry;
        model = { provider: m.provider, modelId: m.modelId };
      } else if (entry.type === 'thinking_level_change') {
        thinkingLevel = (entry as ThinkingLevelChangeEntry).thinkingLevel;
      }
    }
    return { messages, thinkingLevel, model };
  }

  // ==========================================================================
  // Append methods — delegate to store, mirror in-memory cache
  // ==========================================================================

  async appendMessage(message: AgentMessage): Promise<string> {
    const parentId = this.leafId;
    const id = await this.store.appendMessage(this.sessionId, message, parentId);
    const entry: SessionMessageEntry = {
      type: 'message',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      message,
    };
    this._cacheEntry(entry);
    return id;
  }

  async appendModelChange(provider: string, modelId: string): Promise<string> {
    const parentId = this.leafId;
    const id = await this.store.appendModelChange(this.sessionId, provider, modelId, parentId);
    const entry: ModelChangeEntry = {
      type: 'model_change',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this._cacheEntry(entry);
    return id;
  }

  async appendThinkingLevelChange(thinkingLevel: string): Promise<string> {
    const parentId = this.leafId;
    const id = await this.store.appendThinkingLevelChange(this.sessionId, thinkingLevel, parentId);
    const entry: ThinkingLevelChangeEntry = {
      type: 'thinking_level_change',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    };
    this._cacheEntry(entry);
    return id;
  }

  async appendSessionInfo(name: string): Promise<string> {
    const parentId = this.leafId;
    const trimmed = name.trim();
    const id = await this.store.appendSessionInfo(this.sessionId, trimmed, parentId);
    const entry: SessionInfoEntry = {
      type: 'session_info',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      name: trimmed,
    };
    this._cacheEntry(entry);
    this.name = trimmed || null;
    return id;
  }

  async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
    const parentId = this.leafId;
    const id = await this.store.appendCustomEntry(this.sessionId, customType, data, parentId);
    const entry: CustomEntry = {
      type: 'custom',
      customType,
      data,
      id,
      parentId,
      timestamp: new Date().toISOString(),
    };
    this._cacheEntry(entry);
    return id;
  }

  async appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: T
  ): Promise<string> {
    const parentId = this.leafId;
    const id = await this.store.appendCustomMessageEntry(
      this.sessionId,
      { customType, content, display, details },
      parentId
    );
    const entry: CustomMessageEntry<T> = {
      type: 'custom_message',
      customType,
      content,
      display,
      details,
      id,
      parentId,
      timestamp: new Date().toISOString(),
    };
    this._cacheEntry(entry);
    return id;
  }

  async appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean
  ): Promise<string> {
    const parentId = this.leafId;
    const id = await this.store.appendCompaction(
      this.sessionId,
      { summary, firstKeptEntryId, tokensBefore, details, fromHook },
      parentId
    );
    const entry: CompactionEntry<T> = {
      type: 'compaction',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    };
    this._cacheEntry(entry);
    return id;
  }

  async appendBranchSummary<T = unknown>(
    branchFromId: string | null,
    summary: string,
    details?: T,
    fromHook?: boolean
  ): Promise<string> {
    const parentId = branchFromId;
    const id = await this.store.appendBranchSummary(
      this.sessionId,
      { fromId: branchFromId ?? 'root', summary, details, fromHook },
      parentId
    );
    const entry: BranchSummaryEntry<T> = {
      type: 'branch_summary',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? 'root',
      summary,
      details,
      fromHook,
    };
    this._cacheEntry(entry);
    return id;
  }

  async appendLabelChange(targetId: string, label: string | undefined): Promise<string> {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const parentId = this.leafId;
    const id = await this.store.appendLabel(this.sessionId, targetId, label, parentId);
    const entry: LabelEntry = {
      type: 'label',
      id,
      parentId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this._cacheEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return id;
  }

  /**
   * Legacy compatibility shim — the old file-backed manager had a write
   * queue that callers drained before switching sessions. Store-backed
   * appends await inline, so there is nothing to flush; kept as a no-op
   * so existing call-sites continue to compile.
   */
  async flush(): Promise<void> {
    // noop
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private _cacheEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
  }

  private _buildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      this.byId.set(entry.id, entry);
      this.leafId = entry.id;
      if (entry.type === 'label') {
        const l = entry as LabelEntry;
        if (l.label) {
          this.labelsById.set(l.targetId, l.label);
          this.labelTimestampsById.set(l.targetId, l.timestamp);
        } else {
          this.labelsById.delete(l.targetId);
          this.labelTimestampsById.delete(l.targetId);
        }
      }
    }
  }
}
