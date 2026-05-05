/**
 * Behavioural tests for `/volume list|add|remove`.
 *
 * The command performs three distinct kinds of work that we want to
 * lock down independently:
 *   1. host filesystem validation (path exists + isDirectory),
 *   2. ZenFS mount via the agent's VolumeRegistry,
 *   3. sqlite kv persistence (so mounts come back on relaunch).
 *
 * We stub out (2) with a tiny in-memory registry so we never touch
 * real ZenFS. (1) runs against a real tmp dir so we exercise the
 * actual fs branches the user hits. (3) is asserted directly on the
 * mock kv map.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { volumeCommand } from './volume';
import { KV_VOLUMES, type PersistedVolume } from '../storage/kv-keys';
import type { AppContext } from '../shell/context';
import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from '../shell/types';
import type { VolumeInit, VolumeRegistry, VolumeSnapshot } from '@bodhiapp/web-acp-agent';

class FakeVolumeRegistry implements VolumeRegistry {
  snapshots = new Map<string, VolumeSnapshot>();

  async mountAll(initial: VolumeInit[]): Promise<void> {
    for (const init of initial) await this.mount(init);
  }
  async mount(init: VolumeInit): Promise<void> {
    if (this.snapshots.has(init.mountName)) {
      throw new Error(`already mounted: ${init.mountName}`);
    }
    this.snapshots.set(init.mountName, {
      mountName: init.mountName,
      description: init.description,
      tags: init.tags ? [...init.tags] : [],
    });
  }
  async unmount(mountName: string): Promise<void> {
    if (!this.snapshots.delete(mountName)) {
      throw new Error(`not mounted: ${mountName}`);
    }
  }
  list(): VolumeSnapshot[] {
    return [...this.snapshots.values()];
  }
  firstMountName(): string | undefined {
    return this.snapshots.keys().next().value;
  }
  findByTag(tag: string): VolumeSnapshot | undefined {
    for (const snap of this.snapshots.values()) {
      if (snap.tags.includes(tag)) return snap;
    }
    return undefined;
  }
  onChange(): () => void {
    return () => {};
  }
}

interface MemKv {
  store: Map<string, unknown>;
  get<T>(k: string): T | undefined;
  set<T>(k: string, v: T): void;
  delete(k: string): void;
}

function makeKv(seed: Record<string, unknown> = {}): MemKv {
  const store = new Map<string, unknown>(Object.entries(seed));
  return {
    store,
    get: <T>(k: string) => store.get(k) as T | undefined,
    set: <T>(k: string, v: T) => {
      store.set(k, v);
    },
    delete: (k: string) => {
      store.delete(k);
    },
  };
}

function makeCtx(opts: { volumes: VolumeRegistry; kv: MemKv; cwd: string }): {
  ctx: AppContext;
  messages: ShellMessage[];
} {
  const messages: ShellMessage[] = [];
  const renderer: Renderer = {
    emit: m => {
      messages.push(m);
    },
    setStatus: (_s: ConnectionStatus) => {},
    renderHelp: (_c: SlashCommandSummary[]) => {},
  };
  const ctx: AppContext = {
    settings: {} as AppContext['settings'],
    host: {
      volumes: opts.volumes,
      kv: opts.kv,
    } as unknown as AppContext['host'],
    client: {} as AppContext['client'],
    renderer,
    opener: {} as AppContext['opener'],
    cwd: opts.cwd,
    stream: {} as AppContext['stream'],
    sessionId: null,
    modelId: null,
    status: { kind: 'disconnected' as const },
    tokens: null,
    composedMcpServers: [],
    mcpInstances: [],
    requestedMcps: [],
    isDev: true,
  };
  return { ctx, messages };
}

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cli-acp-vol-'));
});

afterEach(() => {
  if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

async function run(ctx: AppContext, ...args: string[]) {
  // SlashCommand handler signature: (ctx, args) → Promise<void>
  await volumeCommand.handler!(ctx, args);
}

describe('volume / list', () => {
  it('reports "No volumes mounted." when registry is empty', async () => {
    const { ctx, messages } = makeCtx({
      volumes: new FakeVolumeRegistry(),
      kv: makeKv(),
      cwd: tmpRoot,
    });
    await run(ctx, 'list');
    expect(messages).toHaveLength(1);
    expect(messages[0].text).toMatch(/No volumes mounted/);
  });

  it('lists mounted volumes with /mnt/ prefix and a (transient) badge for unpersisted entries', async () => {
    const reg = new FakeVolumeRegistry();
    reg.snapshots.set('cwd', {
      mountName: 'cwd',
      description: 'Mounted directory: ' + tmpRoot,
      tags: [],
    });
    reg.snapshots.set('temp', { mountName: 'temp', tags: [] });
    // Persist only `cwd`.
    const { ctx, messages } = makeCtx({
      volumes: reg,
      kv: makeKv({
        [KV_VOLUMES]: [{ mountName: 'cwd', path: tmpRoot } satisfies PersistedVolume],
      }),
      cwd: tmpRoot,
    });
    await run(ctx);
    expect(messages).toHaveLength(1);
    const text = messages[0].text!;
    expect(text).toMatch(/Volumes \(2\):/);
    expect(text).toMatch(/\/mnt\/cwd/);
    expect(text).toMatch(/\/mnt\/temp/);
    expect(text).toMatch(/\(transient\)/);
  });

  it('treats an unknown subcommand as an error', async () => {
    const { ctx, messages } = makeCtx({
      volumes: new FakeVolumeRegistry(),
      kv: makeKv(),
      cwd: tmpRoot,
    });
    await run(ctx, 'whoops');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Unknown \/volume action/);
  });
});

describe('volume / add', () => {
  it('rejects missing path with usage hint', async () => {
    const { ctx, messages } = makeCtx({
      volumes: new FakeVolumeRegistry(),
      kv: makeKv(),
      cwd: tmpRoot,
    });
    await run(ctx, 'add');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/volume add/);
  });

  it.each([
    ['nonexistent dir', './does-not-exist', /Path does not exist/],
    ['regular file', null, /Not a directory/],
  ])('rejects %s', async (_label, providedPath, expected) => {
    const { ctx, messages } = makeCtx({
      volumes: new FakeVolumeRegistry(),
      kv: makeKv(),
      cwd: tmpRoot,
    });
    let target: string;
    if (providedPath === null) {
      target = join(tmpRoot, 'a-file.txt');
      writeFileSync(target, 'hi');
    } else {
      target = providedPath;
    }
    await run(ctx, 'add', target);
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(expected);
  });

  it('mounts the directory and persists to kv (sanitized basename as default mount name)', async () => {
    const dir = join(tmpRoot, 'My Notes!');
    mkdirSync(dir);
    const reg = new FakeVolumeRegistry();
    const kv = makeKv();
    const { ctx, messages } = makeCtx({ volumes: reg, kv, cwd: tmpRoot });
    await run(ctx, 'add', dir);
    expect(reg.snapshots.has('my-notes')).toBe(true);
    const persisted = kv.get<PersistedVolume[]>(KV_VOLUMES);
    expect(persisted).toEqual([{ mountName: 'my-notes', path: dir }]);
    expect(messages.at(-1)?.text).toMatch(/Mounted .* at \/mnt\/my-notes/);
  });

  it('rejects an already-used mount name', async () => {
    const dir = join(tmpRoot, 'notes');
    mkdirSync(dir);
    const reg = new FakeVolumeRegistry();
    reg.snapshots.set('notes', { mountName: 'notes', tags: [] });
    const { ctx, messages } = makeCtx({
      volumes: reg,
      kv: makeKv(),
      cwd: tmpRoot,
    });
    await run(ctx, 'add', dir);
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/already in use/);
  });

  it('rejects a mount name that sanitizes to empty', async () => {
    const dir = join(tmpRoot, 'inner');
    mkdirSync(dir);
    const { ctx, messages } = makeCtx({
      volumes: new FakeVolumeRegistry(),
      kv: makeKv(),
      cwd: tmpRoot,
    });
    await run(ctx, 'add', dir, '!!!');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/at least one alphanumeric/);
  });

  it('uses an explicit mountName when provided', async () => {
    const dir = join(tmpRoot, 'inner');
    mkdirSync(dir);
    const reg = new FakeVolumeRegistry();
    const kv = makeKv();
    const { ctx } = makeCtx({ volumes: reg, kv, cwd: tmpRoot });
    await run(ctx, 'add', dir, 'custom');
    expect(reg.snapshots.has('custom')).toBe(true);
    expect(kv.get<PersistedVolume[]>(KV_VOLUMES)).toEqual([{ mountName: 'custom', path: dir }]);
  });

  it('resolves a relative path against ctx.cwd', async () => {
    const dir = join(tmpRoot, 'rel');
    mkdirSync(dir);
    const reg = new FakeVolumeRegistry();
    const kv = makeKv();
    const { ctx } = makeCtx({ volumes: reg, kv, cwd: tmpRoot });
    await run(ctx, 'add', './rel');
    expect(reg.snapshots.has('rel')).toBe(true);
    expect(kv.get<PersistedVolume[]>(KV_VOLUMES)![0].path).toBe(dir);
  });
});

describe('volume / remove', () => {
  it('rejects missing mount name with usage hint', async () => {
    const { ctx, messages } = makeCtx({
      volumes: new FakeVolumeRegistry(),
      kv: makeKv(),
      cwd: tmpRoot,
    });
    await run(ctx, 'remove');
    expect(messages.at(-1)?.kind).toBe('error');
    expect(messages.at(-1)?.text).toMatch(/Usage: \/volume remove/);
  });

  it('returns "Not mounted" for unknown mount', async () => {
    const { ctx, messages } = makeCtx({
      volumes: new FakeVolumeRegistry(),
      kv: makeKv(),
      cwd: tmpRoot,
    });
    await run(ctx, 'remove', 'unknown');
    expect(messages.at(-1)?.kind).toBe('info');
    expect(messages.at(-1)?.text).toMatch(/Not mounted/);
  });

  it('unmounts and drops kv entry; tolerates a /mnt/ prefix', async () => {
    const reg = new FakeVolumeRegistry();
    reg.snapshots.set('notes', { mountName: 'notes', tags: [] });
    const kv = makeKv({
      [KV_VOLUMES]: [
        { mountName: 'notes', path: '/tmp/notes' } satisfies PersistedVolume,
        { mountName: 'cwd', path: '/tmp' } satisfies PersistedVolume,
      ],
    });
    const { ctx, messages } = makeCtx({ volumes: reg, kv, cwd: tmpRoot });
    await run(ctx, 'remove', '/mnt/notes');
    expect(reg.snapshots.has('notes')).toBe(false);
    expect(kv.get<PersistedVolume[]>(KV_VOLUMES)).toEqual([{ mountName: 'cwd', path: '/tmp' }]);
    expect(messages.at(-1)?.text).toMatch(/Unmounted \/mnt\/notes/);
  });
});
