/**
 * Provider-agnostic `StreamFn` factory.
 *
 * Shape mirrors coding-agent's `sdk.ts` streamFn wiring
 * (packages/coding-agent/src/core/sdk.ts:297-309). For every request the
 * auth provider resolves `{ apiKey, headers }` and we forward them to
 * `streamSimple` — pi-ai's provider-specific code then handles the
 * format-appropriate auth header (OpenAI `Authorization: Bearer`,
 * Anthropic `x-api-key`, Gemini key param).
 */

import { streamSimple } from '@mariozechner/pi-ai';
import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { LlmProvider } from './types';

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
