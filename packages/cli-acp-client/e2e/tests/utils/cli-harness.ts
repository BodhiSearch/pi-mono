import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Lightweight harness that spawns the CLI in `--ci-line-mode --no-browser`
 * mode and exposes line-by-line stdout assertions. We deliberately avoid
 * node-pty here: the line-mode renderer emits one event per line, which is
 * sufficient for happy-path assertions and avoids the install pain of a
 * native PTY dependency.
 *
 * Each harness gets its own temp `cwd` so the per-cwd `.cli-acp-client/`
 * settings dir is isolated across tests. Tests that exercise the OAuth
 * flow pull the printed authorize URL out of stdout and hand it to a
 * Playwright page (see `auth-driver.ts`).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CliHarnessOptions {
  /** Extra args appended after `--ci-line-mode --no-browser`. */
  extraArgs?: string[];
  /** Override the working directory (defaults to a fresh temp dir). */
  cwd?: string;
  /** Environment overrides merged onto `process.env`. */
  env?: Record<string, string>;
  /** When true, mirror CLI stdout to the test runner stdout (debug only). */
  echo?: boolean;
}

export class CliHarness {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly buffer: string[] = [];
  private partial = '';
  private waiters: Array<{
    re: RegExp;
    resolve: (line: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  public readonly cwd: string;

  constructor(child: ChildProcessWithoutNullStreams, cwd: string, opts: CliHarnessOptions) {
    this.child = child;
    this.cwd = cwd;

    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => this.ingest(chunk, opts.echo));
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      // Surface stderr alongside stdout for diagnostics; don't block on it.
      if (opts.echo) process.stderr.write(`[cli stderr] ${chunk}`);
    });
    child.on('exit', code => {
      this.flushPartial();
      const err = new Error(`CLI exited (code=${code ?? 'null'}) before pattern matched`);
      for (const w of this.waiters) {
        clearTimeout(w.timer);
        w.reject(err);
      }
      this.waiters = [];
    });
  }

  static async start(opts: CliHarnessOptions = {}): Promise<CliHarness> {
    const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), 'cli-acp-client-e2e-'));
    // Resolve everything relative to the package root rather than the
    // (possibly bare) per-test cwd: `--import tsx` needs tsx visible in
    // the spawning process's `cwd/node_modules`. We then pass `--cwd
    // <isolated>` so the CLI's settings dir + auto-mounted volume use
    // the per-test temp directory.
    const packageRoot = resolve(__dirname, '../../..');
    const cliEntry = resolve(packageRoot, 'src/cli.ts');
    const args = [
      '--no-warnings',
      '--import',
      'tsx',
      cliEntry,
      '--ci-line-mode',
      '--no-browser',
      '--cwd',
      cwd,
      ...(opts.extraArgs ?? []),
    ];
    const child = spawn(process.execPath, args, {
      cwd: packageRoot,
      env: { ...process.env, ...opts.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const harness = new CliHarness(child, cwd, opts);
    return harness;
  }

  send(input: string): void {
    if (!this.child.stdin.writable) {
      throw new Error('CLI stdin is not writable');
    }
    this.child.stdin.write(`${input}\n`);
  }

  /**
   * Resolve as soon as a line matching `re` arrives. Already-buffered
   * lines count, so this is safe to call after the line was emitted.
   */
  waitFor(re: RegExp, timeoutMs = 30_000): Promise<string> {
    for (const line of this.buffer) {
      if (re.test(line)) return Promise.resolve(line);
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.timer !== timer);
        reject(
          new Error(
            `Timed out (${timeoutMs}ms) waiting for /${re.source}/. Last output:\n${this.tail(40)}`
          )
        );
      }, timeoutMs);
      this.waiters.push({ re, resolve, reject, timer });
    });
  }

  /**
   * Like {@link waitFor} but ignores already-buffered lines. Use when the
   * same pattern could legitimately match historical output from an
   * earlier test in a shared-harness suite (e.g. a `> ` prompt or a
   * common keyword like `Session`).
   */
  waitForFresh(re: RegExp, timeoutMs = 30_000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter(w => w.timer !== timer);
        reject(
          new Error(
            `Timed out (${timeoutMs}ms) waiting for /${re.source}/. Last output:\n${this.tail(40)}`
          )
        );
      }, timeoutMs);
      this.waiters.push({ re, resolve, reject, timer });
    });
  }

  /**
   * Wait for the CLI to stop emitting stdout for `quietMs` consecutive
   * milliseconds — i.e. the agent's turn is complete and `line-repl`
   * has re-issued its `> ` prompt prefix (which has no trailing
   * newline so we can't pattern-match it directly).
   *
   * We deliberately can't listen for the re-prompt as a buffered line:
   * `rl.prompt()` writes `> ` with no `\n`, so the harness's
   * line-splitting parser never flushes it. Stdout silence is the
   * next-best signal that the previous turn finished.
   */
  async waitForIdle(timeoutMs = 30_000, quietMs = 500): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const before = this.buffer.length;
      await delay(quietMs);
      if (this.buffer.length === before) return;
    }
    throw new Error(
      `Timed out (${timeoutMs}ms) waiting for idle prompt. Last output:\n${this.tail(40)}`
    );
  }

  /** Snapshot of the last `n` lines for diagnostics. */
  tail(n = 40): string {
    return this.buffer.slice(-n).join('\n');
  }

  /** Returns all lines captured so far (read-only copy). */
  lines(): string[] {
    return [...this.buffer];
  }

  /** Wait for the prompt line (`> ` or pi-tui editor cue) before sending. */
  async waitForPrompt(timeoutMs = 30_000): Promise<void> {
    await this.waitFor(/^>\s*$|prompt:/, timeoutMs);
  }

  async stop(timeoutMs = 5000): Promise<number | null> {
    if (this.child.exitCode !== null) return this.child.exitCode;
    if (this.child.stdin.writable) {
      try {
        this.child.stdin.end();
      } catch {
        // ignore
      }
    }
    const code = await Promise.race([
      new Promise<number | null>(resolve => this.child.once('exit', c => resolve(c ?? null))),
      delay(timeoutMs).then(() => null),
    ]);
    if (code === null) {
      this.child.kill('SIGKILL');
    }
    return code;
  }

  cleanup(): void {
    if (this.child.exitCode === null) {
      this.child.kill('SIGKILL');
    }
    if (this.cwd.startsWith(tmpdir())) {
      try {
        rmSync(this.cwd, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  }

  private ingest(chunk: string, echo?: boolean): void {
    const combined = this.partial + chunk;
    const segments = combined.split(/\r?\n/);
    this.partial = segments.pop() ?? '';
    for (const line of segments) {
      this.buffer.push(line);
      if (echo) process.stdout.write(`[cli] ${line}\n`);
      this.matchWaiters(line);
    }
  }

  private flushPartial(): void {
    if (!this.partial) return;
    this.buffer.push(this.partial);
    this.matchWaiters(this.partial);
    this.partial = '';
  }

  private matchWaiters(line: string): void {
    if (this.waiters.length === 0) return;
    const stillWaiting: typeof this.waiters = [];
    for (const w of this.waiters) {
      if (w.re.test(line)) {
        clearTimeout(w.timer);
        w.resolve(line);
      } else {
        stillWaiting.push(w);
      }
    }
    this.waiters = stillWaiting;
  }
}
