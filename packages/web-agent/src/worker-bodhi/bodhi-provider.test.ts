import type { Api, Model } from '@mariozechner/pi-ai';
import type { PaginatedAliasResponse } from '@bodhiapp/bodhi-js-react/api';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LlmAuthCredential } from '../worker-agent/llm/types';
import { BODHI_PROVIDER_TAG, BodhiProvider } from './bodhi-provider';

const fakeModel = {
  id: 'gpt-test',
  provider: 'openai',
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
} as unknown as Model<Api>;

const BASE = 'https://bodhi.local';

function bodhiCredential(token: string, baseUrl = BASE): LlmAuthCredential {
  return { provider: BODHI_PROVIDER_TAG, baseUrl, token };
}

function mockCatalog(body: PaginatedAliasResponse): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

function mockFailure(status: number, text = 'boom'): ReturnType<typeof vi.fn> {
  const fn = vi.fn(
    async () =>
      new Response(text, {
        status,
        statusText: 'Bad Gateway',
      })
  );
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('BodhiProvider — auth resolution', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns empty apiKey before any credential is set', async () => {
    const provider = new BodhiProvider();
    expect(await provider.getApiKeyAndHeaders(fakeModel)).toEqual({ apiKey: '' });
  });

  test('stores and returns bodhi-tagged credentials', async () => {
    const provider = new BodhiProvider();
    provider.setAuthToken(bodhiCredential('tok-1'));
    expect(await provider.getApiKeyAndHeaders(fakeModel)).toEqual({ apiKey: 'tok-1' });
    expect(provider.getBaseUrl()).toBe(BASE);
  });

  test('clears state when credential is null', async () => {
    const provider = new BodhiProvider();
    provider.setAuthToken(bodhiCredential('tok-1'));
    provider.setAuthToken(null);
    expect(await provider.getApiKeyAndHeaders(fakeModel)).toEqual({ apiKey: '' });
    expect(provider.getBaseUrl()).toBeUndefined();
  });

  test('ignores credentials tagged for a different provider', async () => {
    const provider = new BodhiProvider();
    provider.setAuthToken(bodhiCredential('tok-1'));
    provider.setAuthToken({
      provider: 'other',
      baseUrl: 'https://other.local',
      token: 'tok-other',
    });
    // Non-bodhi credentials clear Bodhi state so a foreign rotation
    // channel can't leave stale Bodhi auth behind.
    expect(await provider.getApiKeyAndHeaders(fakeModel)).toEqual({ apiKey: '' });
    expect(provider.getBaseUrl()).toBeUndefined();
  });
});

