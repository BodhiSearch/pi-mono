/**
 * SessionManager — browser-native port of `coding-agent/core/session-manager.ts`.
 *
 * Responsibilities:
 *   - Hold the in-memory entry tree (fileEntries, byId, labels, leaf pointer).
 *   - Lazy-flush: buffer entries until the first assistant `message_end`, then
 *     write the full header + entries in one shot. Subsequent entries append
 *     a single JSONL line. Matches coding-agent so abandoned draft sessions
 *     don't pollute the list.
 *   - Serialise async writes through a per-session promise chain so parallel
 *     `appendXXX()` calls produce correctly ordered JSONL lines.
 *   - Ship the full `ReadonlySessionManager` surface — extensions that read
 *     session state through the M8 extension context use this exact shape.
 *
 * Differences from coding-agent we are deliberately keeping:
 *   - `fs/promises` (ZenFS) instead of node sync `appendFileSync`.
 *   - No migrations: browser sessions start at `CURRENT_SESSION_VERSION` 3.
 *   - `buildSessionContext()` handles the common path (message / model /
 *     thinking-level entries). Compaction + branch summaries + custom
 *     messages are scaffolded through the entry types but not synthesised
 *     here — M7/M8 extend this method when they land.
 */

import { fs } from '@zenfs/core';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent, TextContent } from '@mariozechner/pi-ai';
import { generateEntryId, generateSessionId } from './ids';
import {
  CURRENT_SESSION_VERSION,
  type BranchSummaryEntry,
  type CompactionEntry,
  type CustomEntry,
  type CustomMessageEntry,
  type FileEntry,
  type LabelEntry,
  type ModelChangeEntry,
  type NewSessionOptions,
  type ReadonlySessionManager,
  type SessionContext,
  type SessionEntry,
  type SessionHeader,
  type SessionInfoEntry,
  type SessionMessageEntry,
  type SessionSummary,
  type SessionTreeNode,
  type ThinkingLevelChangeEntry,
} from './types';

const DEFAULT_CWD = '/vault';

interface SessionManagerConstructorArgs {
  sessionDir: string;
  sessionFile: string | null;
  cwd: string;
  persist: boolean;
}

/**
 * Manages a single conversation session as an append-only tree stored in a
 * JSONL file under `sessionDir`. See the module header for design notes.
 */
export class SessionManager implements ReadonlySessionManager {
  private sessionId = '';
  private sessionFile: string | null;
  private readonly sessionDir: string;
  private readonly cwd: string;
  private readonly persist: boolean;
  private flushed = false;
  private fileEntries: FileEntry[] = [];
  private byId: Map<string, SessionEntry> = new Map();
  private labelsById: Map<string, string> = new Map();
  private labelTimestampsById: Map<string, string> = new Map();
  private leafId: string | null = null;
  /** Per-session chain that serialises async writes for correct JSONL order. */
  private writeChain: Promise<void> = Promise.resolve();

  private constructor(args: SessionManagerConstructorArgs) {
    this.sessionDir = args.sessionDir;
    this.sessionFile = args.sessionFile;
    this.cwd = args.cwd;
    this.persist = args.persist;
  }

  // ==========================================================================
  // Factories
  // ==========================================================================

  /** Create a fresh session; file is not written until the first flush. */
  static async create(
    sessionDir: string,
    options: NewSessionOptions & { cwd?: string } = {}
  ): Promise<SessionManager> {
    const sm = new SessionManager({
      sessionDir,
      sessionFile: null,
      cwd: options.cwd ?? DEFAULT_CWD,
      persist: true,
    });
    sm.newSession(options);
    return sm;
  }

  /** Open an existing session file and populate in-memory state. */
  static async open(sessionDir: string, filePath: string): Promise<SessionManager> {
    const entries = await parseSessionFile(filePath);
    const header = entries.find(e => e.type === 'session') as SessionHeader | undefined;
    if (!header) {
      throw new Error(`No valid session header in ${filePath}`);
    }
    const sm = new SessionManager({
      sessionDir,
      sessionFile: filePath,
      cwd: header.cwd ?? DEFAULT_CWD,
      persist: true,
    });
    sm.sessionId = header.id;
    sm.fileEntries = entries;
    sm._buildIndex();
    sm.flushed = true;
    return sm;
  }

