import { readTokens } from "./auth/token-store";
import type { Emitter } from "./emitter";

export interface DispatchContext {
	emitter: Emitter;
	cwd: string;
}

export interface DispatchResult {
	exit: boolean;
}

export async function dispatch(line: string, ctx: DispatchContext): Promise<DispatchResult> {
	if (line === "/quit") {
		ctx.emitter.emit({ text: "application exited" });
		return { exit: true };
	}
	if (line === "/token") {
		await emitToken(ctx);
		return { exit: false };
	}
	if (line === "") {
		return { exit: false };
	}
	ctx.emitter.emit({ text: `unknown command: ${line}` });
	return { exit: false };
}

async function emitToken(ctx: DispatchContext): Promise<void> {
	const tokens = await readTokens(ctx.cwd);
	if (!tokens) {
		ctx.emitter.emit({ text: "no token stored — run login first" });
		return;
	}
	ctx.emitter.emit({
		text: tokens.accessToken,
		tokens: {
			accessToken: tokens.accessToken,
			refreshToken: tokens.refreshToken,
			tokenType: tokens.tokenType,
			expiresAt: tokens.expiresAt,
			scope: tokens.scope,
		},
	});
}
