import { describe, expect, test } from 'vitest';
import { createLsTool } from './ls';

type EntryShape = {
  isDir?: boolean;
  children?: string[];
};

function inMemoryOps(entries: Record<string, EntryShape>) {
  return {
    async stat(path: string) {
      const e = entries[path];
      if (!e) throw new Error(`ENOENT: ${path}`);
      return {
        isDirectory: () => e.isDir === true,
        isFile: () => e.isDir !== true,
      };
    },
    async readdir(path: string): Promise<string[]> {
      const e = entries[path];
      if (!e || !e.isDir) throw new Error(`ENOTDIR: ${path}`);
      return e.children ?? [];
    },
  };
}

describe('createLsTool', () => {
  test('lists a flat directory with dir suffix', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['b.txt', 'A', 'c.txt'] },
      '/vault/b.txt': {},
      '/vault/A': { isDir: true },
      '/vault/c.txt': {},
    });
    const tool = createLsTool({ operations: ops });
    const res = await tool.execute('id', {});
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('A/\nb.txt\nc.txt');
  });

  test('lists a subdirectory', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['docs'] },
      '/vault/docs': { isDir: true, children: ['readme.md'] },
      '/vault/docs/readme.md': {},
    });
    const tool = createLsTool({ operations: ops });
    const res = await tool.execute('id', { path: 'docs' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('readme.md');
  });

  test('respects limit and reports remainder', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['a', 'b', 'c', 'd', 'e'] },
      '/vault/a': {},
      '/vault/b': {},
      '/vault/c': {},
      '/vault/d': {},
      '/vault/e': {},
    });
    const tool = createLsTool({ operations: ops });
    const res = await tool.execute('id', { limit: 2 });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('a\nb');
    expect(text).toContain('3 more entries not shown');
    expect(res.details?.entryLimitReached).toBe(3);
  });

  test('rejects path pointing at a file', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['file.txt'] },
      '/vault/file.txt': {},
    });
    const tool = createLsTool({ operations: ops });
    await expect(tool.execute('id', { path: 'file.txt' })).rejects.toThrow(/Not a directory/);
  });

  test('rejects missing path', async () => {
    const ops = inMemoryOps({ '/vault': { isDir: true, children: [] } });
    const tool = createLsTool({ operations: ops });
    await expect(tool.execute('id', { path: 'missing' })).rejects.toThrow(/ENOENT/);
  });
});
