/**
 * Narrow filesystem facade the extension loader uses to walk a
 * volume's `/.pi/extensions/<name>/index.js` files.
 *
 * Mirrors `agent/commands/loader.ts:CommandsFs` — keeps the loader
 * testable with an in-memory fake and gives production code a
 * single `@zenfs/core` touchpoint.
 */

import { fs as zenfs } from '@zenfs/core';

export interface ExtensionsFsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface ExtensionsFs {
  /** Returns directory entries; resolves to `[]` when the path doesn't exist. */
  readdir(absolutePath: string): Promise<ExtensionsFsEntry[]>;
  /** Returns UTF-8 file content. Throws when the file doesn't exist. */
  readFile(absolutePath: string): Promise<string>;
}

/**
 * Writable counterpart to {@link ExtensionsFs}. Used by the install path
 * (`_bodhi/extensions/add`) to persist tarball contents into a vault
 * volume tagged `agent-wd`. Kept narrow on purpose — the loader path
 * never sees this surface.
 */
export interface ExtensionsWriteFs {
  /** Recursively creates `absolutePath` (idempotent — ENOENT-on-parent OK). */
  mkdir(absolutePath: string): Promise<void>;
  /** Writes UTF-8 string content; creates parent dirs as needed. */
  writeFile(absolutePath: string, contents: string): Promise<void>;
  /**
   * Recursively removes `absolutePath` if it exists. Idempotent on missing
   * paths so re-installing the same extension is safe.
   */
  rm(absolutePath: string): Promise<void>;
}

export const EXTENSIONS_DIR_RELPATH = '.pi/extensions';

export function createZenfsExtensionsFs(): ExtensionsFs {
  return {
    async readdir(absolutePath) {
      try {
        const entries = await zenfs.promises.readdir(absolutePath, { withFileTypes: true });
        return entries.map(entry => ({
          name: entry.name,
          isFile: entry.isFile(),
          isDirectory: entry.isDirectory(),
        }));
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return [];
        throw err;
      }
    },
    async readFile(absolutePath) {
      const buffer = await zenfs.promises.readFile(absolutePath);
      if (typeof buffer === 'string') return buffer;
      return new TextDecoder('utf-8').decode(buffer as Uint8Array);
    },
  };
}

export function createZenfsExtensionsWriteFs(): ExtensionsWriteFs {
  return {
    async mkdir(absolutePath) {
      await zenfs.promises.mkdir(absolutePath, { recursive: true });
    },
    async writeFile(absolutePath, contents) {
      const parent = dirOf(absolutePath);
      if (parent) await zenfs.promises.mkdir(parent, { recursive: true });
      await zenfs.promises.writeFile(absolutePath, contents, 'utf-8');
    },
    async rm(absolutePath) {
      try {
        await zenfs.promises.rm(absolutePath, { recursive: true, force: true });
      } catch (err: unknown) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ENOENT') return;
        throw err;
      }
    },
  };
}

function dirOf(absolutePath: string): string | undefined {
  const idx = absolutePath.lastIndexOf('/');
  if (idx <= 0) return undefined;
  return absolutePath.slice(0, idx);
}
