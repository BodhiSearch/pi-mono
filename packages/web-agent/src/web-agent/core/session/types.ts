/**
 * Session entry + header shapes, ported 1:1 from coding-agent so extensions
 * written against coding-agent's `ExtensionContext.sessionManager` read the
 * same JSONL format here (M8 forward-compat).
 *
 * M5 only writes `SessionMessageEntry`, `ModelChangeEntry`, and
 * `SessionInfoEntry`. The remaining variants are intentionally ported up
 * front so M6/M7/M8 don't have to break the wire format later:
 *   - `ThinkingLevelChangeEntry` — M6/M7 (per-session thinking level)
 *   - `CompactionEntry`          — M7 (context compaction result)
 *   - `BranchSummaryEntry`       — M6 (fork / branch summaries)
 *   - `LabelEntry`               — M6 (user bookmarks)
 *   - `CustomEntry`              — M8 (extension opaque state)
 *   - `CustomMessageEntry`       — M8 (extension messages in LLM context)
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type { ImageContent, TextContent } from '@mariozechner/pi-ai';

export const CURRENT_SESSION_VERSION = 3;

// ============================================================================
// Header + entry shapes
// ============================================================================

export interface SessionHeader {
  type: 'session';
  /** Absent on v1 sessions produced before versioning was introduced. */
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
}

export interface NewSessionOptions {
  id?: string;
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  /** 8-char short id used for tree refs. Distinct from the session's UUIDv7. */
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: 'message';
  message: AgentMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: 'thinking_level_change';
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: 'model_change';
  provider: string;
  modelId: string;
}

export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}

export interface BranchSummaryEntry<T = unknown> extends SessionEntryBase {
  type: 'branch_summary';
  fromId: string;
  summary: string;
  details?: T;
  fromHook?: boolean;
}

export interface CustomEntry<T = unknown> extends SessionEntryBase {
  type: 'custom';
  customType: string;
  data?: T;
}

export interface LabelEntry extends SessionEntryBase {
  type: 'label';
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: 'session_info';
  name?: string;
}

export interface CustomMessageEntry<T = unknown> extends SessionEntryBase {
  type: 'custom_message';
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: T;
  display: boolean;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

// ============================================================================
// Derived shapes
// ============================================================================

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  labelTimestamp?: string;
}

export interface SessionContext {
  messages: AgentMessage[];
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
}

/** Summary used by the session picker UI. */
export interface SessionSummary {
  id: string;
  path: string;
  name?: string;
  cwd: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  parentSessionPath?: string;
}

/** Meta for the currently active session surfaced through RPC. */
export interface SessionMeta {
  id: string;
  path: string | null;
  name?: string;
  cwd: string;
  parentSession?: string;
}

// ============================================================================
// Read-only interface — matches coding-agent's ReadonlySessionManager shape.
// Extensions written against coding-agent read session state through this
// contract; M8 will pass a SessionManager typed as this into extension
// contexts, so the interface must remain the union of methods both harnesses
// support.
// ============================================================================

export interface ReadonlySessionManager {
  getCwd(): string;
  getSessionDir(): string;
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getHeader(): SessionHeader | null;
  getEntries(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  /** M6 will populate label state; M5 always returns undefined. */
  getLabel(id: string): string | undefined;
  /** M6 will implement tree-walking; M5 returns the linear path. */
  getBranch(fromId?: string): SessionEntry[];
  /** M6 will implement tree assembly; M5 returns a flat root list. */
  getTree(): SessionTreeNode[];
  getSessionName(): string | undefined;
}
