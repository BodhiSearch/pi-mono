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

/**
 * Mount the given FileSystemDirectoryHandle at /vault.
 *
 * If a previous mount exists it is unmounted first (handle switching).
 * The root filesystem is configured with an empty mounts map so the /vault
 * subdirectory exists in the VFS.
 */
export async function mountVault(handle: FileSystemDirectoryHandle): Promise<void> {
  if (mounted) {
    await unmountVault();
  }
  await configure({ mounts: {} });
  const webAccessFs = await WebAccess.create({ handle });
  vfs.mount(VAULT_MOUNT, webAccessFs);
  mounted = true;
}

/** Unmount /vault. Safe to call when nothing is mounted. */
export async function unmountVault(): Promise<void> {
  if (!mounted) return;
  try {
    vfs.umount(VAULT_MOUNT);
  } catch {
    // mount may not exist if the page was freshly loaded
  }
  mounted = false;
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
}
