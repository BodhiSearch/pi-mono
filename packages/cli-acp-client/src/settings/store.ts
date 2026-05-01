import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from './schema';

export const SETTINGS_DIR = '.cli-acp-client';
export const SETTINGS_FILE = 'settings.json';

export interface SettingsStore {
  readonly cwd: string;
  readonly path: string;
  load(): Promise<Settings>;
  save(next: Settings): Promise<void>;
  /**
   * Atomically merge a patch on top of the current persisted settings and
   * return the post-merge snapshot. The caller is responsible for any
   * higher-level invariants (e.g. dropping tokens when host changes).
   */
  patch(patch: Partial<Settings>): Promise<Settings>;
  /** Delete the settings file. Used by `/logout` clearing of tokens. */
  clear(): Promise<void>;
}

export function createSettingsStore(cwd: string): SettingsStore {
  const dir = path.join(cwd, SETTINGS_DIR);
  const file = path.join(dir, SETTINGS_FILE);

  async function load(): Promise<Settings> {
    try {
      const raw = await fs.readFile(file, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      const result = SettingsSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(
          `Invalid settings.json at ${file}: ${result.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`
        );
      }
      return result.data;
    } catch (err) {
      if (isNoEntryError(err)) {
        return { ...DEFAULT_SETTINGS };
      }
      throw err;
    }
  }

  async function save(next: Settings): Promise<void> {
    await fs.mkdir(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    const body = JSON.stringify(SettingsSchema.parse(next), null, 2);
    await fs.writeFile(tmp, `${body}\n`, 'utf-8');
    await fs.rename(tmp, file);
  }

  async function patch(p: Partial<Settings>): Promise<Settings> {
    const current = await load();
    const next: Settings = { ...current, ...p };
    await save(next);
    return next;
  }

  async function clear(): Promise<void> {
    try {
      await fs.unlink(file);
    } catch (err) {
      if (!isNoEntryError(err)) throw err;
    }
  }

  return { cwd, path: file, load, save, patch, clear };
}

function isNoEntryError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: string }).code === 'ENOENT'
  );
}
