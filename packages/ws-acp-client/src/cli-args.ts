/**
 * CLI argument parser for `ws-acp-client`. Extracted from `cli.ts` so
 * unit tests can drive it without spawning a child process.
 */

import { resolve as resolvePath } from "node:path";
import { CWD_VOLUME_NAME } from "./services/cwd-volume";

export interface VolumeArg {
	name: string;
	path: string;
}

export interface CliArgs {
	port: number;
	cwd: string;
	bindAddress: string;
	volumes: VolumeArg[];
}

export const DEFAULT_PORT = 8923;
export const DEFAULT_BIND = "127.0.0.1";

// Mount-name validation matches the agent's ZenfsVolumeRegistry contract:
// alphanum + dash + underscore, 1..63 chars. Reserved name `cwd` is the
// auto-mount; rejecting it here surfaces a clear error instead of letting
// `mountAll` fail with a duplicate-name error mid-startup.
const VOLUME_NAME_PATTERN = /^[A-Za-z0-9_-]{1,63}$/;

function parseVolumeFlag(raw: string): VolumeArg {
	// Split on the FIRST '=' so paths containing '=' (rare but legal on
	// POSIX) don't get truncated. Both halves must be non-empty.
	const eq = raw.indexOf("=");
	if (eq <= 0 || eq === raw.length - 1) {
		throw new Error(`--volume: expected name=path, got '${raw}'`);
	}
	const name = raw.slice(0, eq);
	const path = raw.slice(eq + 1);
	if (!VOLUME_NAME_PATTERN.test(name)) {
		throw new Error(`--volume: invalid name '${name}' (alphanum/_/-, max 63 chars)`);
	}
	if (name === CWD_VOLUME_NAME) {
		throw new Error(`--volume: '${CWD_VOLUME_NAME}' is reserved (auto-mounted from --cwd)`);
	}
	return { name, path: resolvePath(path) };
}

export interface ParseArgsOptions {
	/** Override `process.cwd()` for the default `--cwd` value. Tests pass
	 * a deterministic value so assertions don't depend on where vitest
	 * happens to be invoked from. */
	defaultCwd?: string;
}

export function parseArgs(argv: string[], opts: ParseArgsOptions = {}): CliArgs {
	let port = DEFAULT_PORT;
	let cwd = opts.defaultCwd ?? process.cwd();
	let bindAddress = DEFAULT_BIND;
	const volumes: VolumeArg[] = [];
	const seenNames = new Set<string>();

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--port": {
				const next = argv[++i];
				if (next === undefined) throw new Error("--port requires a value");
				const parsed = Number(next);
				if (!Number.isFinite(parsed) || parsed < 0) {
					throw new Error(`--port: invalid number '${next}'`);
				}
				port = parsed;
				break;
			}
			case "--cwd": {
				const next = argv[++i];
				if (!next) throw new Error("--cwd requires a path");
				cwd = resolvePath(next);
				break;
			}
			case "--bind": {
				const next = argv[++i];
				if (!next) throw new Error("--bind requires a value");
				bindAddress = next;
				break;
			}
			case "--volume": {
				const next = argv[++i];
				if (!next) throw new Error("--volume requires name=path");
				const vol = parseVolumeFlag(next);
				if (seenNames.has(vol.name)) {
					throw new Error(`--volume: duplicate name '${vol.name}'`);
				}
				seenNames.add(vol.name);
				volumes.push(vol);
				break;
			}
			default:
				throw new Error(`Unknown arg: ${arg}`);
		}
	}

	return { port, cwd, bindAddress, volumes };
}

export function printUsage(write: (line: string) => void = console.log): void {
	const lines = [
		"ws-acp-client — WebSocket host for @bodhiapp/web-acp-agent",
		"",
		"Options:",
		"  --port <n>            Listen port (default 8923, 0 = ephemeral)",
		"  --bind <addr>         Bind address (default 127.0.0.1)",
		"  --cwd <path>          Agent working directory (default cwd)",
		"  --volume name=path    Mount an additional PassthroughFS volume at",
		"                        /mnt/<name>. Repeatable. 'cwd' is reserved.",
		"  -h, --help            Show this help",
	];
	for (const line of lines) write(line);
}
