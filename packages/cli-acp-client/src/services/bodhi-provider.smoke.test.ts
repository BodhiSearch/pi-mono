/**
 * Smoke test that exercises @bodhiapp/web-acp-agent's BodhiProvider in a
 * Node runtime. Goal: catch browser-vs-Node assumptions (Response.body,
 * ReadableStream interop, fetch typing) at unit-test time rather than
 * waiting for the e2e suite.
 *
 * The provider is deliberately small — its streaming hot path runs
 * through `streamSimple` from `@mariozechner/pi-ai`, which is what the
 * embedded agent calls per turn. The catalog fetch (`getAvailableModels`)
 * is the most representative non-trivial code path and is what we
 * exercise here against a stubbed `fetch`.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BodhiProvider } from '@bodhiapp/web-acp-agent';

const ORIGINAL_FETCH = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

function stubFetch(response: { ok?: boolean; status?: number; body: unknown }): void {
  globalThis.fetch = (async () => {
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('BodhiProvider node-runtime smoke', () => {
  it('rejects catalog fetch when setAuthToken has not been called', async () => {
    const provider = new BodhiProvider();
    await expect(provider.getAvailableModels()).rejects.toThrow(/setAuthToken/);
  });

  it('parses a paginated alias catalog into pi-ai Model entries', async () => {
    const provider = new BodhiProvider();
    provider.setAuthToken({
      provider: 'bodhi',
      baseUrl: 'http://localhost:1135',
      token: 'sk-test-token',
    });
    stubFetch({
      body: {
        data: [
          {
            source: 'api',
            api_format: 'openai',
            prefix: 'oai/',
            models: [{ id: 'gpt-4.1-nano', provider: 'openai' }],
          },
          {
            source: 'user',
            alias: 'gemma-3n-e4b-it',
            metadata: {
              context: { max_input_tokens: 8192, max_output_tokens: 2048 },
            },
          },
        ],
        page: 1,
        page_size: 100,
        total: 2,
      },
    });
    const models = await provider.getAvailableModels();
    expect(models.length).toBe(2);
    const ids = models.map(m => m.id);
    expect(ids).toContain('oai/gpt-4.1-nano');
    expect(ids).toContain('gemma-3n-e4b-it');
    const oai = models.find(m => m.id === 'oai/gpt-4.1-nano');
    expect(oai?.api).toBe('openai-completions');
    expect(oai?.baseUrl).toBe('http://localhost:1135/v1');
  });

  it('surfaces non-2xx responses with body detail', async () => {
    const provider = new BodhiProvider();
    provider.setAuthToken({
      provider: 'bodhi',
      baseUrl: 'http://localhost:1135',
      token: 'bad-token',
    });
    globalThis.fetch = (async () =>
      new Response('unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      })) as typeof fetch;
    await expect(provider.getAvailableModels()).rejects.toThrow(/401/);
  });
});
