import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { configure, fs, InMemory } from '@zenfs/core';
import { mount, umount } from '@zenfs/core/vfs';
import { buildFsHandlers, type VolumeRegistryView } from './fs-handlers';

const WIKI_MOUNT = '/mnt/wiki';

async function resetMount() {
  try {
    umount(WIKI_MOUNT);
  } catch {
    /* not mounted */
  }
}

describe('fs-handlers integration (real ZenFS)', () => {
  let view: VolumeRegistryView;

  beforeEach(async () => {
    await configure({ mounts: {} });
    await resetMount();
    mount(WIKI_MOUNT, InMemory.create({ label: 'wiki' }));
    await fs.promises.writeFile(`${WIKI_MOUNT}/hello.md`, '# hi\nfrom wiki');
    view = { list: () => [{ mountName: 'wiki' }] };
  });

  afterEach(async () => {
    await resetMount();
  });

  it('reads bytes written by the worker-equivalent ZenFS mount', async () => {
    const handlers = buildFsHandlers({ view });
    const res = await handlers.readTextFile({
      path: '/mnt/wiki/hello.md',
      sessionId: 's1',
    });
    expect(res.content).toContain('from wiki');
  });

  it('writes a file that reads back via the same handler', async () => {
    const handlers = buildFsHandlers({ view });
    await handlers.writeTextFile({
      path: '/mnt/wiki/out.txt',
      content: 'round-trip',
      sessionId: 's1',
    });
    const res = await handlers.readTextFile({
      path: '/mnt/wiki/out.txt',
      sessionId: 's1',
    });
    expect(res.content).toBe('round-trip');
  });

  it('preserves bash-side writes (bytes) through `readTextFile`', async () => {
    await fs.promises.writeFile(`${WIKI_MOUNT}/note.txt`, 'from-bash');
    const handlers = buildFsHandlers({ view });
    const res = await handlers.readTextFile({
      path: '/mnt/wiki/note.txt',
      sessionId: 's1',
    });
    expect(res.content).toBe('from-bash');
  });

  it('rejects reads outside of /mnt/*', async () => {
    const handlers = buildFsHandlers({ view });
    await expect(handlers.readTextFile({ path: '/etc/passwd', sessionId: 's1' })).rejects.toThrow(
      /path must be absolute under \/mnt\//
    );
  });

  it('rejects an unknown mount even when the underlying path would resolve', async () => {
    const handlers = buildFsHandlers({ view });
    await expect(
      handlers.readTextFile({ path: '/mnt/other/any.md', sessionId: 's1' })
    ).rejects.toThrow(/unknown mount 'other'/);
  });
});
