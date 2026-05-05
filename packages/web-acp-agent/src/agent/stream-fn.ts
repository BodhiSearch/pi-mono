import type { StreamFn } from '@mariozechner/pi-agent-core';
import type { Api, Model, ProviderResponse } from '@mariozechner/pi-ai';
import { streamSimple } from '@mariozechner/pi-ai';
import type { LlmProvider } from './bodhi-provider';
import type { ProviderStreamSimple } from './extensions/types';

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
  toolChoice?: 'auto' | 'required' | 'none';
}

export type StreamOverrideProvider = () => StreamOptionOverrides | undefined;

/**
 * Pluggable provider hooks invoked once per `streamSimple` call.
 *
 * `onPayload` runs after the provider serialises the wire payload
 * but before the HTTP request fires; returning a value replaces
 * the payload (mirrors `pi-ai`'s `StreamOptions.onPayload`
 * contract). `onResponse` runs after headers are received and is
 * observation-only.
 *
 * Both hooks are optional and stay `undefined` when no extension
 * subscribes to the matching event.
 */
export interface StreamProviderHooks {
  onPayload?(payload: unknown): unknown | Promise<unknown>;
  onResponse?(response: ProviderResponse): void | Promise<void>;
}

export type StreamProviderHooksProvider = () => StreamProviderHooks | undefined;

/**
 * Routing decision for a single LLM call. Returned from
 * `getExtensionProvider(model)` when an extension owns the model;
 * `null` falls back to the host `LlmProvider`. `streamSimple` lets
 * an extension swap the wire layer entirely (used by ports that
 * speak a non-built-in API format).
 */
export interface ExtensionProviderResolution {
  apiKey: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  streamSimple?: ProviderStreamSimple;
}

export type ExtensionProviderResolver = (model: Model<Api>) => ExtensionProviderResolution | null;

export function createStreamFn(
  provider: LlmProvider,
  consumeOverrides?: StreamOverrideProvider,
  getProviderHooks?: StreamProviderHooksProvider,
  getExtensionProvider?: ExtensionProviderResolver
): StreamFn {
  return async (model, context, options) => {
    const extResolution = getExtensionProvider?.(model) ?? null;
    const apiKey = extResolution
      ? extResolution.apiKey
      : (await provider.getApiKeyAndHeaders(model)).apiKey;
    const baseHeaders = extResolution
      ? buildExtensionHeaders(extResolution)
      : (await provider.getApiKeyAndHeaders(model)).headers;
    const headers = mergeHeaders(baseHeaders, options?.headers);
    const overrides = consumeOverrides?.() ?? {};
    const hooks = getProviderHooks?.();
    const extra: Record<string, unknown> = {};
    if (overrides.toolChoice) extra.toolChoice = overrides.toolChoice;

    const onPayload = hooks?.onPayload
      ? async (payload: unknown) => hooks.onPayload!(payload)
      : undefined;
    const onResponse = hooks?.onResponse
      ? async (response: ProviderResponse) => {
          await hooks.onResponse!(response);
        }
      : undefined;

    const stream = extResolution?.streamSimple ?? streamSimple;

    return stream(model, context, {
      ...options,
      ...extra,
      apiKey,
      headers,
      ...(onPayload ? { onPayload } : {}),
      ...(onResponse ? { onResponse } : {}),
    });
  };
}

function buildExtensionHeaders(
  resolution: ExtensionProviderResolution
): Record<string, string> | undefined {
  const out: Record<string, string> = { ...(resolution.headers ?? {}) };
  if (resolution.authHeader && resolution.apiKey) {
    out.Authorization = `Bearer ${resolution.apiKey}`;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function mergeHeaders(
  base: Record<string, string> | undefined,
  override: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!base && !override) return undefined;
  return { ...base, ...override };
}
