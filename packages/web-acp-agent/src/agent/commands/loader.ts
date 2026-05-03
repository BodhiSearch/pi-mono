/**
 * Discover vault-sourced markdown under each mount.
 *
 * `loadCommandsFromVolumes` scans `<mount>/.pi/commands/**\/*.md`;
 * `loadPromptsFromVolumes` scans `<mount>/.pi/prompts/**\/*.md`.
 * Both share `loadFromVolumes`: same front-matter parsing, same
 * `CommandDef[]` wire shape (`AvailableCommand` has no kind discriminator),
 * first-wins dedup within a single load. The agent merges command +
 * prompt lists in `refreshAvailableCommands`, with commands winning
 * on name collisions.
 *
 * Uses a narrow `CommandsFs` so tests can inject a fake FS; production
 * uses `createZenfsCommandsFs` as the only `@zenfs/core` touchpoint.
 */

import { fs as zenfs } from '@zenfs/core';
import { parseFrontMatter } from './front-matter';
import {
  COMMANDS_DIR_RELPATH,
  canonicalCommandName,
  InvalidCommandPathError,
  PROMPTS_DIR_RELPATH,
} from './path';
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
  return loadFromVolumes({ ...input, dirRelpath: COMMANDS_DIR_RELPATH, kind: 'commands' });
}

/**
 * Discover prompt templates under `<mount>/.pi/prompts/**\/*.md`.
 *
 * Same mechanics as `loadCommandsFromVolumes` (canonical names, front-matter,
 * `CommandDef` wire shape); differs only by directory and warning prefix
 * passed into `loadFromVolumes`.
 */
export async function loadPromptsFromVolumes(input: CommandsLoaderInput): Promise<CommandDef[]> {
  return loadFromVolumes({ ...input, dirRelpath: PROMPTS_DIR_RELPATH, kind: 'prompts' });
}

interface LoadFromVolumesInput extends CommandsLoaderInput {
  dirRelpath: string;
  /** Tag used in warning prefixes — `[commands]` vs `[prompts]`. */
  kind: 'commands' | 'prompts';
}

async function loadFromVolumes(input: LoadFromVolumesInput): Promise<CommandDef[]> {
  const warn = input.warn ?? defaultWarn;
  const seen = new Map<string, CommandDef>();
  const tag = `[${input.kind}]`;
  for (const mount of input.mounts) {
    const root = `/mnt/${mount.mountName}/${input.dirRelpath}`;
    const files = await collectMarkdownFiles(input.fs, root, '');
    files.sort((a, b) => a.localeCompare(b));
    for (const rel of files) {
      let name: string;
      try {
        name = canonicalCommandName({ mountName: mount.mountName, pathBelowCommands: rel });
      } catch (err) {
        if (err instanceof InvalidCommandPathError) {
          warn(
            `${tag} skipping '/mnt/${mount.mountName}/${input.dirRelpath}/${rel}': ${err.message}`
          );
          continue;
        }
        throw err;
      }
      if (seen.has(name)) {
        const existing = seen.get(name)!;
        warn(
          `${tag} duplicate '${name}' from /mnt/${mount.mountName}/${input.dirRelpath}/${rel} ` +
            `ignored (first registered from /mnt/${existing.source.mountName}/${existing.source.relPath})`
        );
        continue;
      }
      const absolute = `${root}/${rel}`;
      let raw: string;
      try {
        raw = await input.fs.readFile(absolute);
      } catch (err) {
        warn(`${tag} failed to read '${absolute}'`, err);
        continue;
      }
      let parsed: ReturnType<typeof parseFrontMatter>;
      try {
        parsed = parseFrontMatter(raw);
      } catch (err) {
        warn(`${tag} front-matter rejected for '${absolute}'`, err);
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
          relPath: `${input.dirRelpath}/${rel}`,
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
