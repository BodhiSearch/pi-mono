/**
 * In-memory ZenFS vault for E2E tests.
 *
 * TEST-ONLY. Loaded via `useDevSeedBoot`'s `import.meta.env.DEV`-gated
 * dynamic import so this module tree-shakes out of production bundles.
 *
 * Accepts a seed of `{ name, files }` produced by `e2e/helpers/install-vault.ts`
 * (keys are absolute `/vault/...` paths, values are UTF-8 content), pre-mounts
 * a ZenFS InMemory backend at `/vault`, and writes the seeded files plus
 * their parent directories. After this runs, the rest of the app talks to
 * ZenFS without knowing the backend is InMemory.
 */

import { configure, fs, InMemory, vfs } from '@zenfs/core';
import { setMountedForSeed, VAULT_MOUNT } from '@/web-agent/fs/zenfs-provider';

export interface InMemoryVaultSeed {
  /** Absolute paths rooted at `/vault`, mapped to file contents (UTF-8 text). */
  files: Record<string, string>;
  /** Display name for the synthetic vault (used as the root directory label). */
  name: string;
}

// Module-level mount guard. Multiple React subtrees (Header + ChatDemo) both
// call useVaultMount → useDevSeedBoot, so without this guard we'd reconfigure
// ZenFS mid-session and wipe any files the agent wrote via the write tool.
let mountPromise: Promise<void> | null = null;

/**
 * Pre-mount the InMemory ZenFS backend populated with `seed`. Idempotent —
 * subsequent calls return the same promise and perform no additional work.
 */
export async function mountInMemoryVault(seed: InMemoryVaultSeed): Promise<void> {
  if (mountPromise) return mountPromise;
  mountPromise = performMount(seed);
  return mountPromise;
}

async function performMount(seed: InMemoryVaultSeed): Promise<void> {
  await configure({ mounts: {} });
  const memFs = InMemory.create({ label: seed.name });
  vfs.mount(VAULT_MOUNT, memFs);

  const paths = Object.keys(seed.files).sort();
  for (const absPath of paths) {
    const lastSlash = absPath.lastIndexOf('/');
    if (lastSlash > 0) {
      const parent = absPath.slice(0, lastSlash);
      try {
        await fs.promises.mkdir(parent, { recursive: true });
      } catch (err: unknown) {
        if (
          err === null ||
          typeof err !== 'object' ||
          !('code' in err) ||
          (err as { code?: string }).code !== 'EEXIST'
        ) {
          throw err;
        }
      }
    }
    await fs.promises.writeFile(absPath, seed.files[absPath], {
      encoding: 'utf8',
    });
  }

  setMountedForSeed(true);
}
