export type EmitterMode = "plain" | "test";

export interface EmitPayload {
	text: string;
	[key: string]: unknown;
}

export interface Emitter {
	mode: EmitterMode;
	emit(payload: EmitPayload): void;
	prompt(): void;
}

export interface CreateEmitterOptions {
	output: NodeJS.WritableStream;
	mode: EmitterMode;
	prompt?: string;
}

export function createEmitter(opts: CreateEmitterOptions): Emitter {
	const promptStr = opts.prompt ?? "> ";
	if (opts.mode === "test") {
		return {
			mode: "test",
			emit(payload) {
				opts.output.write(`${JSON.stringify(payload)}\n`);
			},
			prompt() {},
		};
	}
	return {
		mode: "plain",
		emit(payload) {
			opts.output.write(`${payload.text}\n`);
		},
		prompt() {
			opts.output.write(promptStr);
		},
	};
}
