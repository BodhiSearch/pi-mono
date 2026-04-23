// Echo-provider extension — exercises `pi.registerProvider`.
//
// Contributes a fake LLM provider whose `getAvailableModels` returns a
// canned `Model` list. The main thread refreshes the model picker on
// `extension_providers_changed`, so the e2e spec can assert these
// models show up without ever calling a real LLM.
//
// The provider intentionally rejects `getApiKeyAndHeaders` so a stray
// streaming call fails loudly; the spec only asserts catalog state.
export default function echoProviderExtension(pi) {
  const PROVIDER_ID = 'echo';

  const models = [
    {
      id: 'echo-small',
      provider: PROVIDER_ID,
      name: 'Echo Small',
      api: 'openai-completions',
      baseUrl: 'https://invalid.local/echo',
      reasoning: false,
      contextWindow: 1024,
      maxTokens: 256,
    },
    {
      id: 'echo-large',
      provider: PROVIDER_ID,
      name: 'Echo Large',
      api: 'openai-completions',
      baseUrl: 'https://invalid.local/echo',
      reasoning: false,
      contextWindow: 4096,
      maxTokens: 1024,
    },
  ];

  pi.registerProvider(PROVIDER_ID, {
    async getApiKeyAndHeaders() {
      throw new Error('echo-provider is catalog-only; no real streaming.');
    },
    async getAvailableModels() {
      return models;
    },
    setAuthToken() {
      // No-op; the echo provider has no rotating credentials.
    },
  });

  pi.registerCommand('echo-provider-ping', {
    description: 'Surface the contributed model ids via a toast.',
    handler: (_args, ctx) => {
      const ids = models.map(m => m.id).join(',');
      ctx.ui.notify(`echo-provider: ${ids}`, 'info');
    },
  });
}
