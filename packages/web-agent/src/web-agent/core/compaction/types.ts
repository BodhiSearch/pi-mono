/**
 * Compaction types — settings, preparation input, result payload.
 * Adapted from coding-agent's compaction module for web-agent (turn-boundary
 * cuts only, no bash/custom pseudo-roles).
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';

export interface CompactionSettings {
  enabled: boolean;
  /** Headroom from the context window; compaction triggers above `contextWindow - reserveTokens`. */
  reserveTokens: number;
  /** Token budget for the tail we never summarise. */
  keepRecentTokens: number;
  /** Skip compaction entirely if the session has fewer than this many entries. */
  minEntriesToCompact: number;
  /** Optional override of the active model's context window (used by tests + until D22 is resolved). */
  contextWindow?: number;
}

export const DEFAULT_COMPACTION_SETTINGS: CompactionSettings = {
  enabled: true,
  reserveTokens: 16384,
  keepRecentTokens: 20000,
  minEntriesToCompact: 4,
};

/** Details carried on the `CompactionEntry` for file-tracking continuity. */
export interface CompactionDetails {
  readFiles: string[];
  modifiedFiles: string[];
}

/**
 * Pure preparation output — everything the summarization step needs,
 * computed without hitting the LLM. `null` means "nothing worth
 * compacting" (session too small, or already ends in a compaction).
 */
export interface CompactionPreparation {
  /** Id of the first entry to retain after compaction. */
  firstKeptEntryId: string;
  /** Messages that will be summarised and discarded. */
  messagesToSummarize: AgentMessage[];
  /** Char/4 estimate of the context window before compaction. */
  tokensBefore: number;
  /** Summary from a prior `CompactionEntry` on the branch, for iterative update. */
  previousSummary?: string;
  /** File operations extracted from discarded messages + any prior compaction details. */
  readFiles: string[];
  modifiedFiles: string[];
}

export interface CompactionResult {
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details: CompactionDetails;
}
