/**
 * Output abstraction for the CLI.
 *
 * Two modes:
 *
 * - `plain` (default, interactive): writes `text + '\n'` to the output stream
 *   and renders the prompt verbatim. What a human reads on a TTY.
 * - `test`: writes one JSON line per emit (`{"text":"...",...extras}\n`) and
 *   suppresses the prompt entirely. The Playwright harness parses stdout
 *   line by line and matches on either the `text` field or any extra (e.g.
 *   `login_url`).
 *
 * Every CLI output goes through {@link Emitter.emit}. The dispatcher and
 * the auth flow do NOT write to the output stream directly — that keeps
 * the test parser stable across new commands.
 */

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
			prompt() {
				// Suppressed in test mode — JSON-line consumers don't need it.
			},
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
