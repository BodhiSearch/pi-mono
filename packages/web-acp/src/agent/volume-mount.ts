/**
 * Worker-side ZenFS multi-volume mount registry.
 *
 * Each volume is mounted at `/mnt/<mountName>` using either a
 * `WebAccess` backend (real FSA handle from the main thread) or an
 * `InMemory` backend pre-populated from a dev/test seed. The registry
 * notifies listeners after every state transition so the adapter can
 * fan out `_bodhi/volumes/changed`-style notifications or refresh the
 * LLM system prompt.
 */
import { configure, fs, InMemory } from '@zenfs/core';
import { mount, umount } from '@zenfs/core/vfs';
import { WebAccess } from '@zenfs/dom';

export interface VolumeSeed {
  name: string;
  description?: string;
  files: Record<string, string>;
}

export interface VolumeInit {
  handle?: FileSystemDirectoryHandle;
  seed?: VolumeSeed;
  mountName: string;
  description?: string;
}

export interface VolumeSnapshot {
  mountName: string;
  description?: string;
}

export type VolumeRegistryListener = (snapshot: VolumeSnapshot[]) => void;

export class VolumeRegistry {
  #volumes = new Map<string, VolumeSnapshot>();
  #listeners = new Set<VolumeRegistryListener>();
  #zenfsConfigured = false;

  async mountAll(initial: VolumeInit[]): Promise<void> {
    for (const init of initial) {
      try {
        await this.mount(init);
      } catch (err) {
        console.error(`[VolumeRegistry] mountAll: failed to mount ${init.mountName}:`, err);
      }
    }
  }

  async mount(init: VolumeInit): Promise<void> {
    if (this.#volumes.has(init.mountName)) {
      throw new Error(`Volume '${init.mountName}' already mounted`);
    }
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
    this.#volumes.set(init.mountName, {
      mountName: init.mountName,
      ...(init.description ? { description: init.description } : {}),
    });
    this.#notify();
  }

  async unmount(mountName: string): Promise<void> {
    if (!this.#volumes.has(mountName)) return;
    try {
      umount(`/mnt/${mountName}`);
    } catch (err) {
      console.warn(`[VolumeRegistry] unmount: vfs.umount failed for ${mountName}:`, err);
    }
    this.#volumes.delete(mountName);
    this.#notify();
  }

  list(): VolumeSnapshot[] {
    return [...this.#volumes.values()];
  }

  firstMountName(): string | undefined {
    const first = this.#volumes.values().next();
    return first.done ? undefined : first.value.mountName;
  }

  onChange(listener: VolumeRegistryListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #ensureZenfs(): Promise<void> {
    if (this.#zenfsConfigured) return;
    // Start with an empty VFS config so subsequent calls to
    // `mount(path, backend)` land on a known surface. Idempotent across
    // tests that reset module state.
    await configure({ mounts: {} });
    this.#zenfsConfigured = true;
  }

  #notify(): void {
    const snapshot = this.list();
    for (const listener of this.#listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        console.error('[VolumeRegistry] listener threw:', err);
      }
    }
  }
}

async function seedInMemoryBackend(mountPath: string, seed: VolumeSeed): Promise<void> {
  const entries = Object.keys(seed.files).sort();
  for (const rel of entries) {
    const absolute = rel.startsWith('/')
      ? joinMount(mountPath, rel)
      : joinMount(mountPath, `/${rel}`);
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

function joinMount(mountPath: string, relative: string): string {
  // Seed keys may already be written as `/mnt/<name>/…` (web-agent
  // legacy shape) or as `/…` scoped to the volume root. Both resolve
  // to the same absolute path after normalising the `mnt/<name>` prefix.
  if (relative.startsWith(`${mountPath}/`)) return relative;
  return `${mountPath}${relative.startsWith('/') ? '' : '/'}${relative}`;
}

function isExistsError(err: unknown): boolean {
  return (
    err !== null &&
    typeof err === 'object' &&
    'code' in err &&
    (err as { code?: string }).code === 'EEXIST'
  );
}
