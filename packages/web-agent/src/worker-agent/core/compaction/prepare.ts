/**
 * Pure preparation: decide where to cut and collect the payload for
 * summarisation. Cuts on user-message turn boundaries only.
 */

import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { extractFileOpsFromMessage, createFileOps, computeFileLists } from './file-ops';
import { estimateContextTokens, estimateTokens } from './token-estimate';
import type { CompactionPreparation, CompactionSettings, CompactionDetails } from './types';
import type { CompactionEntry, SessionEntry } from '../session/types';

function isUserMessageEntry(entry: SessionEntry): boolean {
  return entry.type === 'message' && entry.message.role === 'user';
}

function getMessageFromEntry(entry: SessionEntry): AgentMessage | undefined {
  if (entry.type === 'message') return entry.message;
  return undefined;
}

/** Index of the first entry not covered by a prior compaction. */
function findBoundaryStart(path: SessionEntry[]): {
  start: number;
  previousSummary?: string;
  priorDetails?: CompactionDetails;
} {
  for (let i = path.length - 1; i >= 0; i--) {
    const entry = path[i];
    if (entry.type !== 'compaction') continue;
    const c = entry as CompactionEntry<CompactionDetails>;
    const keptIdx = path.findIndex(e => e.id === c.firstKeptEntryId);
    return {
      start: keptIdx >= 0 ? keptIdx : i + 1,
      previousSummary: c.summary,
      priorDetails: c.details,
    };
  }
  return { start: 0 };
}

/**
 * Walk backwards accumulating tokens until `keepRecentTokens`, then snap
 * forward to the first user-message boundary. Returns -1 if none found.
 */
function findCutIndex(
  path: SessionEntry[],
  boundaryStart: number,
  keepRecentTokens: number
): number {
  let accumulated = 0;
  let walkIdx = path.length;
  for (let i = path.length - 1; i >= boundaryStart; i--) {
    const msg = getMessageFromEntry(path[i]);
    if (!msg) continue;
    accumulated += estimateTokens(msg);
    walkIdx = i;
    if (accumulated >= keepRecentTokens) break;
  }
  for (let i = walkIdx; i < path.length; i++) {
    if (isUserMessageEntry(path[i])) return i;
  }
  return -1;
}

/** Fallback cut point for forced compaction: the last user-message entry. */
function findLastUserMessageIndex(path: SessionEntry[], boundaryStart: number): number {
  for (let i = path.length - 1; i > boundaryStart; i--) {
    if (isUserMessageEntry(path[i])) return i;
  }
  return -1;
}

/**
 * Snap an arbitrary index back to the first user-message entry at or
 * before it. Returns -1 when no suitable boundary exists (extensions
 * supplying overrides see a no-op outcome in that case).
 */
function snapToUserBoundary(path: SessionEntry[], desired: number, boundaryStart: number): number {
  const start = Math.min(desired, path.length - 1);
  for (let i = start; i > boundaryStart; i--) {
    if (isUserMessageEntry(path[i])) return i;
  }
  return -1;
}

export interface PrepareCompactionOptions {
  /** Force compaction on short transcripts (used by `/compact`). */
  force?: boolean;
  /**
   * Extension-supplied override for the cut point. Clamped to
   * `(boundaryStart, path.length)` and snapped back to the nearest
   * user-message boundary at or before the supplied index so the
   * summariser still receives whole turns.
   */
  preferredCutIndex?: number;
  /**
   * Extension-supplied set of entry ids that must remain in the kept
   * suffix. Any matching entry whose index falls before the current
   * `cutIdx` pulls `cutIdx` back to that index (snapped to a
   * user-message boundary) so the entry survives summarisation.
   */
  preserveEntries?: string[];
}

export function prepareCompaction(
  path: SessionEntry[],
  settings: CompactionSettings,
  opts: PrepareCompactionOptions = {}
): CompactionPreparation | null {
  if (path.length < settings.minEntriesToCompact) return null;
  const last = path[path.length - 1];
  if (last.type === 'compaction') return null;

  const { start: boundaryStart, previousSummary, priorDetails } = findBoundaryStart(path);

  let cutIdx = findCutIndex(path, boundaryStart, settings.keepRecentTokens);
  if ((cutIdx < 0 || cutIdx <= boundaryStart) && opts.force) {
    cutIdx = findLastUserMessageIndex(path, boundaryStart);
  }
  if (cutIdx < 0) return null;
  if (cutIdx <= boundaryStart) return null;

  if (typeof opts.preferredCutIndex === 'number') {
    const clamped = Math.max(boundaryStart + 1, Math.min(path.length - 1, opts.preferredCutIndex));
    const snapped = snapToUserBoundary(path, clamped, boundaryStart);
    if (snapped > boundaryStart) cutIdx = snapped;
  }
  if (opts.preserveEntries && opts.preserveEntries.length > 0) {
    const preserve = new Set(opts.preserveEntries);
    let earliest = cutIdx;
    for (let i = boundaryStart; i < cutIdx; i++) {
      const id = path[i].id;
      if (id && preserve.has(id)) {
        earliest = i;
        break;
      }
    }
    if (earliest < cutIdx) {
      const snapped = snapToUserBoundary(path, earliest, boundaryStart);
      if (snapped > boundaryStart) cutIdx = snapped;
    }
  }

  const firstKeptEntry = path[cutIdx];
  if (!firstKeptEntry.id) return null;

  const messagesToSummarize: AgentMessage[] = [];
  for (let i = boundaryStart; i < cutIdx; i++) {
    const msg = getMessageFromEntry(path[i]);
    if (msg) messagesToSummarize.push(msg);
  }
  if (messagesToSummarize.length === 0) return null;

  const fileOps = createFileOps();
  if (priorDetails) {
    for (const f of priorDetails.readFiles ?? []) fileOps.read.add(f);
    for (const f of priorDetails.modifiedFiles ?? []) fileOps.edited.add(f);
  }
  for (const m of messagesToSummarize) extractFileOpsFromMessage(m, fileOps);
  const { readFiles, modifiedFiles } = computeFileLists(fileOps);

  const allMessages: AgentMessage[] = [];
  for (const entry of path) {
    const m = getMessageFromEntry(entry);
    if (m) allMessages.push(m);
  }
  const tokensBefore = estimateContextTokens(allMessages);

  return {
    firstKeptEntryId: firstKeptEntry.id,
    messagesToSummarize,
    tokensBefore,
    previousSummary,
    readFiles,
    modifiedFiles,
  };
}
