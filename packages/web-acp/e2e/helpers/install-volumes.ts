import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Page } from '@playwright/test';

export interface VolumeSeedSpec {
  name: string;
  description?: string;
  /**
   * Directory under `packages/web-acp/e2e/data/<dataDir>/` to walk. If
   * omitted, `files` must be set explicitly.
   */
  dataDir?: string;
  /**
   * Inline file map. Keys are either absolute paths (starting with
   * `/`) scoped to the volume root, or plain relative paths which
   * will be anchored to the root.
   */
  files?: Record<string, string>;
  tags?: readonly string[];
}

/**
 * installVolumes — seeds one or more `/mnt/<name>` volumes on the
 * page via `window.__zenfsSeed`. The agent worker's `useVolumes`
 * hook picks this up on the main thread, forwards it as a
 * `VolumeInit[]` through the worker init message, and the worker
 * mounts each volume using an `InMemory` backend.
 *
 * Mirrors `packages/web-agent/e2e/helpers/install-vault.ts` but
 * supports multiple volumes and carries optional descriptions that
 * flow into the LLM's system prompt.
 */
export async function installVolumes(page: Page, seeds: VolumeSeedSpec[]): Promise<void> {
  const resolved: Array<{
    name: string;
    description?: string;
    files: Record<string, string>;
    tags?: readonly string[];
  }> = [];
  for (const seed of seeds) {
    const files = { ...(seed.files ?? {}) };
    if (seed.dataDir) {
      const root = join(process.cwd(), 'e2e', 'data', seed.dataDir);
      await walk(root, root, files);
    }
    resolved.push({
      name: seed.name,
      ...(seed.description ? { description: seed.description } : {}),
      files,
      ...(seed.tags && seed.tags.length > 0 ? { tags: seed.tags } : {}),
    });
  }
  await page.addInitScript(list => {
    (window as unknown as { __zenfsSeed: unknown }).__zenfsSeed = list;
  }, resolved);
}

async function walk(root: string, dir: string, out: Record<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(root, abs, out);
    } else if (entry.isFile()) {
      const rel = '/' + relative(root, abs).split(/[\\/]/).join('/');
      out[rel] = await readFile(abs, 'utf8');
    }
  }
}
