import { describe, expect, it, vi } from 'vitest';
import { buildFsHandlers, posixResolve, type FsLike, type VolumeRegistryView } from './fs-handlers';

function makeView(mountNames: string[]): VolumeRegistryView {
  return { list: () => mountNames.map(mountName => ({ mountName })) };
}

interface FakeNode {
  kind: 'file' | 'symlink';
  value: string;
}

/**
 * Tiny fs-like stub. Stores files and symlinks in a flat map keyed
 * by canonical absolute path. `realpath` resolves symlinks (one
 * level deep, sufficient for these tests). Used purely to exercise
 * the path-safety logic in `fs-handlers` without dragging in a real
 * ZenFS instance.
 */
function makeFakeFs(files: Record<string, FakeNode>): FsLike {
  const store = new Map(Object.entries(files));
  return {
    promises: {
      async readFile(path: string): Promise<string> {
        const node = store.get(path);
        if (!node || node.kind !== 'file') {
          const err = new Error(`ENOENT: ${path}`) as Error & { code?: string };
          err.code = 'ENOENT';
          throw err;
        }
        return node.value;
      },
      async writeFile(path: string, content: string): Promise<void> {
        store.set(path, { kind: 'file', value: content });
      },
      async mkdir(): Promise<void> {
        /* no-op for fake */
      },
      async realpath(path: string): Promise<string> {
        const node = store.get(path);
        if (node && node.kind === 'symlink') return node.value;
        // Non-existent paths should surface ENOENT so write checks
        // can fall through to the canonical-path assertion.
        if (!node && !isPrefixOfRegistered(path, store)) {
          const err = new Error(`ENOENT: ${path}`) as Error & { code?: string };
          err.code = 'ENOENT';
          throw err;
        }
        return path;
      },
    },
  };
}

function isPrefixOfRegistered(path: string, store: Map<string, FakeNode>): boolean {
  const prefix = `${path}/`;
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) return true;
  }
  return false;
}

describe('posixResolve', () => {
  it('collapses . and .. without escaping root', () => {
    expect(posixResolve('/mnt/wiki/./foo/../bar')).toBe('/mnt/wiki/bar');
    expect(posixResolve('/mnt/wiki/../../etc/passwd')).toBe('/etc/passwd');
    expect(posixResolve('/mnt/wiki/')).toBe('/mnt/wiki');
    expect(posixResolve('/a/b/c/..')).toBe('/a/b');
  });
});

describe('buildFsHandlers: readTextFile', () => {
  it('reads a file inside a registered mount', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({
        '/mnt/wiki/hello.md': { kind: 'file', value: 'hi\nfrom wiki' },
      }),
    });
    const res = await handlers.readTextFile({
      path: '/mnt/wiki/hello.md',
      sessionId: 's1',
    });
    expect(res.content).toBe('hi\nfrom wiki');
  });

  it('applies line and limit when provided', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({
        '/mnt/wiki/hello.md': { kind: 'file', value: 'a\nb\nc\nd\ne' },
      }),
    });
    const res = await handlers.readTextFile({
      path: '/mnt/wiki/hello.md',
      sessionId: 's1',
      line: 2,
      limit: 2,
    });
    expect(res.content).toBe('b\nc');
  });

  it('rejects a path outside /mnt/*', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({}),
    });
    await expect(handlers.readTextFile({ path: '/etc/passwd', sessionId: 's1' })).rejects.toThrow(
      /path must be absolute under \/mnt\//
    );
  });

  it('rejects an unknown mount', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({
        '/mnt/evil/pw': { kind: 'file', value: 'nope' },
      }),
    });
    await expect(handlers.readTextFile({ path: '/mnt/evil/pw', sessionId: 's1' })).rejects.toThrow(
      /unknown mount 'evil'/
    );
  });

  it('rejects a `..` escape even into a sibling mount', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki', 'code']),
      fsImpl: makeFakeFs({
        '/mnt/code/secret': { kind: 'file', value: 'nope' },
      }),
    });
    await expect(
      handlers.readTextFile({ path: '/mnt/wiki/../code/secret', sessionId: 's1' })
    ).rejects.toThrow(/path escapes mount 'wiki'/);
  });

  it('rejects a `..` escape above /mnt entirely', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({}),
    });
    await expect(
      handlers.readTextFile({ path: '/mnt/wiki/../../etc/passwd', sessionId: 's1' })
    ).rejects.toThrow(/escapes mount/);
  });

  it('rejects a symlink that resolves outside the mount', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({
        '/mnt/wiki/evil': { kind: 'symlink', value: '/etc/passwd' },
      }),
    });
    await expect(
      handlers.readTextFile({ path: '/mnt/wiki/evil', sessionId: 's1' })
    ).rejects.toThrow(/symlink leaves mount/);
  });

  it('accepts a symlink that resolves within the same mount', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({
        '/mnt/wiki/alias': { kind: 'symlink', value: '/mnt/wiki/target' },
        '/mnt/wiki/target': { kind: 'file', value: 'OK' },
      }),
    });
    const res = await handlers.readTextFile({
      path: '/mnt/wiki/alias',
      sessionId: 's1',
    });
    expect(res.content).toBe('OK');
  });
});

describe('buildFsHandlers: writeTextFile', () => {
  it('writes a file inside a registered mount', async () => {
    const files: Record<string, FakeNode> = {
      '/mnt/wiki': { kind: 'file', value: '' }, // acts as existing root
    };
    const fsImpl = makeFakeFs(files);
    const writeSpy = vi.spyOn(fsImpl.promises, 'writeFile');
    const handlers = buildFsHandlers({ view: makeView(['wiki']), fsImpl });
    const res = await handlers.writeTextFile({
      path: '/mnt/wiki/note.txt',
      content: 'hello',
      sessionId: 's1',
    });
    expect(res).toEqual({});
    expect(writeSpy).toHaveBeenCalledWith('/mnt/wiki/note.txt', 'hello', { encoding: 'utf8' });
  });

  it('rejects writes to unknown mounts', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({ '/mnt/wiki': { kind: 'file', value: '' } }),
    });
    await expect(
      handlers.writeTextFile({
        path: '/mnt/other/file.txt',
        content: 'hi',
        sessionId: 's1',
      })
    ).rejects.toThrow(/unknown mount 'other'/);
  });

  it('rejects writes that escape via `..`', async () => {
    const handlers = buildFsHandlers({
      view: makeView(['wiki']),
      fsImpl: makeFakeFs({ '/mnt/wiki': { kind: 'file', value: '' } }),
    });
    await expect(
      handlers.writeTextFile({
        path: '/mnt/wiki/../evil.txt',
        content: 'hi',
        sessionId: 's1',
      })
    ).rejects.toThrow(/escapes mount/);
  });
});