describe('BodhiProvider — getAvailableModels', () => {
  let provider: BodhiProvider;

  beforeEach(() => {
    provider = new BodhiProvider();
    provider.setAuthToken(bodhiCredential('tok-models'));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('throws when no credential has been seeded', async () => {
    const bare = new BodhiProvider();
    await expect(bare.getAvailableModels()).rejects.toThrow(/setAuthToken/i);
  });

  test('throws with detail when endpoint returns non-2xx', async () => {
    mockFailure(502, 'upstream offline');
    await expect(provider.getAvailableModels()).rejects.toThrow(/upstream offline/);
  });

  test('calls /bodhi/v1/models with bearer token', async () => {
    const spy = mockCatalog({ data: [], total: 0, page: 1, page_size: 100 });
    await provider.getAvailableModels();
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/bodhi/v1/models?page_size=100`);
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok-models');
  });

  test('maps UserAliasResponse as openai-completions with metadata limits', async () => {
    mockCatalog({
      data: [
        {
          id: 'local-1',
          alias: 'llama-3-8b',
          repo: 'meta/llama',
          filename: 'llama.gguf',
          snapshot: 'abc',
          source: 'user',
          model_params: {},
          request_params: {},
          context_params: [],
          created_at: '2025-01-01T00:00:00Z',
          updated_at: '2025-01-01T00:00:00Z',
          metadata: {
            capabilities: { tools: { function: 'none' } },
            context: { max_input_tokens: 4096, max_output_tokens: 2048 },
            architecture: { format: 'gguf' },
          },
          // biome-ignore lint: fixture payload mirrors API shape
        } as unknown as never,
      ],
      total: 1,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: 'llama-3-8b',
      name: 'llama-3-8b',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: `${BASE}/v1`,
      contextWindow: 4096,
      maxTokens: 2048,
    });
  });

  test('falls back to default limits when metadata is absent', async () => {
    mockCatalog({
      data: [
        {
          alias: 'auto-model',
          repo: 'meta/llama',
          filename: 'llama.gguf',
          snapshot: 'abc',
          source: 'model',
        } as unknown as never,
      ],
      total: 1,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models[0]).toMatchObject({
      id: 'auto-model',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: `${BASE}/v1`,
      contextWindow: 128_000,
      maxTokens: 4096,
    });
  });

  test('maps ApiAliasResponse with openai models', async () => {
    mockCatalog({
      data: [
        {
          source: 'api',
          id: 'openai-alias',
          api_format: 'openai',
          base_url: 'https://api.openai.com/v1',
          has_api_key: true,
          forward_all_with_prefix: false,
          created_at: '',
          updated_at: '',
          models: [
            { provider: 'openai', id: 'gpt-4o', object: 'model', created: 0, owned_by: 'openai' },
          ],
        } as unknown as never,
      ],
      total: 1,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models[0]).toMatchObject({
      id: 'gpt-4o',
      api: 'openai-completions',
      provider: 'openai',
      baseUrl: `${BASE}/v1`,
      contextWindow: 128_000,
      maxTokens: 4096,
    });
  });

  test('uses openai-responses api for openai_responses format', async () => {
    mockCatalog({
      data: [
        {
          source: 'api',
          id: 'oai-resp',
          api_format: 'openai_responses',
          base_url: '',
          has_api_key: true,
          forward_all_with_prefix: false,
          created_at: '',
          updated_at: '',
          models: [
            { provider: 'openai', id: 'gpt-5', object: 'model', created: 0, owned_by: 'openai' },
          ],
        } as unknown as never,
      ],
      total: 1,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models[0]).toMatchObject({
      id: 'gpt-5',
      api: 'openai-responses',
      provider: 'openai',
      baseUrl: `${BASE}/v1`,
    });
  });

  test('prepends prefix and uses anthropic baseUrl/limits', async () => {
    mockCatalog({
      data: [
        {
          source: 'api',
          id: 'anth-alias',
          api_format: 'anthropic',
          base_url: '',
          has_api_key: true,
          forward_all_with_prefix: false,
          prefix: 'anth/',
          created_at: '',
          updated_at: '',
          models: [
            {
              provider: 'anthropic',
              id: 'claude-sonnet-4',
              display_name: 'Claude Sonnet 4',
              created_at: '',
              type: 'model',
              max_input_tokens: 200_000,
              max_tokens: 8192,
            },
          ],
        } as unknown as never,
      ],
      total: 1,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models[0]).toMatchObject({
      id: 'anth/claude-sonnet-4',
      name: 'Claude Sonnet 4',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: `${BASE}/anthropic`,
      contextWindow: 200_000,
      maxTokens: 8192,
    });
  });

  test('maps anthropic_oauth to anthropic-messages api', async () => {
    mockCatalog({
      data: [
        {
          source: 'api',
          id: 'anth-oauth',
          api_format: 'anthropic_oauth',
          base_url: '',
          has_api_key: true,
          forward_all_with_prefix: false,
          created_at: '',
          updated_at: '',
          models: [
            {
              provider: 'anthropic',
              id: 'claude-opus-4',
              display_name: 'Claude Opus 4',
              created_at: '',
              type: 'model',
            },
          ],
        } as unknown as never,
      ],
      total: 1,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models[0]).toMatchObject({
      id: 'claude-opus-4',
      api: 'anthropic-messages',
      provider: 'anthropic',
      baseUrl: `${BASE}/anthropic`,
      contextWindow: 128_000,
      maxTokens: 4096,
    });
  });

  test('strips models/ prefix and picks up gemini limits', async () => {
    mockCatalog({
      data: [
        {
          source: 'api',
          id: 'gem-alias',
          api_format: 'gemini',
          base_url: '',
          has_api_key: true,
          forward_all_with_prefix: false,
          created_at: '',
          updated_at: '',
          models: [
            {
              provider: 'gemini',
              name: 'models/gemini-2.5-pro',
              displayName: 'Gemini 2.5 Pro',
              inputTokenLimit: 1_000_000,
              outputTokenLimit: 65_536,
              supportedGenerationMethods: ['generateContent'],
            },
          ],
        } as unknown as never,
      ],
      total: 1,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models[0]).toMatchObject({
      id: 'gemini-2.5-pro',
      name: 'Gemini 2.5 Pro',
      api: 'google-generative-ai',
      provider: 'google',
      baseUrl: `${BASE}/v1beta`,
      contextWindow: 1_000_000,
      maxTokens: 65_536,
    });
  });

  test('flattens a mixed response across local + remote aliases', async () => {
    mockCatalog({
      data: [
        {
          alias: 'local-alias',
          repo: 'meta',
          filename: 'f',
          snapshot: 's',
          source: 'model',
        } as unknown as never,
        {
          source: 'api',
          id: 'openai-alias',
          api_format: 'openai',
          base_url: '',
          has_api_key: true,
          forward_all_with_prefix: false,
          created_at: '',
          updated_at: '',
          models: [
            {
              provider: 'openai',
              id: 'gpt-4o-mini',
              object: 'model',
              created: 0,
              owned_by: 'openai',
            },
          ],
        } as unknown as never,
      ],
      total: 2,
      page: 1,
      page_size: 100,
    } as PaginatedAliasResponse);
    const models = await provider.getAvailableModels();
    expect(models.map(m => m.id).sort()).toEqual(['gpt-4o-mini', 'local-alias']);
  });
});
