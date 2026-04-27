/**
 * Discover slash-command markdown files under each mounted volume.
 *
 * Scans `<mount>/.pi/commands/**\/*.md`, parses YAML-ish front-matter,
 * and returns `CommandDef[]` ordered by mount-registry order then by
 * sorted relative path. Names are mount-prefixed canonical strings
 * (see `path.ts`); duplicates within or across mounts are first-wins
 * with a warning.
 *
 * The loader takes a small `CommandsFs` interface rather than reaching
 * into ZenFS directly so unit tests can drive it with a synthetic
 * filesystem and the production wrapper (`createZenfsCommandsFs`) is
 * the single place that touches `@zenfs/core`.
 */

import { fs as zenfs } from '@zenfs/core';
import { parseFrontMatter } from './front-matter';
import { canonicalCommandName, COMMANDS_DIR_RELPATH, InvalidCommandPathError } from './path';
import type { CommandDef } from './types';

export interface CommandsFsEntry {
  name: string;
  isFile: boolean;
  isDirectory: boolean;
}

export interface CommandsFs {
  /** Returns directory entries; should resolve to an empty array if the path doesn't exist. */
  readdir(absolutePath: string): Promise<CommandsFsEntry[]>;
  /** Returns UTF-8 file content. */
  readFile(absolutePath: string): Promise<string>;
}

export interface CommandsLoaderInput {
  mounts: ReadonlyArray<{ mountName: string }>;
  fs: CommandsFs;
  warn?: (msg: string, err?: unknown) => void;
}

const MAX_DESCRIPTION_FALLBACK = 120;

export async function loadCommandsFromVolumes(input: CommandsLoaderInput): Promise<CommandDef[]> {
  const warn = input.warn ?? defaultWarn;
  const seen = new Map<string, CommandDef>();
  for (const mount of input.mounts) {
    const root = `/mnt/${mount.mountName}/${COMMANDS_DIR_RELPATH}`;
    const files = await collectMarkdownFiles(input.fs, root, '');
    files.sort((a, b) => a.localeCompare(b));
    for (const rel of files) {
      let name: string;
      try {
        name = canonicalCommandName({ mountName: mount.mountName, pathBelowCommands: rel });
      } catch (err) {
        if (err instanceof InvalidCommandPathError) {
          warn(
            `[commands] skipping '/mnt/${mount.mountName}/${COMMANDS_DIR_RELPATH}/${rel}': ${err.message}`
          );
          continue;
        }
        throw err;
      }
      if (seen.has(name)) {
        const existing = seen.get(name)!;
        warn(
          `[commands] duplicate '${name}' from /mnt/${mount.mountName}/${COMMANDS_DIR_RELPATH}/${rel} ` +
            `ignored (first registered from /mnt/${existing.source.mountName}/${existing.source.relPath})`
        );
        continue;
      }
      const absolute = `${root}/${rel}`;
      let raw: string;
      try {
        raw = await input.fs.readFile(absolute);
      } catch (err) {
        warn(`[commands] failed to read '${absolute}'`, err);
        continue;
      }
      let parsed: ReturnType<typeof parseFrontMatter>;
      try {
        parsed = parseFrontMatter(raw);
      } catch (err) {
        warn(`[commands] front-matter rejected for '${absolute}'`, err);
        continue;
      }
      const body = parsed.body;
      const description =
        (parsed.frontMatter.description ?? '').trim() || fallbackDescription(body);
      const argumentHint = (parsed.frontMatter['argument-hint'] ?? '').trim() || undefined;
      const def: CommandDef = {
        name,
        description,
        template: body,
        source: {
          mountName: mount.mountName,
          relPath: `${COMMANDS_DIR_RELPATH}/${rel}`,
        },
        ...(argumentHint ? { argumentHint } : {}),
      };
      seen.set(name, def);
    }
  }
  return [...seen.values()];
}

async function collectMarkdownFiles(fs: CommandsFs, root: string, rel: string): Promise<string[]> {
  const here = rel ? `${root}/${rel}` : root;
  let entries: CommandsFsEntry[];
  try {
    entries = await fs.readdir(here);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory) {
      const nested = await collectMarkdownFiles(fs, root, childRel);
      out.push(...nested);
      continue;
    }
    if (entry.isFile && entry.name.endsWith('.md')) {
      out.push(childRel);
    }
  }
  return out;
}

function fallbackDescription(body: string): string {
  const firstLine = (body.split(/\r?\n/, 1)[0] ?? '').trim();
  if (!firstLine) return '(no description)';
  return firstLine.length <= MAX_DESCRIPTION_FALLBACK
    ? firstLine
    : `${firstLine.slice(0, MAX_DESCRIPTION_FALLBACK - 1)}…`;
}

function defaultWarn(msg: string, err?: unknown): void {
  if (err === undefined) console.warn(msg);
  else console.warn(msg, err);
}

/**
 * Production `CommandsFs` implementation backed by the global ZenFS
 * VFS. Returns an empty `readdir` for missing paths so the loader can
 * treat "no `.pi/commands/` directory" the same as "directory is empty".
 */
export function createZenfsCommandsFs(): CommandsFs {
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
