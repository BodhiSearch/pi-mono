/**
 * Subprocess harness that spawns the tutorial CLI in --test mode and parses
 * its JSON-line output. Each emit becomes one parsed event with `text` plus
 * any structured extras (e.g. `login_url`).
 *
 * Each harness gets its own temp cwd so `.tutorial-cli-client/tokens.json`
 * is isolated across runs.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface CliHarnessOptions {
	bodhiUrl: string;
	cwd?: string;
	echo?: boolean;
}

export interface JsonLineEvent {
	text: string;
	[key: string]: unknown;
}

export class CliHarness {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly events: JsonLineEvent[] = [];
	private partial = "";
	private waiters: Array<{
		predicate: (ev: JsonLineEvent) => boolean;
		resolve: (ev: JsonLineEvent) => void;
		reject: (err: Error) => void;
		timer: NodeJS.Timeout;
	}> = [];
	public readonly cwd: string;

	private constructor(child: ChildProcessWithoutNullStreams, cwd: string, opts: CliHarnessOptions) {
		this.child = child;
		this.cwd = cwd;

		child.stdout.setEncoding("utf-8");
		child.stdout.on("data", (chunk: string) => this.ingest(chunk, opts.echo));
		child.stderr.setEncoding("utf-8");
		child.stderr.on("data", (chunk: string) => {
			if (opts.echo) process.stderr.write(`[cli stderr] ${chunk}`);
		});
		child.on("exit", (code) => {
			this.flushPartial();
			const err = new Error(`CLI exited (code=${code ?? "null"}) before pattern matched`);
			for (const w of this.waiters) {
				clearTimeout(w.timer);
				w.reject(err);
			}
			this.waiters = [];
		});
	}

	static async start(opts: CliHarnessOptions): Promise<CliHarness> {
		const cwd = opts.cwd ?? mkdtempSync(join(tmpdir(), "tutorial-cli-client-e2e-"));
		const packageRoot = resolve(__dirname, "../../..");
		const cliEntry = resolve(packageRoot, "src/cli.ts");
		const args = [
			"--no-warnings",
			"--import",
			"tsx",
			cliEntry,
			"--test",
			"--bodhi-url",
			opts.bodhiUrl,
			"--cwd",
			cwd,
		];
		const child = spawn(process.execPath, args, {
			cwd: packageRoot,
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
			stdio: ["pipe", "pipe", "pipe"],
		});
		return new CliHarness(child, cwd, opts);
	}

	send(input: string): void {
		if (!this.child.stdin.writable) {
			throw new Error("CLI stdin is not writable");
		}
		this.child.stdin.write(input.endsWith("\n") ? input : `${input}\n`);
	}

	/**
	 * Wait for the next event whose `text` (or any structured field via the
	 * predicate variant) matches. Resolves with the matched event.
	 */
	waitFor(matcher: RegExp | ((ev: JsonLineEvent) => boolean), timeoutMs = 60_000): Promise<JsonLineEvent> {
		const predicate =
			typeof matcher === "function"
				? matcher
				: (ev: JsonLineEvent) => typeof ev.text === "string" && matcher.test(ev.text);
		const queued = this.events.find((ev) => predicate(ev));
		if (queued) return Promise.resolve(queued);
		return new Promise<JsonLineEvent>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.waiters = this.waiters.filter((w) => w.predicate !== predicate);
				const dump = this.events.map((e) => JSON.stringify(e)).join("\n  ");
				reject(new Error(`waitFor timeout after ${timeoutMs}ms. Buffer:\n  ${dump}`));
			}, timeoutMs);
			this.waiters.push({ predicate, resolve, reject, timer });
		});
	}

	dispose(): void {
		this.child.kill("SIGTERM");
		try {
			rmSync(this.cwd, { recursive: true, force: true });
		} catch {
			// best effort
		}
	}

	private ingest(chunk: string, echo?: boolean): void {
		this.partial += chunk;
		const lines = this.partial.split("\n");
		this.partial = lines.pop() ?? "";
		for (const line of lines) {
			if (echo) process.stdout.write(`[cli] ${line}\n`);
			this.tryParse(line);
		}
	}

	private flushPartial(): void {
		if (!this.partial) return;
		this.tryParse(this.partial);
		this.partial = "";
	}

	private tryParse(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) return;
		try {
			const parsed = JSON.parse(trimmed) as JsonLineEvent;
			this.events.push(parsed);
			for (const waiter of this.waiters.slice()) {
				if (waiter.predicate(parsed)) {
					clearTimeout(waiter.timer);
					this.waiters = this.waiters.filter((w) => w !== waiter);
					waiter.resolve(parsed);
				}
			}
		} catch {
			// non-JSON line in --test mode is unexpected but not fatal; ignore
		}
	}
}
