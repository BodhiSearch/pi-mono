/**
 * Bodhi concrete implementation of `LlmProvider`.
 *
 * Bodhi acts as an AI **gateway**: one server root exposes OpenAI,
 * OpenAI-responses, Anthropic, Anthropic-OAuth, and Gemini endpoints at
 * well-known sub-paths (`/v1`, `/anthropic`, `/v1beta`). The access token
 * obtained by the main thread's OAuth 2.1 flow is a single bearer that
 * works across all of them.
 *
 * The provider therefore owns two things:
 *
 * 1. **Auth resolution** — hand the token back as `apiKey`. pi-ai's
 *    per-format code already places it into the correct auth header
 *    (`Authorization: Bearer` for OpenAI/Gemini, `x-api-key` for
 *    Anthropic). `getApiKeyAndHeaders` stays tiny.
 * 2. **Catalog fetching** — call `GET /bodhi/v1/models?page_size=100`,
 *    flatten the `PaginatedAliasResponse` across local aliases and
 *    remote `ApiAliasResponse` entries, and return `Model<Api>[]` with
 *    the per-format `baseUrl` pi-ai expects plus the upstream context /
 *    token limits where available.
 *
 * On-demand only: every `getAvailableModels()` hits the endpoint. The
 * worker is expected to call this at most once per UI refresh plus one
 * extra time per `setModel` / session-restore round-trip, so there is
 * no caching layer yet.
 */

import type { Api, Model, Provider } from '@mariozechner/pi-ai';
import type {
  AliasResponse,
  AnthropicModel,
  ApiAliasResponse,
  ApiFormat,
  ApiModel,
  GeminiModel,
  ModelAliasResponse,
  Model as OpenAIModelDescriptor,
  PaginatedAliasResponse,
  UserAliasResponse,
} from '@bodhiapp/bodhi-js-react/api';
import type { LlmAuthCredential, LlmProvider } from '../worker-agent/llm/types';

export const BODHI_PROVIDER_TAG = 'bodhi';

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 4_096;
const CATALOG_PATH = '/bodhi/v1/models?page_size=100';

/** pi-ai `Api` strings the provider emits. */
type PiApi =
  | 'openai-completions'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'google-generative-ai';

export class BodhiProvider implements LlmProvider {
  private token: string | null = null;
  private baseUrl: string | undefined;

  setAuthToken(credential: LlmAuthCredential | null): void {
    // A `null` credential or a credential tagged for a different provider
    // clears Bodhi's state. The provider-tag filter keeps future
    // co-resident providers from stepping on each other.
    if (!credential || credential.provider !== BODHI_PROVIDER_TAG) {
      this.token = null;
      this.baseUrl = undefined;
      return;
    }
    this.token = credential.token;
    this.baseUrl = credential.baseUrl;
  }

  async getApiKeyAndHeaders(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _model: Model<Api>
  ): Promise<{ apiKey: string; headers?: Record<string, string> }> {
    return { apiKey: this.token ?? '' };
  }

  /**
   * Fetch the model catalog from `/bodhi/v1/models` and flatten it into
   * `Model<Api>[]`. Throws if the auth token / baseUrl have not been
   * seeded via `setAuthToken` — callers (the UI) already gate on the
   * authenticated state so this path is only hit in misconfiguration.
   */
  async getAvailableModels(): Promise<Model<Api>[]> {
    const { baseUrl, token } = this.requireCredentials();
    const response = await fetch(`${baseUrl}${CATALOG_PATH}`, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const detail = await this.readErrorDetail(response);
      throw new Error(
        `Failed to fetch Bodhi model catalog: ${response.status} ${response.statusText}${detail}`
      );
    }
    const payload = (await response.json()) as PaginatedAliasResponse;
    const entries = payload.data ?? [];
    return entries.flatMap(entry => this.flattenAlias(entry, baseUrl));
  }

  /** Test-only inspector — the current server URL associated with the token. */
  getBaseUrl(): string | undefined {
    return this.baseUrl;
  }

  // ---------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------

  private requireCredentials(): { baseUrl: string; token: string } {
    if (!this.baseUrl || !this.token) {
      throw new Error(
        'BodhiProvider: cannot fetch catalog before setAuthToken has been called with a valid Bodhi credential.'
      );
    }
    return { baseUrl: this.stripTrailingSlash(this.baseUrl), token: this.token };
  }

  private stripTrailingSlash(value: string): string {
    return value.replace(/\/$/, '');
  }

  private async readErrorDetail(response: Response): Promise<string> {
    try {
      const text = await response.text();
      return text ? ` — ${text}` : '';
    } catch {
      return '';
    }
  }

