import { beforeEach, describe, expect, test } from 'vitest';
import { createReadTool } from './read';

function textToBytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function inMemoryOps(files: Record<string, string>) {
  return {
    async readFile(path: string): Promise<Uint8Array> {
      const v = files[path];
      if (v === undefined) throw new Error(`ENOENT: ${path}`);
      return textToBytes(v);
    },
    async access(path: string): Promise<void> {
      if (!(path in files)) throw new Error(`ENOENT: ${path}`);
    },
  };
}

describe('createReadTool', () => {
  let files: Record<string, string>;

  beforeEach(() => {
    files = {
      '/vault/hello.txt': 'line1\nline2\nline3',
      '/vault/empty.txt': '',
    };
  });

  test('reads a simple file', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    const result = await tool.execute('id', { path: '/vault/hello.txt' });
    expect(result.content).toEqual([{ type: 'text', text: 'line1\nline2\nline3' }]);
  });

  test('accepts a relative path resolved against /vault', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    const result = await tool.execute('id', { path: 'hello.txt' });
    expect(result.content[0]).toEqual({ type: 'text', text: 'line1\nline2\nline3' });
  });

  test('honours offset (1-indexed)', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    const result = await tool.execute('id', { path: 'hello.txt', offset: 2 });
    expect(result.content[0]).toEqual({ type: 'text', text: 'line2\nline3' });
  });

  test('honours limit and emits continuation notice when more lines remain', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    const result = await tool.execute('id', { path: 'hello.txt', limit: 2 });
    const text = (result.content[0] as { type: 'text'; text: string }).text;
    expect(text).toContain('line1');
    expect(text).toContain('line2');
    expect(text).not.toContain('line3');
    expect(text).toContain('1 more lines in file');
    expect(text).toContain('offset=3');
  });

  test('rejects offset past end of file', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    await expect(tool.execute('id', { path: 'hello.txt', offset: 99 })).rejects.toThrow(
      /beyond end of file/
    );
  });

  test('rejects path escaping the vault', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    await expect(tool.execute('id', { path: '/etc/passwd' })).rejects.toThrow();
  });

  test('rejects when file is missing', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    await expect(tool.execute('id', { path: '/vault/missing.txt' })).rejects.toThrow(/ENOENT/);
  });

  test('honours abort signal before file access', async () => {
    const tool = createReadTool({ operations: inMemoryOps(files) });
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(tool.execute('id', { path: 'hello.txt' }, ctrl.signal)).rejects.toThrow(/aborted/);
  });
});
