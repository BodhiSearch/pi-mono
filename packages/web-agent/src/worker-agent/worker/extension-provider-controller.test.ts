import { describe, expect, test, vi } from 'vitest';
import type { Api, Model } from '@mariozechner/pi-ai';
import { ExtensionProviderController } from './extension-provider-controller';
import type { Extension, RegisteredProvider } from '../core/extensions/types';
import type { LlmProvider } from '../llm/types';
import type { RpcEventEnvelope } from '../rpc/rpc-types';

function makeModel(provider: string, id: string): Model<Api> {
  return {
    id,
    provider,
    name: `${provider}:${id}`,
    api: 'openai-completions',
    baseUrl: 'https://invalid.local',
    reasoning: false,
    contextWindow: 1024,
    maxTokens: 256,
  } as unknown as Model<Api>;
}

function fakeProvider(overrides: Partial<LlmProvider> = {}): LlmProvider {
  return {
    getApiKeyAndHeaders: async () => ({ apiKey: 'base' }),
    getAvailableModels: async () => [makeModel('base', 'base-model')],
    setAuthToken: () => {},
    ...overrides,
  };
}

function makeExtension(path: string, providers: RegisteredProvider[]): Extension {
  const map = new Map<string, RegisteredProvider>();
  for (const p of providers) map.set(p.providerId, p);
  return {
    name: path.split('/').pop() ?? 'ext',
    path,
    entryPath: `${path}/index.js`,
    handlers: new Map(),
    tools: new Map(),
    commands: new Map(),
    providers: map,
    skills: new Map(),
  };
}

describe('ExtensionProviderController', () => {
  test('composite dispatches getApiKeyAndHeaders by providerId, falling back to base', async () => {
    const base = fakeProvider({
      getApiKeyAndHeaders: async () => ({ apiKey: 'base-key' }),
    });
    const ctl = new ExtensionProviderController({ base, emitEvent: () => {} });
    const ext = makeExtension('/ext/a', [
      {
        providerId: 'echo',
        extensionPath: '/ext/a',
        provider: fakeProvider({
          getApiKeyAndHeaders: async () => ({ apiKey: 'echo-key' }),
        }),
      },
    ]);
    ctl.setFromExtensions([ext]);
    const composite = ctl.composite();
    const echoAuth = await composite.getApiKeyAndHeaders(makeModel('echo', 'echo-small'));
    expect(echoAuth.apiKey).toBe('echo-key');
    const baseAuth = await composite.getApiKeyAndHeaders(makeModel('bodhi', 'bodhi-small'));
    expect(baseAuth.apiKey).toBe('base-key');
  });

  test('composite merges getAvailableModels and dedupes (provider,id) pairs', async () => {
    const base = fakeProvider({
      getAvailableModels: async () => [
        makeModel('bodhi', 'bodhi-a'),
        makeModel('echo', 'echo-small'), // should be shadowed by extension version
      ],
    });
    const ctl = new ExtensionProviderController({ base, emitEvent: () => {} });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          providerId: 'echo',
          extensionPath: '/ext/a',
          provider: fakeProvider({
            getAvailableModels: async () => [
              makeModel('echo', 'echo-small'),
              makeModel('echo', 'echo-large'),
            ],
          }),
        },
      ]),
    ]);
    const composite = ctl.composite();
    const list = await composite.getAvailableModels();
    const keys = list.map(m => `${m.provider}:${m.id}`);
    expect(keys).toContain('echo:echo-small');
    expect(keys).toContain('echo:echo-large');
    expect(keys).toContain('bodhi:bodhi-a');
    expect(keys.filter(k => k === 'echo:echo-small').length).toBe(1);
  });

  test('composite.setAuthToken fans out to every provider and the base', () => {
    const calls: string[] = [];
    const base = fakeProvider({
      setAuthToken: cred => calls.push(`base:${cred?.token ?? 'null'}`),
    });
    const ctl = new ExtensionProviderController({ base, emitEvent: () => {} });
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          providerId: 'echo',
          extensionPath: '/ext/a',
          provider: fakeProvider({
            setAuthToken: cred => calls.push(`echo:${cred?.token ?? 'null'}`),
          }),
        },
      ]),
    ]);
    ctl.composite().setAuthToken!({ provider: 'bodhi', token: 'abc' });
    expect(calls.sort()).toEqual(['base:abc', 'echo:abc']);
  });

  test('churn emits extension_providers_changed with the new descriptor list', () => {
    const events: RpcEventEnvelope[] = [];
    const ctl = new ExtensionProviderController({
      base: fakeProvider(),
      emitEvent: ev => events.push(ev),
    });

    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          providerId: 'echo',
          extensionPath: '/ext/a',
          provider: fakeProvider(),
        },
      ]),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'extension_providers_changed' });

    // Setting an identical list should not emit a second event.
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          providerId: 'echo',
          extensionPath: '/ext/a',
          provider: fakeProvider(),
        },
      ]),
    ]);
    expect(events).toHaveLength(1);

    // Adding another provider emits again.
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          providerId: 'echo',
          extensionPath: '/ext/a',
          provider: fakeProvider(),
        },
      ]),
      makeExtension('/ext/b', [
        {
          providerId: 'fake',
          extensionPath: '/ext/b',
          provider: fakeProvider(),
        },
      ]),
    ]);
    expect(events).toHaveLength(2);
    const last = events[1] as { providers: Array<{ providerId: string }> };
    expect(last.providers.map(p => p.providerId).sort()).toEqual(['echo', 'fake']);

    // clear() emits once.
    ctl.clear();
    expect(events).toHaveLength(3);
    const cleared = events[2] as { providers: unknown[] };
    expect(cleared.providers).toEqual([]);

    // clear() again is a no-op.
    ctl.clear();
    expect(events).toHaveLength(3);
  });

  test('getAvailableModels logs and continues when an extension provider throws', async () => {
    const base = fakeProvider({
      getAvailableModels: async () => [makeModel('bodhi', 'bodhi-a')],
    });
    const ctl = new ExtensionProviderController({ base, emitEvent: () => {} });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    ctl.setFromExtensions([
      makeExtension('/ext/a', [
        {
          providerId: 'flaky',
          extensionPath: '/ext/a',
          provider: fakeProvider({
            getAvailableModels: async () => {
              throw new Error('boom');
            },
          }),
        },
      ]),
    ]);
    const models = await ctl.composite().getAvailableModels();
    expect(models.map(m => m.id)).toContain('bodhi-a');
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
