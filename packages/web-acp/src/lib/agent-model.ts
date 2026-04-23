import type { Model } from '@mariozechner/pi-ai';
import type { ClientState } from '@bodhiapp/bodhi-js-react';
import { isDirectState } from '@bodhiapp/bodhi-js-react';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';

export type PiApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export function apiFormatToPiApi(fmt: ApiFormat): PiApi {
  switch (fmt) {
    case 'openai_responses':
      return 'openai-responses';
    case 'anthropic':
    case 'anthropic_oauth':
      return 'anthropic-messages';
    case 'gemini':
      return 'google-generative-ai';
    default:
      return 'openai-completions';
  }
}

export function apiFormatToProvider(fmt: ApiFormat): string {
  if (fmt === 'anthropic' || fmt === 'anthropic_oauth') return 'anthropic';
  if (fmt === 'gemini') return 'google';
  return 'openai';
}

export function getBaseUrl(serverUrl: string, fmt: ApiFormat): string {
  const trimmed = serverUrl.replace(/\/$/, '');
  if (fmt === 'anthropic' || fmt === 'anthropic_oauth') return `${trimmed}/anthropic`;
  if (fmt === 'gemini') return `${trimmed}/v1beta`;
  return `${trimmed}/v1`;
}

export function buildModel(modelId: string, serverUrl: string, fmt: ApiFormat): Model<PiApi> {
  return {
    id: modelId,
    name: modelId,
    api: apiFormatToPiApi(fmt),
    provider: apiFormatToProvider(fmt),
    baseUrl: getBaseUrl(serverUrl, fmt),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 4096,
  };
}

export function getServerUrlOrThrow(state: ClientState): string {
  if (!isDirectState(state) || !state.url) {
    throw new Error(
      'Chat requires a Bodhi server connection. Open Settings to connect to a server.'
    );
  }
  return state.url;
}
