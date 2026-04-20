/**
 * Walks the mounted vault and returns the list of file paths.
 *
 * Refreshes on a short interval while the vault is mounted so writes from
 * the agent (via the write / edit tools) surface in the UI without
 * requiring the user to click a button. The poll interval is intentionally
 * small because the agent turn is already user-initiated — the worst case
 * is ~500ms of perceived latency, and we avoid coupling this hook to the
 * internal rpc event stream.
 */

import { useEffect, useState } from 'react';
import { fs, VAULT_MOUNT } from '@/web-agent';
import type { VaultMountStatus } from '@/hooks/useVaultMount';

const POLL_INTERVAL_MS = 500;
const EMPTY: readonly string[] = Object.freeze([]);

async function walkVault(root: string): Promise<string[]> {
  const collected: string[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: string[];
    try {
      const raw = await fs.promises.readdir(dir);
      entries = raw.map((e: unknown) => (typeof e === 'string' ? e : (e as { name: string }).name));
    } catch {
      return;
    }
    for (const name of entries) {
      const full = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
      let stat;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        await recurse(full);
      } else if (stat.isFile()) {
        collected.push(full);
      }
    }
  }
  await recurse(root);
  return collected.sort();
}

export function useVaultFiles(status: VaultMountStatus): readonly string[] {
  const [files, setFiles] = useState<readonly string[]>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    if (status !== 'mounted') {
      (async () => {
        await Promise.resolve();
        if (!cancelled) setFiles(EMPTY);
      })();
      return () => {
        cancelled = true;
      };
    }

    async function tick(): Promise<void> {
      const next = await walkVault(VAULT_MOUNT);
      if (cancelled) return;
      setFiles(prev => {
        if (prev.length === next.length && prev.every((p, i) => p === next[i])) return prev;
        return next;
      });
    }

    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [status]);

  return files;
}
