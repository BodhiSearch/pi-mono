import { streamSimple } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { LlmProvider } from './bodhi-provider';

export function createStreamFn(provider: LlmProvider): StreamFn {
  return async (model, context, options) => {
    const auth = await provider.getApiKeyAndHeaders(model);
    const headers = mergeHeaders(auth.headers, options?.headers);
    return streamSimple(model, context, {
      ...options,
      apiKey: auth.apiKey,
      headers,
    });
  };
}

function mergeHeaders(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}
