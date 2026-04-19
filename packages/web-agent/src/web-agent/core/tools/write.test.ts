import { beforeEach, describe, expect, test } from 'vitest';
import { __resetFileMutationQueuesForTests } from './file-mutation-queue';
import { createWriteTool } from './write';

function inMemoryOps() {
  const files = new Map<string, string>();
  const dirs = new Set<string>(['/', '/vault']);
  return {
    files,
    dirs,
    ops: {
      async writeFile(path: string, content: string): Promise<void> {
        const lastSlash = path.lastIndexOf('/');
        const parent = lastSlash > 0 ? path.slice(0, lastSlash) : '/';
        if (!dirs.has(parent)) {
          throw new Error(`ENOENT parent missing: ${parent}`);
        }
        files.set(path, content);
      },
      async mkdir(dir: string): Promise<void> {
        const parts = dir.split('/').filter(Boolean);
        let acc = '';
        for (const p of parts) {
          acc += '/' + p;
          dirs.add(acc);
        }
      },
    },
  };
}

describe('createWriteTool', () => {
  beforeEach(() => {
    __resetFileMutationQueuesForTests();
  });

  test('writes a file at the root of the vault', async () => {
    const { ops, files } = inMemoryOps();
    const tool = createWriteTool({ operations: ops });
    await tool.execute('id', { path: 'hello.txt', content: 'hi' });
    expect(files.get('/vault/hello.txt')).toBe('hi');
  });

  test('creates parent directories for nested paths', async () => {
    const { ops, files, dirs } = inMemoryOps();
    const tool = createWriteTool({ operations: ops });
    await tool.execute('id', { path: 'a/b/c/d.txt', content: 'deep' });
    expect(files.get('/vault/a/b/c/d.txt')).toBe('deep');
    expect(dirs.has('/vault/a/b/c')).toBe(true);
  });

  test('overwrites existing file', async () => {
    const { ops, files } = inMemoryOps();
    const tool = createWriteTool({ operations: ops });
    await tool.execute('id', { path: 'x.txt', content: 'one' });
    await tool.execute('id', { path: 'x.txt', content: 'two' });
    expect(files.get('/vault/x.txt')).toBe('two');
  });

  test('rejects vault-escape path', async () => {
    const { ops } = inMemoryOps();
    const tool = createWriteTool({ operations: ops });
    await expect(tool.execute('id', { path: '/etc/evil', content: '' })).rejects.toThrow();
  });

  test('returns a descriptive result line', async () => {
    const { ops } = inMemoryOps();
    const tool = createWriteTool({ operations: ops });
    const res = await tool.execute('id', { path: 'note.txt', content: 'abcdef' });
    const text = (res.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('/vault/note.txt');
    expect(text).toContain('6 chars');
  });

  test('serialises concurrent writes to same path (via mutation queue)', async () => {
    const order: string[] = [];
    const ops = {
      async writeFile(_: string, content: string) {
        order.push(`start:${content}`);
        await new Promise(r => setTimeout(r, content === 'A' ? 20 : 1));
        order.push(`end:${content}`);
      },
      async mkdir() {},
    };
    const tool = createWriteTool({ operations: ops });
    await Promise.all([
      tool.execute('id1', { path: 'race.txt', content: 'A' }),
      tool.execute('id2', { path: 'race.txt', content: 'B' }),
    ]);
    expect(order).toEqual(['start:A', 'end:A', 'start:B', 'end:B']);
  });
});
