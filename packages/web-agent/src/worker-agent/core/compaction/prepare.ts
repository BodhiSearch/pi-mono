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

export function prepareCompaction(
  path: SessionEntry[],
  settings: CompactionSettings,
  opts: { force?: boolean } = {}
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
