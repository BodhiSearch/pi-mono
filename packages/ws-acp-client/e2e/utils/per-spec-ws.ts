/**
 * Helper to spin up a per-spec ws-acp-client process so each spec starts
 * with a clean sqlite. Required because the Phase 6 switch to
 * agent-driven session listing means session rows persist across tests
 * if they share a single ws-acp-client (the suite's `globalSetup` boots
 * one for the simpler specs that don't care about isolation).
 *
 * Usage from a spec:
 *
 *   const fresh = createPerSpecWsServer();
 *   test.beforeAll(async () => { await fresh.start(); });
 *   test.afterAll(async () => { await fresh.stop(); });
 *   test('...', async ({ page }) => {
 *     // fresh.url, fresh.cwd are valid here
 *   });
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startWsAcpServer,
  type WsServerHandle,
  type WsServerVolume,
} from './ws-server-manager';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PKG_DIR = path.resolve(__dirname, '..', '..');

export interface PerSpecWs {
  /** Resolved ws://host:port — only valid after `start()` resolves. */
  readonly url: string;
  /** Resolved cwd backing /mnt/cwd. */
  readonly cwd: string;
  /** Volumes echoed back from the spawned server. */
  readonly volumes: WsServerVolume[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface PerSpecWsOptions {
  /** Extra `--volume name=path` flags to pass through. */
  volumes?: WsServerVolume[];
}

export function createPerSpecWsServer(opts: PerSpecWsOptions = {}): PerSpecWs {
  let handle: WsServerHandle | null = null;

  const obj: PerSpecWs = {
    get url(): string {
      if (!handle) throw new Error('PerSpecWs.url accessed before start()');
      return handle.url;
    },
    get cwd(): string {
      if (!handle) throw new Error('PerSpecWs.cwd accessed before start()');
      return handle.cwd;
    },
    get volumes(): WsServerVolume[] {
      if (!handle) throw new Error('PerSpecWs.volumes accessed before start()');
      return handle.volumes;
    },
    async start(): Promise<void> {
      if (handle) return;
      // Let `startWsAcpServer` mkdtemp the cwd (and own its cleanup) so
      // we don't double-rm on stop.
      handle = await startWsAcpServer({
        packageDir: PKG_DIR,
        port: 0,
        host: '127.0.0.1',
        verbose: false,
        volumes: opts.volumes,
      });
    },
    async stop(): Promise<void> {
      if (handle) {
        try {
          await handle.stop();
        } catch (e) {
          console.warn('[PerSpecWs] stop() failed:', e);
        }
        handle = null;
      }
    },
  };
  return obj;
}
