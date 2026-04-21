import type { Api, Model } from '@mariozechner/pi-ai';
import { describe, expect, test } from 'vitest';
import type { LlmAuthCredential } from '../worker-agent/llm/types';
import { BODHI_PROVIDER_TAG, BodhiAuthProvider } from './bodhi-auth-provider';

const fakeModel = {
  id: 'gpt-test',
  provider: 'openai',
  api: 'openai-completions',
  baseUrl: 'https://example.test/v1',
} as unknown as Model<Api>;

describe('BodhiAuthProvider', () => {
  test('returns empty apiKey before any credential is set', async () => {
    const provider = new BodhiAuthProvider();
    const auth = await provider.getApiKeyAndHeaders(fakeModel);
    expect(auth).toEqual({ apiKey: '' });
  });

  test('stores and returns bodhi-tagged credentials', async () => {
    const provider = new BodhiAuthProvider();
    const credential: LlmAuthCredential = {
      provider: BODHI_PROVIDER_TAG,
      baseUrl: 'https://bodhi.local',
      token: 'tok-1',
    };
    provider.setAuthToken(credential);
    expect(await provider.getApiKeyAndHeaders(fakeModel)).toEqual({ apiKey: 'tok-1' });
    expect(provider.getBaseUrl()).toBe('https://bodhi.local');
  });

  test('clears state when credential is null', async () => {
    const provider = new BodhiAuthProvider();
    provider.setAuthToken({
      provider: BODHI_PROVIDER_TAG,
      baseUrl: 'https://bodhi.local',
      token: 'tok-1',
    });
    provider.setAuthToken(null);
    expect(await provider.getApiKeyAndHeaders(fakeModel)).toEqual({ apiKey: '' });
    expect(provider.getBaseUrl()).toBeUndefined();
  });

  test('ignores credentials tagged for a different provider', async () => {
    const provider = new BodhiAuthProvider();
    provider.setAuthToken({
      provider: BODHI_PROVIDER_TAG,
      baseUrl: 'https://bodhi.local',
      token: 'tok-1',
    });
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
