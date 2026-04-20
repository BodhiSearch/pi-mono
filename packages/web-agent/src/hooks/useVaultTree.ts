/**
 * Walks the mounted vault and returns a nested tree of files/directories.
 *
 * Polls ZenFS on a short interval while the vault is mounted so writes from
 * the agent (via the write / edit tools) surface in the UI without a manual
 * refresh. The poll interval matches the old flat-list hook.
 *
 * Stable-shape invariant: when the tree content is unchanged between polls,
 * the same `nodes` reference is returned so React doesn't bust memoised
 * tree subtrees.
 */

import { useEffect, useState } from 'react';
import { fs, VAULT_MOUNT } from '@/web-agent';
import type { VaultMountStatus } from '@/hooks/useVaultMount';

const POLL_INTERVAL_MS = 500;

export interface VaultTreeNode {
  name: string;
  /** Absolute path including `/vault/` prefix. */
  path: string;
  kind: 'file' | 'directory';
  /** Populated for directories. Empty for files. */
  children: VaultTreeNode[];
}

const EMPTY: readonly VaultTreeNode[] = Object.freeze([]);

async function walkVaultTree(root: string): Promise<VaultTreeNode[]> {
  async function recurse(dir: string): Promise<VaultTreeNode[]> {
    let entries: string[];
    try {
      const raw = await fs.promises.readdir(dir);
      entries = raw.map((e: unknown) => (typeof e === 'string' ? e : (e as { name: string }).name));
    } catch {
      return [];
    }
    const nodes: VaultTreeNode[] = [];
    for (const name of entries) {
      const full = dir.endsWith('/') ? `${dir}${name}` : `${dir}/${name}`;
      let stat;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        nodes.push({
          name,
          path: full,
          kind: 'directory',
          children: await recurse(full),
        });
      } else if (stat.isFile()) {
        nodes.push({ name, path: full, kind: 'file', children: [] });
      }
    }
    return sortNodes(nodes);
  }
  return recurse(root);
}

function sortNodes(nodes: VaultTreeNode[]): VaultTreeNode[] {
  return nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function treesEqual(a: readonly VaultTreeNode[], b: readonly VaultTreeNode[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.path !== y.path || x.kind !== y.kind || x.name !== y.name) return false;
    if (!treesEqual(x.children, y.children)) return false;
  }
  return true;
}

export interface UseVaultTreeResult {
  nodes: readonly VaultTreeNode[];
}

export function useVaultTree(status: VaultMountStatus): UseVaultTreeResult {
  const [nodes, setNodes] = useState<readonly VaultTreeNode[]>(EMPTY);

  useEffect(() => {
    let cancelled = false;

    if (status !== 'mounted') {
      (async () => {
        await Promise.resolve();
        if (!cancelled) setNodes(EMPTY);
      })();
      return () => {
        cancelled = true;
      };
    }

    async function tick(): Promise<void> {
      const next = await walkVaultTree(VAULT_MOUNT);
      if (cancelled) return;
      setNodes(prev => (treesEqual(prev, next) ? prev : next));
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

  return { nodes };
}
