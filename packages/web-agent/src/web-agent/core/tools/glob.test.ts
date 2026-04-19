import { describe, expect, test } from 'vitest';
import { createGlobTool } from './glob';

type EntryShape = { isDir?: boolean; children?: string[] };

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

describe('createGlobTool', () => {
  test('matches **/*.ts across the tree', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['a.ts', 'b.js', 'src'] },
      '/vault/a.ts': {},
      '/vault/b.js': {},
      '/vault/src': { isDir: true, children: ['c.ts', 'd.tsx'] },
      '/vault/src/c.ts': {},
      '/vault/src/d.tsx': {},
    });
    const tool = createGlobTool({ operations: ops });
    const res = await tool.execute('id', { pattern: '**/*.ts' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text.split('\n').sort()).toEqual(['a.ts', 'src/c.ts']);
  });

  test('scoped to a subdir via `path`', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['a.ts', 'src'] },
      '/vault/a.ts': {},
      '/vault/src': { isDir: true, children: ['x.ts'] },
      '/vault/src/x.ts': {},
    });
    const tool = createGlobTool({ operations: ops });
    const res = await tool.execute('id', { pattern: '*.ts', path: 'src' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('x.ts');
  });

  test('no matches returns a placeholder message', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['a.txt'] },
      '/vault/a.txt': {},
    });
    const tool = createGlobTool({ operations: ops });
    const res = await tool.execute('id', { pattern: '**/*.ts' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('[no matches]');
  });

  test('honours limit and surfaces remainder note', async () => {
    const ops = inMemoryOps({
      '/vault': { isDir: true, children: ['a.ts', 'b.ts', 'c.ts'] },
      '/vault/a.ts': {},
      '/vault/b.ts': {},
      '/vault/c.ts': {},
    });
    const tool = createGlobTool({ operations: ops });
    const res = await tool.execute('id', { pattern: '**/*.ts', limit: 2 });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Result limit 2 reached');
    expect(res.details?.resultLimitReached).toBe(2);
  });

  test('rejects path escaping the vault', async () => {
    const ops = inMemoryOps({ '/vault': { isDir: true } });
    const tool = createGlobTool({ operations: ops });
    await expect(tool.execute('id', { pattern: '**/*.ts', path: '../etc' })).rejects.toThrow();
  });
});
