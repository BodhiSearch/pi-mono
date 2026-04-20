/**
 * Contract tests for the ZenFS-backed vault operations.
 *
 * Mounts an `InMemory` backend at `/vault` in the shared ZenFS VFS, runs
 * each adapter against seeded files, and asserts the contract the vault
 * tools depend on (byte reads, text reads, stat + readdir normalisation,
 * mkdir / writeFile / access semantics).
 */

import { InMemory, fs, vfs } from '@zenfs/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { createZenfsVaultOperations } from './zenfs-operations';

const MOUNT = '/vault';

beforeEach(async () => {
  try {
    vfs.umount(MOUNT);
  } catch {
    // not mounted yet
  }
  vfs.mount(MOUNT, InMemory.create({ label: 'zenfs-ops-test' }));
  await fs.promises.writeFile(`${MOUNT}/hello.txt`, 'hello world', { encoding: 'utf8' });
  await fs.promises.mkdir(`${MOUNT}/docs`, { recursive: true });
  await fs.promises.writeFile(`${MOUNT}/docs/a.md`, '# doc\nbody', { encoding: 'utf8' });
});

afterEach(() => {
  try {
    vfs.umount(MOUNT);
  } catch {
    // ignore
  }
});

describe('ReadOperations', () => {
  test('readFile returns Uint8Array of file bytes', async () => {
    const ops = createZenfsVaultOperations();
    const bytes = await ops.read.readFile(`${MOUNT}/hello.txt`);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(bytes)).toBe('hello world');
  });

  test('access resolves for existing path, rejects for missing', async () => {
    const ops = createZenfsVaultOperations();
    await expect(ops.read.access(`${MOUNT}/hello.txt`)).resolves.toBeUndefined();
    await expect(ops.read.access(`${MOUNT}/missing.txt`)).rejects.toThrow();
  });
});

describe('WriteOperations', () => {
  test('writeFile creates new file with the given content', async () => {
    const ops = createZenfsVaultOperations();
    await ops.write.writeFile(`${MOUNT}/new.txt`, 'hi');
    const read = (await fs.promises.readFile(`${MOUNT}/new.txt`, { encoding: 'utf8' })) as string;
    expect(read).toBe('hi');
  });

  test('writeFile overwrites existing file', async () => {
    const ops = createZenfsVaultOperations();
    await ops.write.writeFile(`${MOUNT}/hello.txt`, 'replaced');
    const read = (await fs.promises.readFile(`${MOUNT}/hello.txt`, { encoding: 'utf8' })) as string;
    expect(read).toBe('replaced');
  });

  test('mkdir creates nested directories recursively', async () => {
    const ops = createZenfsVaultOperations();
    await ops.write.mkdir(`${MOUNT}/a/b/c`);
    const stat = await fs.promises.stat(`${MOUNT}/a/b/c`);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('EditOperations', () => {
  test('readFile → writeFile round-trip preserves content', async () => {
    const ops = createZenfsVaultOperations();
    const bytes = await ops.edit.readFile(`${MOUNT}/hello.txt`);
    const text = new TextDecoder().decode(bytes);
    await ops.edit.writeFile(`${MOUNT}/hello.txt`, text.toUpperCase());
    const read = (await fs.promises.readFile(`${MOUNT}/hello.txt`, { encoding: 'utf8' })) as string;
    expect(read).toBe('HELLO WORLD');
  });
});

describe('LsOperations', () => {
  test('stat normalises isDirectory / isFile methods', async () => {
    const ops = createZenfsVaultOperations();
    const fileStat = await ops.ls.stat(`${MOUNT}/hello.txt`);
    expect(fileStat.isFile()).toBe(true);
    expect(fileStat.isDirectory()).toBe(false);
    const dirStat = await ops.ls.stat(`${MOUNT}/docs`);
    expect(dirStat.isDirectory()).toBe(true);
    expect(dirStat.isFile()).toBe(false);
  });

  test('readdir returns string entries', async () => {
    const ops = createZenfsVaultOperations();
    const entries = await ops.ls.readdir(MOUNT);
    expect(entries.sort()).toEqual(['docs', 'hello.txt']);
    for (const e of entries) expect(typeof e).toBe('string');
  });
});

describe('GlobOperations', () => {
  test('shares the same stat/readdir semantics as ls', async () => {
    const ops = createZenfsVaultOperations();
    const entries = await ops.glob.readdir(`${MOUNT}/docs`);
    expect(entries).toEqual(['a.md']);
    const stat = await ops.glob.stat(`${MOUNT}/docs/a.md`);
    expect(stat.isFile()).toBe(true);
  });
});

describe('GrepOperations', () => {
  test('readFile returns decoded string content', async () => {
    const ops = createZenfsVaultOperations();
    const text = await ops.grep.readFile(`${MOUNT}/docs/a.md`);
    expect(text).toBe('# doc\nbody');
  });
});
