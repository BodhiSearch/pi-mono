import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import { prepareCompaction } from './prepare';
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from '../session/types';
import { DEFAULT_COMPACTION_SETTINGS } from './types';

let nextId = 0;
function mkEntry(msg: AgentMessage, parentId: string | null): SessionMessageEntry {
  nextId++;
  return {
    type: 'message',
    id: `e${nextId}`,
    parentId,
    timestamp: new Date(nextId * 1000).toISOString(),
    message: msg,
  };
}

function userMsg(text: string): AgentMessage {
  return { role: 'user', content: text } as unknown as AgentMessage;
}

function asstMsg(text: string): AgentMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    provider: 'test',
    model: 'test',
    stopReason: 'stop',
    timestamp: 0,
  } as unknown as AgentMessage;
}

function buildChain(msgs: AgentMessage[]): SessionMessageEntry[] {
  nextId = 0;
  const entries: SessionMessageEntry[] = [];
  let parent: string | null = null;
  for (const m of msgs) {
    const e = mkEntry(m, parent);
    entries.push(e);
    parent = e.id;
  }
  return entries;
}

describe('prepareCompaction', () => {
  test('returns null when entry count is below minEntriesToCompact', () => {
    const path = buildChain([userMsg('hi'), asstMsg('hello')]);
    const prep = prepareCompaction(path, DEFAULT_COMPACTION_SETTINGS);
    expect(prep).toBeNull();
  });

  test('returns null when the branch ends in a compaction entry', () => {
    const msgs = [userMsg('q1'), asstMsg('a1'), userMsg('q2'), asstMsg('a2')];
    const path: SessionEntry[] = buildChain(msgs);
    const compaction: CompactionEntry = {
      type: 'compaction',
      id: 'c1',
      parentId: path[path.length - 1].id,
      timestamp: new Date().toISOString(),
      summary: 'prior summary',
      firstKeptEntryId: path[0].id,
      tokensBefore: 100,
    };
    path.push(compaction);
    const prep = prepareCompaction(path, DEFAULT_COMPACTION_SETTINGS);
    expect(prep).toBeNull();
  });

  test('cuts at a user-message boundary; firstKeptEntryId resolves to a real entry', () => {
    // Long conversation. Set keepRecentTokens small so the cut is forced.
    const path = buildChain([
      userMsg('q1-' + 'x'.repeat(400)),
      asstMsg('a1-' + 'x'.repeat(400)),
      userMsg('q2-' + 'x'.repeat(400)),
      asstMsg('a2-' + 'x'.repeat(400)),
      userMsg('q3-' + 'x'.repeat(40)),
      asstMsg('a3-' + 'x'.repeat(40)),
    ]);
    const settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 50,
      minEntriesToCompact: 2,
    };
    const prep = prepareCompaction(path, settings);
    expect(prep).not.toBeNull();
    if (!prep) return;
    // firstKeptEntryId must be the id of a user-message entry
    const kept = path.find(e => e.id === prep.firstKeptEntryId);
    expect(kept).toBeDefined();
    expect(kept!.type).toBe('message');
    expect((kept as SessionMessageEntry).message.role).toBe('user');
    // At least one message discarded and one retained
    expect(prep.messagesToSummarize.length).toBeGreaterThan(0);
  });

  test('uses prior CompactionEntry.firstKeptEntryId as the new boundary start', () => {
    const msgs = [
      userMsg('early-1'),
      asstMsg('early-2'),
      userMsg('mid-1-' + 'x'.repeat(400)),
      asstMsg('mid-2-' + 'x'.repeat(400)),
      userMsg('late-1-' + 'x'.repeat(40)),
      asstMsg('late-2-' + 'x'.repeat(40)),
    ];
    const entries = buildChain(msgs);
    // Pretend a prior compaction summarised entries[0..1] and kept from entries[2].
    const compaction: CompactionEntry = {
      type: 'compaction',
      id: 'c1',
      parentId: entries[1].id,
      timestamp: new Date().toISOString(),
      summary: 'prior',
      firstKeptEntryId: entries[2].id,
      tokensBefore: 100,
      details: { readFiles: ['/vault/old.md'], modifiedFiles: [] },
    };
    // Insert compaction between entries[1] and entries[2] in the linear path.
    const path: SessionEntry[] = [
      entries[0],
      entries[1],
      compaction,
      entries[2],
      entries[3],
      entries[4],
      entries[5],
    ];
    const settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 50,
      minEntriesToCompact: 2,
    };
    const prep = prepareCompaction(path, settings);
    expect(prep).not.toBeNull();
    if (!prep) return;
    expect(prep.previousSummary).toBe('prior');
    // The discarded set must not include entries already covered by the
    // prior compaction — only messages from entries[2] onwards may land
    // in messagesToSummarize.
    const discardedUserTexts = prep.messagesToSummarize
      .filter(m => m.role === 'user')
      .map(m => (typeof m.content === 'string' ? m.content : ''));
    expect(discardedUserTexts.some(t => t.startsWith('early'))).toBe(false);
    expect(discardedUserTexts.some(t => t.startsWith('mid'))).toBe(true);
    // Previous read-file carries through
    expect(prep.readFiles).toContain('/vault/old.md');
  });

  test('returns null if the cut would discard zero messages', () => {
    const path = buildChain([userMsg('hi'), asstMsg('hello'), userMsg('again'), asstMsg('yes')]);
    const settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 10_000,
      minEntriesToCompact: 2,
    };
    const prep = prepareCompaction(path, settings);
    expect(prep).toBeNull();
  });

  test('force: true falls back to last user message when tokens are below threshold', () => {
    const path = buildChain([userMsg('q1'), asstMsg('a1'), userMsg('q2'), asstMsg('a2')]);
    const settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 100_000,
      minEntriesToCompact: 2,
    };
    // Without force this returns null
    expect(prepareCompaction(path, settings)).toBeNull();
    // With force it finds a valid cut at the last user message
    const prep = prepareCompaction(path, settings, { force: true });
    expect(prep).not.toBeNull();
    if (!prep) return;
    const kept = path.find(e => e.id === prep.firstKeptEntryId);
    expect(kept).toBeDefined();
    expect(kept!.type).toBe('message');
    expect((kept as SessionMessageEntry).message.role).toBe('user');
    expect(prep.messagesToSummarize.length).toBeGreaterThan(0);
  });

  test('force: true still returns null when there are fewer entries than minEntriesToCompact', () => {
    const path = buildChain([userMsg('q1'), asstMsg('a1')]);
    const settings = {
      ...DEFAULT_COMPACTION_SETTINGS,
      keepRecentTokens: 100_000,
      minEntriesToCompact: 4,
    };
    const prep = prepareCompaction(path, settings, { force: true });
    expect(prep).toBeNull();
  });
});
