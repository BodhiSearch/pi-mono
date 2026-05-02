/**
 * `/volume` user-facing surface.
 *
 * Subcommands:
 *   - `list` (default): show every currently mounted volume + its
 *     description (cwd, plus any `/volume add` mounts).
 *   - `add <path> [<mountName>]`: mount `<path>` at
 *     `/mnt/<mountName>` (or a sanitized basename of `<path>`),
 *     persist into sqlite kv so the mount comes back on relaunch,
 *     and emit a system message so the user sees the new mount.
 *   - `remove <mountName>`: unmount + drop the persisted entry.
 *
 * Multi-volume support unlocks vault command discovery scoped per
 * mount (`<mount>:<name>`) — see web-acp-agent's commands loader.
 *
 * The mounted file system uses `PassthroughFS` rooted at the host
 * path, so e.g. `/mnt/notes/foo.md` maps to `<path>/foo.md` for the
 * agent's bash + filesystem tools.
 */

import { existsSync, statSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import type { SlashCommand } from '../shell/registry';
import type { AppContext } from '../shell/context';
import { createPathVolumeInit } from '../services/volume-init';
import { KV_VOLUMES, type PersistedVolume } from '../storage/kv-keys';

export const volumeCommand: SlashCommand = {
  name: 'volume',
  description: 'Mount, unmount, and list filesystem volumes for vault commands.',
  usage: '/volume [list|add <path> [<mountName>]|remove <mountName>]',
  async handler(ctx, args) {
    const [sub, ...rest] = args;
    const action = (sub ?? 'list').toLowerCase();
    switch (action) {
      case 'list':
      case 'ls':
        return renderList(ctx);
      case 'add':
        return addVolume(ctx, rest[0], rest[1]);
      case 'remove':
      case 'rm':
        return removeVolume(ctx, rest[0]);
      default:
        ctx.renderer.emit({
          kind: 'error',
          text: `Unknown /volume action '${action}'. Try list|add|remove.`,
        });
    }
  },
};

function renderList(ctx: AppContext): void {
  const mounted = ctx.host.volumes.list();
  const persisted = ctx.host.kv.get<PersistedVolume[]>(KV_VOLUMES) ?? [];
  if (mounted.length === 0) {
    ctx.renderer.emit({ kind: 'info', text: 'No volumes mounted.' });
    return;
  }
  const lines: string[] = [`Volumes (${mounted.length}):`];
  for (const snap of mounted) {
    const persistedEntry = persisted.find(p => p.mountName === snap.mountName);
    const persistedSuffix = persistedEntry ? '' : ' (transient)';
    const descSuffix = snap.description ? `  ${snap.description}` : '';
    lines.push(`  /mnt/${snap.mountName}${persistedSuffix}${descSuffix}`);
  }
  ctx.renderer.emit({ kind: 'info', text: lines.join('\n') });
}

async function addVolume(
  ctx: AppContext,
  rawPath: string | undefined,
  rawMount: string | undefined
): Promise<void> {
  if (!rawPath) {
    ctx.renderer.emit({ kind: 'error', text: 'Usage: /volume add <path> [<mountName>]' });
    return;
  }
  const absPath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
  if (!existsSync(absPath)) {
    ctx.renderer.emit({ kind: 'error', text: `Path does not exist: ${absPath}` });
    return;
  }
  let isDir = false;
  try {
    isDir = statSync(absPath).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    ctx.renderer.emit({ kind: 'error', text: `Not a directory: ${absPath}` });
    return;
  }
  const mountName = sanitizeMountName(rawMount ?? basename(absPath));
  if (!mountName) {
    ctx.renderer.emit({
      kind: 'error',
      text: 'Mount name must contain at least one alphanumeric character.',
    });
    return;
  }

  const existingMounts = ctx.host.volumes.list();
  if (existingMounts.some(v => v.mountName === mountName)) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Mount '${mountName}' is already in use. Pick another with /volume add ${rawPath} <mountName>.`,
    });
    return;
  }

  const entry: PersistedVolume = { mountName, path: absPath };
  try {
    await ctx.host.volumes.mount(createPathVolumeInit(entry));
  } catch (err) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Mount failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const persisted = ctx.host.kv.get<PersistedVolume[]>(KV_VOLUMES) ?? [];
  if (!persisted.some(p => p.mountName === mountName)) {
    ctx.host.kv.set(KV_VOLUMES, [...persisted, entry]);
  }
  ctx.renderer.emit({
    kind: 'info',
    text: `Mounted ${absPath} at /mnt/${mountName}.`,
  });
}

async function removeVolume(ctx: AppContext, rawMount: string | undefined): Promise<void> {
  if (!rawMount) {
    ctx.renderer.emit({ kind: 'error', text: 'Usage: /volume remove <mountName>' });
    return;
  }
  const mountName = rawMount.replace(/^\/mnt\//, '');
  const mounted = ctx.host.volumes.list();
  if (!mounted.some(v => v.mountName === mountName)) {
    ctx.renderer.emit({ kind: 'info', text: `Not mounted: ${mountName}` });
    return;
  }
  try {
    await ctx.host.volumes.unmount(mountName);
  } catch (err) {
    ctx.renderer.emit({
      kind: 'error',
      text: `Unmount failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  const persisted = ctx.host.kv.get<PersistedVolume[]>(KV_VOLUMES) ?? [];
  const next = persisted.filter(p => p.mountName !== mountName);
  ctx.host.kv.set(KV_VOLUMES, next);
  ctx.renderer.emit({ kind: 'info', text: `Unmounted /mnt/${mountName}.` });
}

/**
 * ZenFS mount paths must look like an identifier, so reduce the
 * input to alphanumeric + dash + underscore. Empty result returns
 * an empty string so callers can warn the user.
 */
function sanitizeMountName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}
