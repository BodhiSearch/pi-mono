import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createConnection } from 'net';
import { createRequire } from 'node:module';

/**
 * EverythingMcpManager — spawns `@modelcontextprotocol/server-everything`
 * over Streamable HTTP on a fixed port for the duration of the e2e run.
 *
 * BodhiApp uses the same reference MCP server for its own MCP e2e
 * coverage (see `BodhiApp/crates/lib_bodhiserver/package.json` →
 * `e2e:server:everything-mcp` + `crates/lib_bodhiserver/playwright.config.mjs`
 * webServer entry). We need our own manager here because the web-acp
 * Playwright suite owns its own BodhiApp server and cannot rely on a
 * separately-configured `webServer` block to juggle process lifetime
 * across platforms.
 */

export const EVERYTHING_MCP_PORT = 51136;
export const EVERYTHING_MCP_URL = `http://localhost:${EVERYTHING_MCP_PORT}/mcp`;

export interface EverythingMcpManagerConfig {
  port?: number;
  readyTimeoutMs?: number;
  logToStdout?: boolean;
}

export class EverythingMcpManager {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private readonly port: number;
  private readonly readyTimeoutMs: number;
  private readonly logToStdout: boolean;

  constructor(config: EverythingMcpManagerConfig = {}) {
    this.port = config.port ?? EVERYTHING_MCP_PORT;
    this.readyTimeoutMs = config.readyTimeoutMs ?? 30_000;
    this.logToStdout = config.logToStdout ?? false;
  }

  getUrl(): string {
    return `http://localhost:${this.port}/mcp`;
  }

  async start(): Promise<string> {
    if (this.proc) {
      throw new Error('everything-mcp server is already running');
    }

    if (await isPortInUse(this.port)) {
      throw new Error(
        `Port ${this.port} is already in use. Stop the process running on port ${this.port} before starting the everything-mcp fixture.`
      );
    }

    // Resolve the package's dist entry directly so we bypass any npx
    // cache / network lookups (`@modelcontextprotocol/server-everything`
    // is already installed as a devDependency of `web-acp`). The `bin`
    // entry is `mcp-server-everything` → `dist/index.js`, which accepts
    // `stdio|sse|streamableHttp` as argv[0].
    const require = createRequire(import.meta.url);
    const entryPath = require.resolve('@modelcontextprotocol/server-everything/dist/index.js');

    this.proc = spawn(process.execPath, [entryPath, 'streamableHttp'], {
      env: { ...process.env, PORT: String(this.port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    if (this.logToStdout) {
      this.proc.stdout.on('data', chunk => process.stdout.write(`[everything-mcp] ${chunk}`));
      this.proc.stderr.on('data', chunk => process.stderr.write(`[everything-mcp:err] ${chunk}`));
    } else {
      // Drain the streams so the child doesn't block on stdout/stderr
      // back-pressure when we're not piping them to a parent stream.
      this.proc.stdout.on('data', () => undefined);
      this.proc.stderr.on('data', () => undefined);
    }

    const exitPromise = new Promise<never>((_, reject) => {
      this.proc!.once('exit', (code, signal) => {
        this.proc = null;
        reject(
          new Error(
            `everything-mcp server exited before becoming ready (code=${code}, signal=${signal})`
          )
        );
      });
    });

    await Promise.race([this.waitForReady(), exitPromise]);
    console.log(`[everything-mcp] Ready at ${this.getUrl()}`);
    return this.getUrl();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    this.proc = null;
    // The child process tree includes `npx` → `node` → the actual server.
    // Killing `npx` with SIGTERM reliably tears the tree down on macOS /
    // Linux CI runners; we fall back to SIGKILL if it doesn't exit
    // promptly.
    // Spawning node directly (see `start()`) means the PID *is* the
    // server process — no shell or `npx` wrapper in between — so a
    // SIGTERM reliably tears it down on macOS and Linux CI runners.
    // We still fall through to SIGKILL after 2s if the child refuses
    // to exit (e.g. in-flight Express handlers holding the event loop
    // open).
    proc.kill('SIGTERM');
    await new Promise<void>(resolve => {
      const killTimer = setTimeout(() => {
        try {
          proc.kill('SIGKILL');
        } catch {
          /* already dead */
        }
      }, 2_000);
      proc.once('exit', () => {
        clearTimeout(killTimer);
        resolve();
      });
    });
  }

  private async waitForReady(): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < this.readyTimeoutMs) {
      if (await isPortInUse(this.port)) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(
      `everything-mcp server did not open port ${this.port} within ${this.readyTimeoutMs}ms`
    );
  }
}

function isPortInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ port, host: 'localhost' });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });
}
