import { beforeEach, describe, expect, test } from 'vitest';
import { __resetFileMutationQueuesForTests } from './file-mutation-queue';
import { createEditTool } from './edit';

function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function inMemoryOps(initial: Record<string, string>) {
  const files = new Map(Object.entries(initial));
  return {
    files,
    ops: {
      async readFile(path: string): Promise<Uint8Array> {
        const v = files.get(path);
        if (v === undefined) throw new Error(`ENOENT: ${path}`);
        return textToBytes(v);
      },
      async writeFile(path: string, content: string): Promise<void> {
        files.set(path, content);
      },
      async access(path: string): Promise<void> {
        if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      },
    },
  };
}

describe('createEditTool', () => {
  beforeEach(() => {
    __resetFileMutationQueuesForTests();
  });

  test('single edit replaces exact text', async () => {
    const { ops, files } = inMemoryOps({ '/vault/a.txt': 'hello world' });
    const tool = createEditTool({ operations: ops });
    const res = await tool.execute('id', {
      path: 'a.txt',
      edits: [{ oldText: 'world', newText: 'there' }],
    });
    expect(files.get('/vault/a.txt')).toBe('hello there');
    expect(res.details?.diff).toContain('-hello world');
    expect(res.details?.diff).toContain('+hello there');
    expect(res.details?.firstChangedLine).toBe(1);
  });

  test('multi-edit applies each to the original, not cascading', async () => {
    const { ops, files } = inMemoryOps({ '/vault/a.txt': 'aaa bbb ccc' });
    const tool = createEditTool({ operations: ops });
    await tool.execute('id', {
      path: 'a.txt',
      edits: [
        { oldText: 'aaa', newText: 'AAA' },
        { oldText: 'ccc', newText: 'CCC' },
      ],
    });
    expect(files.get('/vault/a.txt')).toBe('AAA bbb CCC');
  });

  test('rejects when oldText is not found', async () => {
    const { ops } = inMemoryOps({ '/vault/a.txt': 'abc' });
    const tool = createEditTool({ operations: ops });
    await expect(
      tool.execute('id', { path: 'a.txt', edits: [{ oldText: 'xyz', newText: '!' }] })
    ).rejects.toThrow(/not found/);
  });

  test('rejects when oldText matches more than once', async () => {
    const { ops } = inMemoryOps({ '/vault/a.txt': 'x x x' });
    const tool = createEditTool({ operations: ops });
    await expect(
      tool.execute('id', { path: 'a.txt', edits: [{ oldText: 'x', newText: 'y' }] })
    ).rejects.toThrow(/more than once/);
  });

  test('rejects when oldText equals newText', async () => {
    const { ops } = inMemoryOps({ '/vault/a.txt': 'abc' });
    const tool = createEditTool({ operations: ops });
    await expect(
      tool.execute('id', { path: 'a.txt', edits: [{ oldText: 'abc', newText: 'abc' }] })
    ).rejects.toThrow(/identical/);
  });

  test('preserves CRLF line endings', async () => {
    const { ops, files } = inMemoryOps({ '/vault/a.txt': 'one\r\ntwo\r\nthree' });
    const tool = createEditTool({ operations: ops });
    await tool.execute('id', {
      path: 'a.txt',
      edits: [{ oldText: 'two', newText: 'TWO' }],
    });
    const after = files.get('/vault/a.txt') ?? '';
    expect(after).toBe('one\r\nTWO\r\nthree');
  });

  test('preserves leading BOM', async () => {
    const { ops, files } = inMemoryOps({ '/vault/a.txt': '\ufeffhello world' });
    const tool = createEditTool({ operations: ops });
    await tool.execute('id', {
      path: 'a.txt',
      edits: [{ oldText: 'world', newText: 'there' }],
    });
    expect(files.get('/vault/a.txt')).toBe('\ufeffhello there');
  });

  test('rejects when edits produce no change (empty edits array)', async () => {
    const { ops } = inMemoryOps({ '/vault/a.txt': 'abc' });
    const tool = createEditTool({ operations: ops });
    await expect(tool.execute('id', { path: 'a.txt', edits: [] })).rejects.toThrow(/at least one/);
  });

  test('rejects empty oldText', async () => {
    const { ops } = inMemoryOps({ '/vault/a.txt': 'abc' });
    const tool = createEditTool({ operations: ops });
    await expect(
      tool.execute('id', { path: 'a.txt', edits: [{ oldText: '', newText: 'x' }] })
    ).rejects.toThrow(/must not be empty/);
  });
});
