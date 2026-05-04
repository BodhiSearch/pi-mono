/**
 * Worker-side ZenFS multi-volume mount registry.
 *
 * The agent package is backend-agnostic: it accepts a pre-constructed
 * ZenFS `FileSystem` instance and mounts it at `/mnt/<mountName>`. The
 * host runtime (browser today, future Node bootstrap) supplies the
 * concrete backend — `@zenfs/dom`'s `WebAccess` for FSA handles,
 * `@zenfs/core`'s `InMemory` for seed-backed dev volumes. The
 * registry never imports `@zenfs/dom` so the same code can run in any
 * environment that has `@zenfs/core` available.
 *
 * The registry notifies listeners after every state transition so the
 * adapter can fan out `_bodhi/volumes/changed`-style notifications or
 * refresh the LLM system prompt.
 */

import type { FileSystem } from '@zenfs/core';
import { configure } from '@zenfs/core';
import { mount, umount } from '@zenfs/core/vfs';

export interface VolumeInit {
  mountName: string;
  description?: string;
  /**
   * Pre-constructed ZenFS file system. Hosts construct this via a
   * backend factory (FSA / InMemory / Node fs / etc.) and hand it off;
   * the registry calls `mount(/mnt/<mountName>, fs)` on it.
   */
  fs: FileSystem;
  /**
   * Optional post-mount hook. Runs after the file system is mounted
   * at `/mnt/<mountName>`. Hosts use this to seed in-memory backends
   * (write the dev seed via `@zenfs/core`'s global `fs.promises.*`)
   * without exposing the seeding logic to the agent.
   */
  initialize?: () => Promise<void>;
}

export interface VolumeSnapshot {
  mountName: string;
  description?: string;
}

export type VolumeRegistryListener = (snapshot: VolumeSnapshot[]) => void;

export interface VolumeRegistry {
  mountAll(initial: VolumeInit[]): Promise<void>;
  mount(init: VolumeInit): Promise<void>;
  unmount(mountName: string): Promise<void>;
  list(): VolumeSnapshot[];
  firstMountName(): string | undefined;
  onChange(listener: VolumeRegistryListener): () => void;
}

// Process-global guard: ZenFS keeps one `mounts` map per process,
// so `configure` must run at most once. See `volumes.md`.
let zenfsConfiguredGlobally = false;

export class ZenfsVolumeRegistry implements VolumeRegistry {
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
    mount(mountPath, init.fs);
    if (init.initialize) {
      await init.initialize();
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
    if (!zenfsConfiguredGlobally) {
      await configure({ mounts: {} });
      zenfsConfiguredGlobally = true;
    }
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
