import type { Emitter } from "../emitter";
import { runLoginFlow } from "./login-flow";
import { isTokenFresh, readTokens, type StoredTokens, writeTokens } from "./token-store";

export interface RunAuthOptions {
	cwd: string;
	bodhiUrl: string;
	openBrowser: boolean;
	emitter: Emitter;
	authServerUrl?: string;
	callbackPort?: number;
}

export async function runAuthIfNeeded(opts: RunAuthOptions): Promise<StoredTokens> {
	const existing = await readTokens(opts.cwd);
	if (existing && isTokenFresh(existing)) {
		opts.emitter.emit({ text: "Using cached token from .tutorial-cli-client/tokens.json" });
		return existing;
	}

	const result = await runLoginFlow({
		bodhiUrl: opts.bodhiUrl,
		authServerUrl: opts.authServerUrl,
		callbackPort: opts.callbackPort,
		openBrowser: opts.openBrowser,
		emitter: opts.emitter,
	});

	const stored: StoredTokens = {
		...result.tokens,
		bodhiUrl: result.bodhiUrl,
		authServerUrl: result.authServerUrl,
	};
	await writeTokens(opts.cwd, stored);
	opts.emitter.emit({ text: "Authentication successful." });
	return stored;
}

export type { TokenBundle } from "./token-exchange";
export type { StoredTokens } from "./token-store";
export { isTokenFresh, readTokens, tokenFilePath, writeTokens } from "./token-store";