  /** List every session in `sessionDir`, sorted by modified desc. */
  static async list(sessionDir: string): Promise<SessionSummary[]> {
    let dirEntries: string[];
    try {
      dirEntries = (await fs.promises.readdir(sessionDir)) as string[];
    } catch (err) {
      if (isEnoent(err)) return [];
      throw err;
    }
    const jsonlFiles = dirEntries.filter(name => name.endsWith('.jsonl'));
    const summaries: SessionSummary[] = [];
    for (const name of jsonlFiles) {
      const fullPath = joinPath(sessionDir, name);
      try {
        const summary = await buildSummary(fullPath);
        if (summary) summaries.push(summary);
      } catch {
        // Skip files we can't read or parse.
      }
    }
    summaries.sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    return summaries;
  }

  /** Best-effort delete; absent file is not an error. */
  static async delete(filePath: string): Promise<void> {
    try {
      await fs.promises.unlink(filePath);
    } catch (err) {
      if (isEnoent(err)) return;
      throw err;
    }
  }

  /** Build an ephemeral in-memory session (no file persistence). */
  static inMemory(cwd: string = DEFAULT_CWD): SessionManager {
    const sm = new SessionManager({
      sessionDir: '',
      sessionFile: null,
      cwd,
      persist: false,
    });
    sm.newSession();
    return sm;
  }

  // ==========================================================================
  // Header lifecycle
  // ==========================================================================

  newSession(options?: NewSessionOptions): string | null {
    this.sessionId = options?.id ?? generateSessionId();
    const timestamp = new Date().toISOString();
    const header: SessionHeader = {
      type: 'session',
      version: CURRENT_SESSION_VERSION,
      id: this.sessionId,
      timestamp,
      cwd: this.cwd,
      parentSession: options?.parentSession,
    };
    this.fileEntries = [header];
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    this.flushed = false;
    this.writeChain = Promise.resolve();
    if (this.persist) {
      const fileTimestamp = timestamp.replace(/[:.]/g, '-');
      this.sessionFile = joinPath(this.sessionDir, `${fileTimestamp}_${this.sessionId}.jsonl`);
    } else {
      this.sessionFile = null;
    }
    return this.sessionFile;
  }

  // ==========================================================================
  // ReadonlySessionManager surface
  // ==========================================================================

  getCwd(): string {
    return this.cwd;
  }

