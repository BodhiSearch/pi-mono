/**
 * Zenfs provider — main-thread Port backend lifecycle.
 *
 * We exercise the public surface (`mountVaultPort`, `unmountVault`,
 * `isVaultMounted`) by pairing a MessageChannel locally with an InMemory
 * backend attached on one end, and driving Port.create on the other.
 * The full Worker boot is covered by Playwright; this spec locks in the
 * idempotency guarantees of the in-flight promise guard.
 */

import { attachFS, InMemory } from '@zenfs/core';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { isVaultMounted, mountVaultPort, unmountVault } from './zenfs-provider';

type ZenfsChannel = Parameters<typeof attachFS>[0];

function pairWithFakeBackend() {
  const channel = new MessageChannel();
  const backend = InMemory.create({ label: 'zenfs-provider-test' });
  attachFS(channel.port2 as unknown as ZenfsChannel, backend);
  channel.port2.start();
  return { main: channel.port1, worker: channel.port2 };
}

beforeEach(async () => {
  await unmountVault();
});

afterEach(async () => {
  await unmountVault();
});

describe('zenfs-provider lifecycle', () => {
  test('isVaultMounted is false before any mount', () => {
    expect(isVaultMounted()).toBe(false);
  });

  test('unmountVault is a no-op when nothing is mounted', async () => {
    await expect(unmountVault()).resolves.toBeUndefined();
    expect(isVaultMounted()).toBe(false);
  });

  test('mountVaultPort attaches and flips isVaultMounted', async () => {
    const { main } = pairWithFakeBackend();
    await mountVaultPort(main);
    expect(isVaultMounted()).toBe(true);
  });

  test('mountVaultPort is idempotent for the same port — no double mount', async () => {
    const { main } = pairWithFakeBackend();
    const a = mountVaultPort(main);
    const b = mountVaultPort(main);
    await Promise.all([a, b]);
    expect(isVaultMounted()).toBe(true);
    // unmount once — state should be clean
    await unmountVault();
    expect(isVaultMounted()).toBe(false);
  });

  test('mountVaultPort swaps when given a different port', async () => {
    const first = pairWithFakeBackend();
    await mountVaultPort(first.main);
    expect(isVaultMounted()).toBe(true);

    const second = pairWithFakeBackend();
    await mountVaultPort(second.main);
    expect(isVaultMounted()).toBe(true);

    await unmountVault();
    expect(isVaultMounted()).toBe(false);
  });
});
