/**
 * Main-thread ZenFS proxy.
 *
 * After M4 the real ZenFS backend (WebAccess wrapping the FSA handle, or
 * InMemory for the dev seed) lives inside the agent Worker. This module
 * mounts a `Port` backend at `/vault` so every `fs.promises.*` call from
 * UI consumers (FileTree poll, FileViewer, MarkdownEditor) auto-marshals
 * over a MessageChannel to the Worker's real backend.
 *
 * The Worker side handles the actual handle/seed lifecycle — see
 * `src/web-agent/worker/worker-host.ts`.
 */

import { configure, fs, Port, vfs } from '@zenfs/core';

export { fs };

// ZenFS's port option type unions WebSocket which makes structural matching
// against the browser MessagePort fail; cast at the call site.
type ZenfsPortOpt = Parameters<typeof Port.create>[0]['port'];

export const VAULT_MOUNT = '/vault';

let mountedPort: MessagePort | null = null;
let mountPromise: Promise<void> | null = null;

/**
 * Mount the ZenFS Port backend at `/vault` pointing at the Worker's VFS
 * port. Idempotent — mounting the same port twice is a no-op; mounting
 * a different port detaches the previous mount first.
 *
 * `port` must be a MessagePort whose other end is held by the Worker and
 * has had a real backend `attachFS`'d to it. PortFS waits for the remote
 * to respond to `ready` before resolving.
 */
export async function mountVaultPort(port: MessagePort): Promise<void> {
  if (mountedPort === port && mountPromise) {
    await mountPromise;
    return;
  }
  if (mountedPort && mountedPort !== port) {
    try {
      vfs.umount(VAULT_MOUNT);
    } catch {
      // best-effort
    }
    mountedPort = null;
    mountPromise = null;
  }
  mountedPort = port;
  // Both ends of the channel use addEventListener-based listeners (via
  // ZenFS RPC.from) which require explicit start(). Worker side does its
  // own start() in agent-worker.ts.
  port.start();
  mountPromise = (async () => {
    await configure({ mounts: {} });
    const portFs = await Port.create({
      port: port as unknown as ZenfsPortOpt,
      // 250ms default trips on first ready() round-trip when the worker is
      // still spinning up — bump to a value that's still snappy.
      timeout: 5_000,
    });
    vfs.mount(VAULT_MOUNT, portFs);
    await portFs.ready();
  })();
  await mountPromise;
}

export function isVaultMounted(): boolean {
  return mountedPort !== null;
}

export async function unmountVault(): Promise<void> {
  if (!mountedPort) return;
  try {
    vfs.umount(VAULT_MOUNT);
  } catch {
    // best-effort
  }
  mountedPort = null;
  mountPromise = null;
}
