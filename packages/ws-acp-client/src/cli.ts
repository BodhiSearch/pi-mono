#!/usr/bin/env tsx
/**
 * Minimal CLI: stand up a WebSocket-fronted `web-acp-agent` host with
 * the current working directory as the agent's `$cwd`.
 *
 * Usage:
 *   ws-acp-client                            # listens on 127.0.0.1:8923 (default)
 *   ws-acp-client --port 0                   # ephemeral port (use for tests)
 *   ws-acp-client --cwd /path                # override the agent's working dir
 *   ws-acp-client --volume code=/some/dir    # mount /mnt/code via PassthroughFS
 *   ws-acp-client --volume a=/x --volume b=/y  # repeatable
 *
 * Argument parsing is in `cli-args.ts` so the unit tests can cover the
 * wire-shape edge cases without spawning a child process.
 */

import { parseArgs, printUsage } from "./cli-args";
import { startWsAcpServer } from "./server";
import { createHostState } from "./services/assemble";
import { createCwdVolumeInit } from "./services/cwd-volume";

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes("-h") || argv.includes("--help")) {
		printUsage();
		process.exit(0);
	}
	const args = parseArgs(argv);

	const extraVolumes = args.volumes.map((v) => createCwdVolumeInit({ cwd: v.path, mountName: v.name }));

	const host = await createHostState({ cwd: args.cwd, extraVolumes });
	const server = await startWsAcpServer({
		host,
		port: args.port,
		bindAddress: args.bindAddress,
		buildVersion: "0.0.0",
	});

	console.log(`[ws-acp-client] cwd=${host.cwd}`);
	for (const vol of args.volumes) {
		console.log(`[ws-acp-client] volume /mnt/${vol.name}=${vol.path}`);
	}
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
