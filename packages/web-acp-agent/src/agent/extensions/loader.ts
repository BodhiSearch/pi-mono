/**
 * Discover and dynamically import extension entry points.
 *
 * Walks `<mount>/.pi/extensions/<name>/index.js` for every mounted
 * volume. For each `index.js`:
 *
 *   1. Read source via `ExtensionsFs.readFile`.
 *   2. Encode source as a `data:text/javascript;base64,...` URL.
 *   3. `await import(dataUrl)` and validate the default export is a
 *      function (the `ExtensionFactory`).
 *
 * Data URLs are used (rather than blob URLs) so the loader runs in
 * both browser/worker hosts and Node test environments — `Blob` +
 * `URL.createObjectURL` work in browsers but Node's dynamic
 * `import()` rejects `blob:` URLs.
 *
 * Failure modes (non-existent dir, malformed default export, import
 * throw) are logged via `warn(...)` and skipped — discovery stays
 * best-effort so a single bad extension can't brick the agent.
 *
 * Conflict resolution: same `<name>` from multiple volumes →
 * **first-wins** (mirrors `agent/commands/loader.ts`). Same
 * `<name>` ordering inside one volume is sorted alphabetically so
 * dedup is deterministic.
 */

import type { VolumeSnapshot } from '../volume-registry';
import { EXTENSIONS_DIR_RELPATH, type ExtensionsFs } from './extensions-fs';
import type { ExtensionFactory } from './types';

export interface LoadedExtensionModule {
  name: string;
  mountName: string;
  sourcePath: string;
  factory: ExtensionFactory;
}

export interface DiscoverExtensionsInput {
  mounts: ReadonlyArray<VolumeSnapshot>;
  fs: ExtensionsFs;
  warn?: (msg: string, err?: unknown) => void;
}

export async function discoverExtensions(
  input: DiscoverExtensionsInput
): Promise<LoadedExtensionModule[]> {
  const warn = input.warn ?? defaultWarn;
  const seen = new Map<string, LoadedExtensionModule>();
  for (const mount of input.mounts) {
    const root = `/mnt/${mount.mountName}/${EXTENSIONS_DIR_RELPATH}`;
    let entries: Awaited<ReturnType<ExtensionsFs['readdir']>>;
    try {
      entries = await input.fs.readdir(root);
    } catch (err) {
      warn(`[extensions] readdir failed for '${root}'`, err);
      continue;
    }
    const dirNames = entries
      .filter(e => e.isDirectory && !e.name.startsWith('.'))
      .map(e => e.name)
      .sort((a, b) => a.localeCompare(b));
    for (const name of dirNames) {
      if (seen.has(name)) {
        const existing = seen.get(name)!;
        warn(
          `[extensions] duplicate '${name}' from /mnt/${mount.mountName}/${EXTENSIONS_DIR_RELPATH}/${name} ` +
            `ignored (first registered from ${existing.sourcePath})`
        );
        continue;
      }
      const sourcePath = `${root}/${name}/index.js`;
      let source: string;
      try {
        source = await input.fs.readFile(sourcePath);
      } catch (err) {
        warn(`[extensions] '${name}' missing or unreadable index.js at '${sourcePath}'`, err);
        continue;
      }
      const factory = await importFactory(sourcePath, source, warn);
      if (!factory) continue;
      seen.set(name, {
        name,
        mountName: mount.mountName,
        sourcePath,
        factory,
      });
    }
  }
  return [...seen.values()];
}

async function importFactory(
  sourcePath: string,
  source: string,
  warn: (msg: string, err?: unknown) => void
): Promise<ExtensionFactory | undefined> {
  try {
    const dataUrl = `data:text/javascript;base64,${encodeBase64Utf8(source)}`;
    const mod = (await import(/* @vite-ignore */ dataUrl)) as { default?: unknown };
    const factory = mod.default;
    if (typeof factory !== 'function') {
      warn(
        `[extensions] '${sourcePath}' has no default-exported factory function (got ${typeof factory})`
      );
      return undefined;
    }
    return factory as ExtensionFactory;
  } catch (err) {
    warn(`[extensions] dynamic import failed for '${sourcePath}'`, err);
    return undefined;
  }
}

function encodeBase64Utf8(source: string): string {
  const bytes = new TextEncoder().encode(source);
  // `btoa` is global in browsers/workers; Node 18+ exposes it too.
  // Fallback to `Buffer` if neither is available (unlikely).
  const globals = globalThis as { btoa?: (s: string) => string; Buffer?: typeof Buffer };
  if (typeof globals.btoa === 'function') {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return globals.btoa(binary);
  }
  if (globals.Buffer) {
    return globals.Buffer.from(bytes).toString('base64');
  }
  throw new Error('No base64 encoder available (btoa/Buffer)');
}

function defaultWarn(msg: string, err?: unknown): void {
  if (err === undefined) console.warn(msg);
  else console.warn(msg, err);
}
