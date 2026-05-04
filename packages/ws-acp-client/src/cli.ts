#!/usr/bin/env tsx
/**
 * Minimal CLI: stand up a WebSocket-fronted `web-acp-agent` host with
 * the current working directory as the agent's `$cwd`.
 *
 * Usage:
 *   ws-acp-client            # listens on 127.0.0.1:8923 (default)
 *   ws-acp-client --port 0   # ephemeral port (use for tests)
 *   ws-acp-client --cwd /path  # override the agent's working dir
 */

import { resolve as resolvePath } from "node:path";
import { startWsAcpServer } from "./server";
import { createHostState } from "./services/assemble";

interface CliArgs {
	port: number;
	cwd: string;
	bindAddress: string;
	isDev: boolean;
}

const DEFAULT_PORT = 8923;

function parseArgs(argv: string[]): CliArgs {
	let port = DEFAULT_PORT;
	let cwd = process.cwd();
	let bindAddress = "127.0.0.1";
	let isDev = false;

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
			case "--dev":
				isDev = true;
				break;
			case "-h":
			case "--help":
				printUsage();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown arg: ${arg}`);
		}
	}

	return { port, cwd, bindAddress, isDev };
}

function printUsage(): void {
	const lines = [
		"ws-acp-client — WebSocket host for @bodhiapp/web-acp-agent",
		"",
		"Options:",
		"  --port <n>      Listen port (default 8923, 0 = ephemeral)",
		"  --bind <addr>   Bind address (default 127.0.0.1)",
		"  --cwd <path>    Agent working directory (default cwd)",
		"  --dev           Enable DEV-only agent features",
		"  -h, --help      Show this help",
	];
	console.log(lines.join("\n"));
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	const host = await createHostState({ cwd: args.cwd });
	const server = await startWsAcpServer({
		host,
		port: args.port,
		bindAddress: args.bindAddress,
		isDev: args.isDev,
		buildVersion: "0.0.0",
	});

	console.log(`[ws-acp-client] cwd=${host.cwd}`);
	console.log(`[ws-acp-client] ready: ${server.url}`);

	let shuttingDown = false;
	const shutdown = async (signal: string): Promise<void> => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`[ws-acp-client] received ${signal}, shutting down`);
		try {
			await server.close();
		} catch (err) {
			console.error("[ws-acp-client] server.close() failed:", err);
		}
		try {
			await host.dispose();
		} catch (err) {
			console.error("[ws-acp-client] host.dispose() failed:", err);
		}
		process.exit(0);
	};

	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
	console.error("[ws-acp-client] startup failed:", err);
	process.exit(1);
});
