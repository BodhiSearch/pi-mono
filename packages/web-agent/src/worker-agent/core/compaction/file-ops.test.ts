import type { AgentMessage } from '@mariozechner/pi-agent-core';
import { describe, expect, test } from 'vitest';
import {
  computeFileLists,
  createFileOps,
  extractFileOpsFromMessage,
  formatFileOperations,
} from './file-ops';

function assistantWithToolCalls(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>
): AgentMessage {
  return {
    role: 'assistant',
    content: calls.map(c => ({ type: 'toolCall', name: c.name, arguments: c.arguments })),
  } as unknown as AgentMessage;
}

describe('file-ops', () => {
  test('extractFileOpsFromMessage records read/write/edit paths', () => {
    const msg = assistantWithToolCalls([
      { name: 'read', arguments: { path: '/vault/a.txt' } },
      { name: 'write', arguments: { path: '/vault/b.txt' } },
      { name: 'edit', arguments: { path: '/vault/c.txt' } },
    ]);
    const ops = createFileOps();
    extractFileOpsFromMessage(msg, ops);
    expect(ops.read.has('/vault/a.txt')).toBe(true);
    expect(ops.written.has('/vault/b.txt')).toBe(true);
    expect(ops.edited.has('/vault/c.txt')).toBe(true);
  });

  test('skips non-assistant messages', () => {
    const userMsg = { role: 'user', content: 'hi' } as unknown as AgentMessage;
    const ops = createFileOps();
    extractFileOpsFromMessage(userMsg, ops);
    expect(ops.read.size).toBe(0);
  });

  test('computeFileLists separates read-only from modified', () => {
    const ops = createFileOps();
    ops.read.add('/a.txt');
    ops.read.add('/b.txt');
    ops.written.add('/b.txt');
    const { readFiles, modifiedFiles } = computeFileLists(ops);
    expect(readFiles).toEqual(['/a.txt']);
    expect(modifiedFiles).toContain('/b.txt');
  });

  test('formatFileOperations returns empty string when no files', () => {
    expect(formatFileOperations([], [])).toBe('');
  });

  test('formatFileOperations includes XML-tagged sections', () => {
    const result = formatFileOperations(['/vault/r.md'], ['/vault/m.ts']);
    expect(result).toContain('<read-files>');
    expect(result).toContain('/vault/r.md');
    expect(result).toContain('<modified-files>');
    expect(result).toContain('/vault/m.ts');
  });
});
