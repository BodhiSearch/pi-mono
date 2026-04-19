/**
 * Adapters from `@zenfs/core`'s `fs.promises` to the per-tool Operations
 * interfaces the filesystem tools accept.
 *
 * Split by tool so each tool receives only what it needs — this keeps the
 * operations "narrow" for mocking in unit tests and makes future worker-side
 * proxying easier (only the surface the tool actually reaches needs to be
 * bridged).
 */

import { fs } from './zenfs-provider';

export interface ReadOperations {
  readFile: (absolutePath: string) => Promise<Uint8Array>;
  access: (absolutePath: string) => Promise<void>;
}

export interface WriteOperations {
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
}

export interface EditOperations {
  readFile: (absolutePath: string) => Promise<Uint8Array>;
  writeFile: (absolutePath: string, content: string) => Promise<void>;
  access: (absolutePath: string) => Promise<void>;
}

export interface LsOperations {
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
  readdir: (absolutePath: string) => Promise<string[]>;
}

export interface GlobOperations {
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
  readdir: (absolutePath: string) => Promise<string[]>;
}

export interface GrepOperations {
  stat: (absolutePath: string) => Promise<{ isDirectory: () => boolean; isFile: () => boolean }>;
  readdir: (absolutePath: string) => Promise<string[]>;
  readFile: (absolutePath: string) => Promise<string>;
}

export interface VaultOperations {
  read: ReadOperations;
  write: WriteOperations;
  edit: EditOperations;
  ls: LsOperations;
  glob: GlobOperations;
  grep: GrepOperations;
}

async function readFileBytes(path: string): Promise<Uint8Array> {
  const buf = await fs.promises.readFile(path);
  return new Uint8Array(buf as unknown as ArrayBuffer);
}

async function readFileText(path: string): Promise<string> {
  const buf = await fs.promises.readFile(path);
  return new TextDecoder().decode(buf as unknown as ArrayBuffer);
}

async function statNormalized(
  path: string
): Promise<{ isDirectory: () => boolean; isFile: () => boolean }> {
  const s = await fs.promises.stat(path);
  return {
    isDirectory: () => s.isDirectory(),
    isFile: () => s.isFile(),
  };
}

async function readdirNormalized(path: string): Promise<string[]> {
  const entries = await fs.promises.readdir(path);
  return entries.map(e => (typeof e === 'string' ? e : (e as { name: string }).name));
}

/**
 * Build all six operations objects from the default ZenFS backend currently
 * mounted at `/vault`. Callers typically pass these straight through to
 * `createVaultTools`.
 */
export function createZenfsVaultOperations(): VaultOperations {
  return {
    read: {
      readFile: readFileBytes,
      access: path => fs.promises.access(path),
    },
    write: {
      writeFile: (path, content) => fs.promises.writeFile(path, content, { encoding: 'utf8' }),
      mkdir: async dir => {
        await fs.promises.mkdir(dir, { recursive: true });
      },
    },
    edit: {
      readFile: readFileBytes,
      writeFile: (path, content) => fs.promises.writeFile(path, content, { encoding: 'utf8' }),
      access: path => fs.promises.access(path),
    },
    ls: {
      stat: statNormalized,
      readdir: readdirNormalized,
    },
    glob: {
      stat: statNormalized,
      readdir: readdirNormalized,
    },
    grep: {
      stat: statNormalized,
      readdir: readdirNormalized,
      readFile: readFileText,
    },
  };
}
