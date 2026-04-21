import { describe, expect, test } from 'vitest';
import { createGrepTool } from './grep';

type EntryShape = { isDir?: boolean; children?: string[]; content?: string };

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
    async readFile(path: string): Promise<string> {
      const e = entries[path];
      if (!e || e.isDir) throw new Error(`ENOENT: ${path}`);
      return e.content ?? '';
    },
  };
}

const tree: Record<string, EntryShape> = {
  '/vault': { isDir: true, children: ['a.ts', 'b.txt', 'src'] },
  '/vault/a.ts': { content: 'const x = 1;\nconsole.log(x);\nconst y = 2;' },
  '/vault/b.txt': { content: 'hello world\nHELLO again' },
  '/vault/src': { isDir: true, children: ['c.ts'] },
  '/vault/src/c.ts': { content: 'export const foo = 42;' },
};

describe('createGrepTool', () => {
  test('matches a regex across the tree', async () => {
    const tool = createGrepTool({ operations: inMemoryOps(tree) });
    const res = await tool.execute('id', { pattern: '\\bconst\\b' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('a.ts:1: const x = 1;');
    expect(text).toContain('a.ts:3: const y = 2;');
    expect(text).toContain('src/c.ts:1: export const foo = 42;');
  });

  test('literal mode skips regex metacharacter parsing', async () => {
    const tool = createGrepTool({
      operations: inMemoryOps({
        '/vault': { isDir: true, children: ['a.txt'] },
        '/vault/a.txt': { content: 'a.b\nab\na+b' },
      }),
    });
    const res = await tool.execute('id', { pattern: 'a.b', literal: true });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    // Only the literal "a.b" line matches.
    expect(text).toBe('a.txt:1: a.b');
  });

  test('ignoreCase matches both cases', async () => {
    const tool = createGrepTool({ operations: inMemoryOps(tree) });
    const res = await tool.execute('id', { pattern: 'hello', ignoreCase: true });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('b.txt:1: hello world');
    expect(text).toContain('b.txt:2: HELLO again');
  });

  test('glob filter restricts to matching files', async () => {
    const tool = createGrepTool({ operations: inMemoryOps(tree) });
    const res = await tool.execute('id', { pattern: 'const', glob: '**/*.ts' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).not.toContain('b.txt');
  });

  test('context shows surrounding lines separated by "--"', async () => {
    const tool = createGrepTool({
      operations: inMemoryOps({
        '/vault': { isDir: true, children: ['a.txt'] },
        '/vault/a.txt': { content: 'one\ntarget\nthree' },
      }),
    });
    const res = await tool.execute('id', { pattern: 'target', context: 1 });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('a.txt:1- one');
    expect(text).toContain('a.txt:2: target');
    expect(text).toContain('a.txt:3- three');
  });

  test('limit caps matches and surfaces the cap notice', async () => {
    const tool = createGrepTool({
      operations: inMemoryOps({
        '/vault': { isDir: true, children: ['a.txt'] },
        '/vault/a.txt': { content: 'x\nx\nx\nx\nx' },
      }),
    });
    const res = await tool.execute('id', { pattern: 'x', limit: 2 });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('Match limit 2 reached');
    expect(res.details?.matchLimitReached).toBe(2);
  });

  test('no-match returns placeholder', async () => {
    const tool = createGrepTool({ operations: inMemoryOps(tree) });
    const res = await tool.execute('id', { pattern: 'ZZZ-never-present-ZZZ' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toBe('[no matches]');
  });

  test('rejects invalid regex with a helpful error', async () => {
    const tool = createGrepTool({ operations: inMemoryOps(tree) });
    await expect(tool.execute('id', { pattern: '(' })).rejects.toThrow(/Invalid regex/);
  });
});
