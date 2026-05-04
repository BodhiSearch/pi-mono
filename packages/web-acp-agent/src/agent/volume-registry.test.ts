import { fs, vfs } from '@zenfs/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildSeedInit } from '../test-utils/seed-volume';
import { ZenfsVolumeRegistry } from './volume-registry';

async function drainMounts(names: string[], registry: ZenfsVolumeRegistry): Promise<void> {
  for (const name of names) {
    try {
      await registry.unmount(name);
    } catch {
      try {
        vfs.umount(`/mnt/${name}`);
      } catch {
        /* best-effort */
      }
    }
  }
}

describe('ZenfsVolumeRegistry', () => {
  let registry: ZenfsVolumeRegistry;

  beforeEach(async () => {
    if (registry) {
      await drainMounts(
        registry.list().map(v => v.mountName),
        registry
      );
    }
    registry = new ZenfsVolumeRegistry();
  });

  it('mounts multiple seeded volumes and reports them', async () => {
    await registry.mountAll([
      buildSeedInit({
        mountName: 'wiki',
        description: 'knowledge base',
        files: { '/hello.md': '# hi\nfrom wiki' },
      }),
      buildSeedInit({
        mountName: 'code',
        files: { '/readme.txt': 'code readme' },
      }),
    ]);
    const list = registry.list();
    expect(list).toHaveLength(2);
    expect(list.map(v => v.mountName).sort()).toEqual(['code', 'wiki']);
    expect(registry.firstMountName()).toBe('wiki');
    const wikiContent = await fs.promises.readFile('/mnt/wiki/hello.md', 'utf8');
    expect(wikiContent).toContain('from wiki');
    const codeContent = await fs.promises.readFile('/mnt/code/readme.txt', 'utf8');
    expect(codeContent).toBe('code readme');
  });

  it('rejects re-mounting the same name until unmount', async () => {
    await registry.mount(
      buildSeedInit({
        mountName: 'wiki',
        files: { '/a.txt': '1' },
      })
    );
    await expect(
      registry.mount(
        buildSeedInit({
          mountName: 'wiki',
          files: { '/b.txt': '2' },
        })
      )
    ).rejects.toThrow(/already mounted/);
    await registry.unmount('wiki');
    await registry.mount(
      buildSeedInit({
        mountName: 'wiki',
        files: { '/b.txt': '2' },
      })
    );
    expect(registry.list().map(v => v.mountName)).toEqual(['wiki']);
  });

  it('notifies listeners on every state transition', async () => {
    const events: number[] = [];
    registry.onChange(snapshot => events.push(snapshot.length));
    await registry.mount(
      buildSeedInit({
        mountName: 'wiki',
        files: { '/a.txt': '1' },
      })
    );
    await registry.mount(
      buildSeedInit({
        mountName: 'code',
        files: { '/b.txt': '2' },
      })
    );
    await registry.unmount('wiki');
    expect(events).toEqual([1, 2, 1]);
  });

  it('does not clobber a sibling registry that already mounted into the global VFS', async () => {
    // ZenFS keeps a process-global mounts map. A second
    // `ZenfsVolumeRegistry` must NOT call `configure({ mounts: {} })`
    // a second time — that would wipe the first registry's mounts.
    // We expect mounts from both registries to coexist in the global VFS.
    await registry.mount(
      buildSeedInit({ mountName: 'wiki', files: { '/a.txt': 'first registry' } })
    );

    const second = new ZenfsVolumeRegistry();
    try {
      await second.mount(
        buildSeedInit({ mountName: 'docs', files: { '/b.txt': 'second registry' } })
      );

      // Both mounts should be readable through the global ZenFS VFS.
      const a = await fs.promises.readFile('/mnt/wiki/a.txt', 'utf8');
      const b = await fs.promises.readFile('/mnt/docs/b.txt', 'utf8');
      expect(a).toBe('first registry');
      expect(b).toBe('second registry');
    } finally {
      await drainMounts(
        second.list().map(v => v.mountName),
        second
      );
    }
  });
});
