import * as readline from "node:readline";
import { createEmbeddedAgent, type EmbeddedAgent } from "./agent/embed";
import { runAuthIfNeeded } from "./auth";
import { dispatch } from "./dispatcher";
import { createEmitter, type Emitter, type EmitterMode } from "./emitter";

export interface BootstrapOptions {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
	exit: () => void;
	cwd: string;
	mode?: EmitterMode;
	bodhiUrl: string;
	openBrowser?: boolean;
	prompt?: string;
}

export async function bootstrapCli(opts: BootstrapOptions): Promise<void> {
	const emitter = createEmitter({
		output: opts.output,
		mode: opts.mode ?? "plain",
		prompt: opts.prompt,
	});

	const tokens = await runAuthIfNeeded({
		cwd: opts.cwd,
		bodhiUrl: opts.bodhiUrl,
		openBrowser: opts.openBrowser ?? emitter.mode === "plain",
		emitter,
	});
	const agent = await startAgent({ emitter, tokens });

	const rl = readline.createInterface({ input: opts.input, terminal: false });
	emitter.prompt();

	return new Promise<void>((resolve) => {
		rl.on("line", async (raw) => {
			const result = await dispatch(raw.trim(), { emitter, cwd: opts.cwd, agent });
			if (result.exit) {
				await agent.close().catch(() => {});
				opts.exit();
				rl.close();
				return;
			}
			emitter.prompt();
		});
		rl.on("close", () => resolve());
	});
}

async function startAgent(args: {
	emitter: Emitter;
	tokens: { accessToken: string; bodhiUrl: string };
}): Promise<EmbeddedAgent> {
	const agent = await createEmbeddedAgent();
	await agent.initialize();
	await agent.authenticate({ token: args.tokens.accessToken, baseUrl: args.tokens.bodhiUrl });
	const info = await agent.serverInfo();
	args.emitter.emit({
		text: `BodhiApp ${info.status} at ${info.url} (version ${info.version})`,
		...info,
	});
	return agent;
}
