/**
 * Spawns the `ws-acp-client` CLI as a child process for e2e tests.
 *
 * Mirrors the shape of `BodhiServerManager` — `start()` waits until
 * the child prints its `ready: ws://host:port` line and resolves the
 * resolved URL. `stop()` is idempotent.
 *
 * `cwd` is the working directory the agent is rooted at via
 * `PassthroughFS`; we point it at a unique temp dir so each suite
 * sees a fresh `.ws-acp-client/state.db`.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface WsServerOptions {
  /** Path to the ws-acp-client package root. */
  packageDir: string;
  /** Override the agent's cwd. Defaults to a fresh mkdtemp. */
  cwd?: string;
  /** Listen port. 0 picks an ephemeral port. */
  port?: number;
  /** Bind host (default 127.0.0.1). */
  host?: string;
  /** Forward child stdout/stderr to the parent. */
  verbose?: boolean;
  /** Max ms to wait for the ready line before failing. */
  startupTimeoutMs?: number;
}

export interface WsServerHandle {
  /** Resolved listen URL (e.g. `ws://127.0.0.1:54321`). */
  url: string;
  /** Resolved working directory (the temp dir if mkdtemp'd). */
  cwd: string;
  /** Stop the child process and remove the mkdtemp'd cwd. */
  stop(): Promise<void>;
}

const READY_PATTERN = /ready:\s*(ws:\/\/[^\s]+)/;

export async function startWsAcpServer(opts: WsServerOptions): Promise<WsServerHandle> {
  const port = opts.port ?? 0;
  const host = opts.host ?? '127.0.0.1';
  const startupTimeoutMs = opts.startupTimeoutMs ?? 15_000;
  const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'ws-acp-e2e-'));
  const ownsCwd = !opts.cwd;

  const args = [
    'src/cli.ts',
    '--port',
    String(port),
    '--bind',
    host,
    '--cwd',
    cwd,
  ];

  const child: ChildProcess = spawn('npx', ['tsx', ...args], {
    cwd: opts.packageDir,
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let url: string | undefined;
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const onStdout = (data: Buffer): void => {
    const text = data.toString('utf-8');
    stdoutChunks.push(text);
    if (opts.verbose) process.stdout.write(`[ws-acp-client] ${text}`);
    if (!url) {
      const match = text.match(READY_PATTERN);
      if (match && match[1]) url = match[1];
    }
  };
  const onStderr = (data: Buffer): void => {
    const text = data.toString('utf-8');
    stderrChunks.push(text);
    if (opts.verbose) process.stderr.write(`[ws-acp-client] ${text}`);
  };

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      // Give the child a moment to flush + exit; force-kill if it hangs.
      await new Promise<void>(resolve => {
        const t = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 2_000);
        child.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    if (ownsCwd) {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `ws-acp-client did not report ready within ${startupTimeoutMs}ms.\nSTDOUT:\n${stdoutChunks.join('')}\nSTDERR:\n${stderrChunks.join('')}`
          )
        );
      }, startupTimeoutMs);
      const tick = setInterval(() => {
        if (url) {
          clearInterval(tick);
          clearTimeout(deadline);
          resolve();
        }
      }, 50);
      child.once('exit', code => {
        if (!url) {
          clearInterval(tick);
          clearTimeout(deadline);
          reject(
            new Error(
              `ws-acp-client exited (code=${code}) before reporting ready.\nSTDOUT:\n${stdoutChunks.join('')}\nSTDERR:\n${stderrChunks.join('')}`
            )
          );
        }
      });
    });
  } catch (err) {
    await stop();
    throw err;
  }

  if (!url) {
    await stop();
    throw new Error('ws-acp-client: ready URL not captured');
  }

  return { url, cwd, stop };
}
