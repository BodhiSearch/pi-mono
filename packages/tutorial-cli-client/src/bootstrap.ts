import * as readline from "node:readline";
import { runAuthIfNeeded } from "./auth";
import { dispatch } from "./dispatcher";
import { createEmitter, type EmitterMode } from "./emitter";

export interface BootstrapOptions {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
	exit: () => void;
	cwd: string;
	mode?: EmitterMode;
	bodhiUrl: string;
	/** When false, the OAuth review URL is emitted instead of opened. */
	openBrowser?: boolean;
	/** Skip the auth flow entirely. Used by the /quit unit e2e. */
	skipAuth?: boolean;
	prompt?: string;
}

export async function bootstrapCli(opts: BootstrapOptions): Promise<void> {
	const emitter = createEmitter({
		output: opts.output,
		mode: opts.mode ?? "plain",
		prompt: opts.prompt,
	});

	if (!opts.skipAuth) {
		await runAuthIfNeeded({
			cwd: opts.cwd,
			bodhiUrl: opts.bodhiUrl,
			openBrowser: opts.openBrowser ?? emitter.mode === "plain",
			emitter,
		});
	}

	const rl = readline.createInterface({ input: opts.input, terminal: false });
	emitter.prompt();

	return new Promise<void>((resolve) => {
		rl.on("line", async (raw) => {
			const result = await dispatch(raw.trim(), { emitter, cwd: opts.cwd });
			if (result.exit) {
				opts.exit();
				rl.close();
				return;
			}
			emitter.prompt();
		});
		rl.on("close", () => resolve());
	});
}