  getSessionDir(): string {
    return this.sessionDir;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  getSessionFile(): string | undefined {
    return this.sessionFile ?? undefined;
  }

  getHeader(): SessionHeader | null {
    const h = this.fileEntries.find(e => e.type === 'session');
    return h ? (h as SessionHeader) : null;
  }

  getEntries(): SessionEntry[] {
    return this.fileEntries.filter((e): e is SessionEntry => e.type !== 'session');
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
    const entries = this.getEntries();
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
    const entries = this.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === 'session_info') {
        return (e as SessionInfoEntry).name?.trim() || undefined;
      }
    }
    return undefined;
  }

  /**
   * Build a session context suitable for feeding back into an agent loop.
   * Honors model_change and thinking_level_change ordering; defers
   * compaction / branch_summary / custom_message handling to M7/M8.
   */
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
  // Append methods — sync state update, async persistence
  // ==========================================================================

  appendMessage(message: AgentMessage): string {
    const entry: SessionMessageEntry = {
      type: 'message',
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      message,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendModelChange(provider: string, modelId: string): string {
    const entry: ModelChangeEntry = {
      type: 'model_change',
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      provider,
      modelId,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendThinkingLevelChange(thinkingLevel: string): string {
    const entry: ThinkingLevelChangeEntry = {
      type: 'thinking_level_change',
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      thinkingLevel,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendSessionInfo(name: string): string {
    const entry: SessionInfoEntry = {
      type: 'session_info',
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      name: name.trim(),
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendCustomEntry(customType: string, data?: unknown): string {
    const entry: CustomEntry = {
      type: 'custom',
      customType,
      data,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendCustomMessageEntry<T = unknown>(
    customType: string,
    content: string | (TextContent | ImageContent)[],
    display: boolean,
    details?: T
  ): string {
    const entry: CustomMessageEntry<T> = {
      type: 'custom_message',
      customType,
      content,
      display,
      details,
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendCompaction<T = unknown>(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore: number,
    details?: T,
    fromHook?: boolean
  ): string {
    const entry: CompactionEntry<T> = {
      type: 'compaction',
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      fromHook,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendBranchSummary<T = unknown>(
    branchFromId: string | null,
    summary: string,
    details?: T,
    fromHook?: boolean
  ): string {
    const entry: BranchSummaryEntry<T> = {
      type: 'branch_summary',
      id: generateEntryId(this.byId),
      parentId: branchFromId,
      timestamp: new Date().toISOString(),
      fromId: branchFromId ?? 'root',
      summary,
      details,
      fromHook,
    };
    this._appendEntry(entry);
    return entry.id;
  }

  appendLabelChange(targetId: string, label: string | undefined): string {
    if (!this.byId.has(targetId)) {
      throw new Error(`Entry ${targetId} not found`);
    }
    const entry: LabelEntry = {
      type: 'label',
      id: generateEntryId(this.byId),
      parentId: this.leafId,
      timestamp: new Date().toISOString(),
      targetId,
      label,
    };
    this._appendEntry(entry);
    if (label) {
      this.labelsById.set(targetId, label);
      this.labelTimestampsById.set(targetId, entry.timestamp);
    } else {
      this.labelsById.delete(targetId);
      this.labelTimestampsById.delete(targetId);
    }
    return entry.id;
  }

  /**
   * Await the pending write chain. Tests and the host-side `loadSession`
   * path rely on this to guarantee disk state reflects in-memory state
   * before switching sessions or shutting down.
   */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  // ==========================================================================
  // Private helpers
  // ==========================================================================

  private _appendEntry(entry: SessionEntry): void {
    this.fileEntries.push(entry);
    this.byId.set(entry.id, entry);
    this.leafId = entry.id;
    this._enqueueWrite(entry);
  }

  /**
   * Schedule the disk write for `entry`. Each write runs after the prior
   * chain link resolves, which preserves JSONL order when entries are
   * appended from overlapping async contexts.
   *
   * Lazy-flush mirrors coding-agent: we withhold the write until an
   * assistant message has landed; when it does, we materialise the entire
   * buffered header + entries in one shot and mark `flushed`. Subsequent
   * entries append a single line.
   */
  private _enqueueWrite(entry: SessionEntry): void {
    if (!this.persist || !this.sessionFile) return;
    const fileRef = this.sessionFile;
    // Snapshot at enqueue time so the body sees the state that was present
    // when `entry` was appended, not whatever's current when the chain drains.
    const snapshot = [...this.fileEntries];
    this.writeChain = this.writeChain
      .then(async () => {
        const hasAssistant = snapshot.some(
          e => e.type === 'message' && (e as SessionMessageEntry).message.role === 'assistant'
        );
        if (!hasAssistant) return;
        if (!this.flushed) {
          const content = `${snapshot.map(e => JSON.stringify(e)).join('\n')}\n`;
          await fs.promises.writeFile(fileRef, content);
          this.flushed = true;
        } else {
          await fs.promises.appendFile(fileRef, `${JSON.stringify(entry)}\n`);
        }
      })
      .catch(err => {
        console.error('[SessionManager] persist failed:', err);
      });
  }

  private _buildIndex(): void {
    this.byId.clear();
    this.labelsById.clear();
    this.labelTimestampsById.clear();
    this.leafId = null;
    for (const entry of this.fileEntries) {
      if (entry.type === 'session') continue;
      const e = entry as SessionEntry;
      this.byId.set(e.id, e);
      this.leafId = e.id;
      if (e.type === 'label') {
        const l = e as LabelEntry;
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

// ============================================================================
// Standalone helpers (exported for tests)
// ============================================================================

export async function parseSessionFile(filePath: string): Promise<FileEntry[]> {
  let content: string;
  try {
    content = (await fs.promises.readFile(filePath, { encoding: 'utf8' })) as string;
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
  return parseJsonl(content);
}

export function parseJsonl(content: string): FileEntry[] {
  const entries: FileEntry[] = [];
  const lines = content.trim().split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as FileEntry);
    } catch {
      // Skip malformed lines — matches coding-agent's parseSessionEntries.
    }
  }
  return entries;
}

async function buildSummary(filePath: string): Promise<SessionSummary | null> {
  const [entries, stats] = await Promise.all([
    parseSessionFile(filePath),
    fs.promises.stat(filePath),
  ]);
  if (entries.length === 0) return null;
  const header = entries[0];
  if (header.type !== 'session') return null;
  const sessionHeader = header as SessionHeader;

  let messageCount = 0;
  let firstMessage = '';
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === 'session_info') {
      name = (entry as SessionInfoEntry).name?.trim() || undefined;
      continue;
    }
    if (entry.type !== 'message') continue;
    messageCount++;
    if (!firstMessage) {
      const msg = (entry as SessionMessageEntry).message;
      if ((msg as { role?: string }).role === 'user') {
        firstMessage = extractText(msg);
      }
    }
  }

  return {
    id: sessionHeader.id,
    path: filePath,
    name,
    cwd: sessionHeader.cwd ?? '',
    created: sessionHeader.timestamp,
    modified: (stats.mtime instanceof Date ? stats.mtime : new Date(stats.mtime)).toISOString(),
    messageCount,
    firstMessage: firstMessage || '(no messages)',
    parentSessionPath: sessionHeader.parentSession,
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

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
}