  /** Flatten a single alias row into zero-or-more pi-ai models. */
  private flattenAlias(entry: AliasResponse, serverRoot: string): Model<Api>[] {
    if (isApiAlias(entry)) {
      return this.flattenApiAlias(entry, serverRoot);
    }
    return [this.buildLocalAliasModel(entry, serverRoot)];
  }

  private flattenApiAlias(entry: ApiAliasResponse, serverRoot: string): Model<Api>[] {
    const prefix = entry.prefix ?? '';
    const fmt = entry.api_format ?? 'openai';
    return (entry.models ?? [])
      .map(model => this.buildApiAliasModel(model, fmt, prefix, serverRoot))
      .filter((m): m is Model<Api> => m !== null);
  }

  private buildApiAliasModel(
    model: ApiModel,
    fmt: ApiFormat,
    prefix: string,
    serverRoot: string
  ): Model<Api> | null {
    const id = extractApiModelId(model);
    if (!id) return null;
    const { contextWindow, maxTokens } = extractApiModelLimits(model);
    return {
      id: `${prefix}${id}`,
      name: extractApiModelDisplayName(model) ?? `${prefix}${id}`,
      api: apiFormatToPiApi(fmt),
      provider: apiFormatToProvider(fmt),
      baseUrl: baseUrlForFormat(serverRoot, fmt),
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
  }

  private buildLocalAliasModel(
    entry: UserAliasResponse | ModelAliasResponse,
    serverRoot: string
  ): Model<Api> {
    const id = 'alias' in entry ? entry.alias : (entry as UserAliasResponse).alias;
    const metadata = 'metadata' in entry ? entry.metadata : undefined;
    const contextWindow = metadata?.context?.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW;
    const maxTokens = metadata?.context?.max_output_tokens ?? DEFAULT_MAX_TOKENS;
    return {
      id,
      name: id,
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: baseUrlForFormat(serverRoot, 'openai'),
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow,
      maxTokens,
    };
  }
}

/** Narrow an `AliasResponse` variant that wraps a remote provider's catalog. */
function isApiAlias(entry: AliasResponse): entry is ApiAliasResponse {
  return 'api_format' in entry && 'models' in entry;
}

function extractApiModelId(model: ApiModel): string | undefined {
  if (model.provider === 'gemini') {
    const name = (model as GeminiModel & { provider: 'gemini' }).name;
    if (!name) return undefined;
    return name.startsWith('models/') ? name.slice('models/'.length) : name;
  }
  if (model.provider === 'anthropic') {
    return (model as AnthropicModel & { provider: 'anthropic' }).id;
  }
  return (model as OpenAIModelDescriptor & { provider: 'openai' }).id;
}

function extractApiModelDisplayName(model: ApiModel): string | undefined {
  if (model.provider === 'anthropic') {
    return (model as AnthropicModel & { provider: 'anthropic' }).display_name;
  }
  if (model.provider === 'gemini') {
    const gemini = model as GeminiModel & { provider: 'gemini' };
    return gemini.displayName ?? undefined;
  }
  return undefined;
}

function extractApiModelLimits(model: ApiModel): {
  contextWindow: number;
  maxTokens: number;
} {
  if (model.provider === 'anthropic') {
    const anth = model as AnthropicModel & { provider: 'anthropic' };
    return {
      contextWindow: anth.max_input_tokens ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: anth.max_tokens ?? DEFAULT_MAX_TOKENS,
    };
  }
  if (model.provider === 'gemini') {
    const gem = model as GeminiModel & { provider: 'gemini' };
    return {
      contextWindow: gem.inputTokenLimit ?? DEFAULT_CONTEXT_WINDOW,
      maxTokens: gem.outputTokenLimit ?? DEFAULT_MAX_TOKENS,
    };
  }
  // OpenAI's `Model` variant only carries id/created/owned_by — no limits.
  return {
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function apiFormatToPiApi(fmt: ApiFormat): PiApi {
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

function apiFormatToProvider(fmt: ApiFormat): Provider {
  if (fmt === 'anthropic' || fmt === 'anthropic_oauth') return 'anthropic';
  if (fmt === 'gemini') return 'google';
  return 'openai';
}

/**
 * Compute the per-format base URL pi-ai expects. Mirrors today's
 * `lib/agent-model.ts::getBaseUrl` so the worker-owned catalog does
 * not change request routing:
 *
 * - OpenAI / OpenAI-responses → `{root}/v1`
 * - Anthropic / Anthropic-OAuth → `{root}/anthropic` (pi-ai appends
 *   `/v1/messages`)
 * - Gemini → `{root}/v1beta`
 */
function baseUrlForFormat(serverRoot: string, fmt: ApiFormat): string {
  if (fmt === 'anthropic' || fmt === 'anthropic_oauth') return `${serverRoot}/anthropic`;
  if (fmt === 'gemini') return `${serverRoot}/v1beta`;
  return `${serverRoot}/v1`;
}
