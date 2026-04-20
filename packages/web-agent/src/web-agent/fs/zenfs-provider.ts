/**
 * Mount a FileSystemDirectoryHandle at /vault via ZenFS.
 *
 * Pattern copied from bodhiapps/zenfs-browser. The WebAccess backend wraps
 * the native FSA handle; /vault becomes the root for all fs tools.
 */

import { configure, fs, vfs } from '@zenfs/core';
import { WebAccess } from '@zenfs/dom';

export { fs };

export const VAULT_MOUNT = '/vault';

let mounted = false;
let mountedHandle: FileSystemDirectoryHandle | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Mount the given FileSystemDirectoryHandle at /vault.
 *
 * Serialised via a module-level promise so overlapping callers (React
 * StrictMode re-running effects, provider unmount/remount on fast refresh)
 * don't race `configure`/`vfs.mount`. If the same handle is already mounted
 * or is currently being mounted the call is a no-op / shares the in-flight
 * promise.
 */
export async function mountVault(handle: FileSystemDirectoryHandle): Promise<void> {
  if (inFlight) {
    await inFlight;
    if (mounted && mountedHandle === handle) return;
  }
  if (mounted && mountedHandle === handle) return;

  inFlight = (async () => {
    if (mounted) {
      await unmountInternal();
    }
    await configure({ mounts: {} });
    const webAccessFs = await WebAccess.create({ handle });
    vfs.mount(VAULT_MOUNT, webAccessFs);
    mounted = true;
    mountedHandle = handle;
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
  }
}

async function unmountInternal(): Promise<void> {
  try {
    vfs.umount(VAULT_MOUNT);
  } catch {
    // mount may not exist if the page was freshly loaded
  }
  mounted = false;
  mountedHandle = null;
}

/** Unmount /vault. Safe to call when nothing is mounted. */
export async function unmountVault(): Promise<void> {
  if (inFlight) {
    await inFlight;
  }
  if (!mounted) return;
  await unmountInternal();
}

export function isVaultMounted(): boolean {
  return mounted;
}

/**
 * Marks the provider's internal mounted flag. Used by the dev-seed boot
 * path which configures the InMemory backend directly and needs the flag
 * to reflect reality so subsequent unmount calls work.
 */
export function setMountedForSeed(value: boolean): void {
  mounted = value;
  if (!value) mountedHandle = null;
}
