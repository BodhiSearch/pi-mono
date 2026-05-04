import * as readline from "node:readline";
import { dispatch } from "./dispatcher";

export interface BootstrapOptions {
	input: NodeJS.ReadableStream;
	output: NodeJS.WritableStream;
	exit: () => void;
	prompt?: string;
}

export function bootstrapCli(opts: BootstrapOptions): Promise<void> {
	const promptStr = opts.prompt ?? "> ";
	const rl = readline.createInterface({ input: opts.input, terminal: false });

	opts.output.write(promptStr);

	return new Promise<void>((resolve) => {
		rl.on("line", (raw) => {
			const result = dispatch(raw.trim(), { output: opts.output });
			if (result.exit) {
				opts.exit();
				rl.close();
				return;
			}
			opts.output.write(promptStr);
		});
		rl.on("close", () => resolve());
	});
}
