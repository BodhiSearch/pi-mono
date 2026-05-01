import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { LlmProvider } from "./bodhi-provider";

/**
 * Per-turn option overrides the adapter can push before each prompt.
 *
 * `toolChoice` maps directly to the provider-specific `tool_choice`
 * field (OpenAI / Anthropic) via `ProviderStreamOptions`; setting it to
 * `'required'` forces the model to emit a tool call on the next turn.
 * The adapter uses this in DEV mode when the `forceToolCall` feature
 * toggle is on so bash-smoke tests don't depend on the model's
 * discretion.
 *
 * Overrides are **one-shot** — the provider reads them once per call and
 * then clears them, so forceToolCall only applies to the first LLM
 * request in a turn. Without this the pi-agent-core loop would keep
 * being forced into tool calls forever, never producing the final
 * assistant reply.
 */
export interface StreamOptionOverrides {
	toolChoice?: "auto" | "required" | "none";
}

export type StreamOverrideProvider = () => StreamOptionOverrides | undefined;

export function createStreamFn(provider: LlmProvider, consumeOverrides?: StreamOverrideProvider): StreamFn {
	return async (model, context, options) => {
		const auth = await provider.getApiKeyAndHeaders(model);
		const headers = mergeHeaders(auth.headers, options?.headers);
		const overrides = consumeOverrides?.() ?? {};
		const extra: Record<string, unknown> = {};
		if (overrides.toolChoice) extra.toolChoice = overrides.toolChoice;
		return streamSimple(model, context, {
			...options,
			...extra,
			apiKey: auth.apiKey,
			headers,
		});
	};
}

function mergeHeaders(
	base: Record<string, string> | undefined,
	override: Record<string, string> | undefined,
): Record<string, string> | undefined {
	if (!base && !override) return undefined;
	return { ...base, ...override };
}
