import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { createConnection } from 'net';
import { createRequire } from 'node:module';

/**
 * EverythingMcpManager — spawns `@modelcontextprotocol/server-everything`
 * over Streamable HTTP on a fixed port for the duration of an e2e run.
 *
 * Mirrors `packages/web-acp/e2e/tests/utils/everything-mcp-manager.ts` —
 * BodhiApp uses the same reference MCP server in its own e2e coverage,
 * and the ws-acp-client suite consumes it via the agent's MCP wiring
 * after `/mcp add <url>` re-authenticates with the new scope.
 */

export const EVERYTHING_MCP_PORT = 51137;
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
    // cache / network lookup. The `bin` entry is `mcp-server-everything`
    // → `dist/index.js`, which accepts `stdio|sse|streamableHttp` as argv[0].
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
