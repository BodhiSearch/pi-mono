import { describe, expect, test } from 'vitest';
import { resolveVaultPath, VaultPathError } from './path-utils';

describe('resolveVaultPath', () => {
  test('resolves absolute vault path', () => {
    const r = resolveVaultPath('/vault/src/a.ts');
    expect(r.absolute).toBe('/vault/src/a.ts');
    expect(r.relative).toBe('src/a.ts');
  });

  test('resolves relative path against default cwd', () => {
    const r = resolveVaultPath('src/a.ts');
    expect(r.absolute).toBe('/vault/src/a.ts');
    expect(r.relative).toBe('src/a.ts');
  });

  test('resolves "./" prefix', () => {
    const r = resolveVaultPath('./src/a.ts');
    expect(r.absolute).toBe('/vault/src/a.ts');
  });

  test('resolves vault root', () => {
    const r = resolveVaultPath('/vault');
    expect(r.absolute).toBe('/vault');
    expect(r.relative).toBe('');
  });

  test('resolves empty relative path to cwd', () => {
    const r = resolveVaultPath('.');
    expect(r.absolute).toBe('/vault');
  });

  test('collapses internal .. that stays within vault', () => {
    const r = resolveVaultPath('/vault/a/../b.ts');
    expect(r.absolute).toBe('/vault/b.ts');
  });

  test('rejects path escaping the vault with ..', () => {
    expect(() => resolveVaultPath('../etc/passwd')).toThrow(VaultPathError);
  });

  test('rejects absolute path outside vault', () => {
    expect(() => resolveVaultPath('/etc/passwd')).toThrow(VaultPathError);
  });

  test('rejects /vault/.. escape', () => {
    expect(() => resolveVaultPath('/vault/../etc')).toThrow(VaultPathError);
  });

  test('rejects root /', () => {
    expect(() => resolveVaultPath('/')).toThrow(VaultPathError);
  });

  test('rejects non-string input', () => {
    expect(() => resolveVaultPath(null as unknown as string)).toThrow(VaultPathError);
  });

  test('respects custom cwd inside vault', () => {
    const r = resolveVaultPath('a.ts', '/vault/sub');
    expect(r.absolute).toBe('/vault/sub/a.ts');
  });
});
