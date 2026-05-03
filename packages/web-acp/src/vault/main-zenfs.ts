/**
 * Main-thread ZenFS mount registry.
 *
 * The worker owns the source-of-truth ZenFS VFS: `WebAccess` backends
 * for real FSA handles and `InMemory` backends for dev/test seeds.
 * For the `fs/*` client handlers, the main thread needs to read the
 * same bytes. Rather than round-tripping every read/write through
 * the worker, we keep a *duplicate* ZenFS context on the main thread
 * that mounts the **same** `FileSystemDirectoryHandle`s — FSA handles
 * are structured-cloneable and the underlying storage is shared by
 * the OS, so both realms see the same bytes.
 *
 * Caveat (documented in `specs/web-acp-client/volumes.md`): two backends behind
 * the same handle don't coordinate writes. The built-in `bash` tool
 * never calls `fs/*`, so this is purely a seam for external ACP
 * agents; concurrent writes from inside and outside the worker are
 * therefore not expected until a later milestone introduces explicit
 * coordination.
 *
 * In-memory seeds cannot be shared across realms, so seed-mode
 * volumes get their own InMemory instance seeded with identical
 * content. Writes from the worker's `bash` tool therefore won't be
 * visible to the main-thread `fs/*` handlers when running against a
 * seed — this is acceptable because tests explicitly stage fixtures
 * on both sides (or simply read what they seeded).
 */
import { configure, fs, InMemory } from '@zenfs/core';
import { mount, umount } from '@zenfs/core/vfs';
import { WebAccess } from '@zenfs/dom';
import type { HostVolumeInit, VolumeSeed } from '@/runtime/volumes-fsa';

export interface MainMountSnapshot {
  mountName: string;
  description?: string;
}

export class MainZenfs {
  #mounted = new Map<string, MainMountSnapshot>();
  #configured = false;

  async mountAll(initial: HostVolumeInit[]): Promise<void> {
    for (const init of initial) {
      try {
        await this.mount(init);
      } catch (err) {
        console.error(`[MainZenfs] mountAll: failed to mount ${init.mountName}:`, err);
      }
    }
  }

  async mount(init: HostVolumeInit): Promise<void> {
    if (this.#mounted.has(init.mountName)) return;
    await this.#ensureZenfs();
    const mountPath = `/mnt/${init.mountName}`;
    if (init.handle) {
      const backend = await WebAccess.create({ handle: init.handle });
      mount(mountPath, backend);
    } else if (init.seed) {
      const backend = InMemory.create({ label: init.seed.name });
      mount(mountPath, backend);
      await seedInMemoryBackend(mountPath, init.seed);
    } else {
      throw new Error(`Volume '${init.mountName}' needs either a handle or a seed`);
    }
    this.#mounted.set(init.mountName, {
      mountName: init.mountName,
      ...(init.description ? { description: init.description } : {}),
    });
  }

  async unmount(mountName: string): Promise<void> {
    if (!this.#mounted.has(mountName)) return;
    try {
      umount(`/mnt/${mountName}`);
    } catch (err) {
      console.warn(`[MainZenfs] unmount: vfs.umount failed for ${mountName}:`, err);
    }
    this.#mounted.delete(mountName);
  }

  list(): MainMountSnapshot[] {
    return [...this.#mounted.values()];
  }

  has(mountName: string): boolean {
    return this.#mounted.has(mountName);
  }

  async #ensureZenfs(): Promise<void> {
    if (this.#configured) return;
    await configure({ mounts: {} });
    this.#configured = true;
  }
}

async function seedInMemoryBackend(mountPath: string, seed: VolumeSeed): Promise<void> {
  const entries = Object.keys(seed.files).sort();
  for (const rel of entries) {
    const absolute = rel.startsWith(`${mountPath}/`)
      ? rel
      : `${mountPath}${rel.startsWith('/') ? '' : '/'}${rel}`;
    const lastSlash = absolute.lastIndexOf('/');
    if (lastSlash > 0) {
      const parent = absolute.slice(0, lastSlash);
      try {
        await fs.promises.mkdir(parent, { recursive: true });
      } catch (err: unknown) {
        if (!isExistsError(err)) throw err;
      }
    }
    await fs.promises.writeFile(absolute, seed.files[rel], { encoding: 'utf8' });
  }
}

function isExistsError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'EEXIST'
  );
}
