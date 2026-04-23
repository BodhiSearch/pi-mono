import { beforeEach, describe, expect, it } from 'vitest';
import { fs } from '@zenfs/core';
import { umount } from '@zenfs/core/vfs';
import { VolumeRegistry } from './volume-mount';

async function drainMounts(names: string[], registry: VolumeRegistry): Promise<void> {
  for (const name of names) {
    try {
      await registry.unmount(name);
    } catch {
      try {
        umount(`/mnt/${name}`);
      } catch {
        /* best-effort */
      }
    }
  }
}

describe('VolumeRegistry', () => {
  let registry: VolumeRegistry;

  beforeEach(async () => {
    if (registry) {
      await drainMounts(
        registry.list().map(v => v.mountName),
        registry
      );
    }
    registry = new VolumeRegistry();
  });

  it('mounts multiple seeded volumes and reports them', async () => {
    await registry.mountAll([
      {
        mountName: 'wiki',
        description: 'knowledge base',
        seed: { name: 'wiki', files: { '/hello.md': '# hi\nfrom wiki' } },
      },
      {
        mountName: 'code',
        seed: { name: 'code', files: { '/readme.txt': 'code readme' } },
      },
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
    await registry.mount({
      mountName: 'wiki',
      seed: { name: 'wiki', files: { '/a.txt': '1' } },
    });
    await expect(
      registry.mount({
        mountName: 'wiki',
        seed: { name: 'wiki', files: { '/b.txt': '2' } },
      })
    ).rejects.toThrow(/already mounted/);
    await registry.unmount('wiki');
    await registry.mount({
      mountName: 'wiki',
      seed: { name: 'wiki', files: { '/b.txt': '2' } },
    });
    expect(registry.list().map(v => v.mountName)).toEqual(['wiki']);
  });

  it('notifies listeners on every state transition', async () => {
    const events: number[] = [];
    registry.onChange(snapshot => events.push(snapshot.length));
    await registry.mount({
      mountName: 'wiki',
      seed: { name: 'wiki', files: { '/a.txt': '1' } },
    });
    await registry.mount({
      mountName: 'code',
      seed: { name: 'code', files: { '/b.txt': '2' } },
    });
    await registry.unmount('wiki');
    expect(events).toEqual([1, 2, 1]);
  });
});
