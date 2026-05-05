export default function customProviderAnthropic(pi) {
  pi.registerProvider('custom-anthropic', {
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'CUSTOM_ANTHROPIC_API_KEY',
    api: 'anthropic-messages',
    authHeader: false,
    headers: {
      'anthropic-version': '2023-06-01',
    },
    models: [
      {
        id: 'claude-opus-4-5',
        name: 'Claude Opus 4.5 (Custom)',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
      {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5 (Custom)',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
        maxTokens: 64000,
      },
    ],
    oauth: {
      name: 'Custom Anthropic (Claude Pro/Max)',
      async login(callbacks) {
        callbacks.onAuth({ url: 'https://claude.ai/oauth/authorize?stub=true' });
        const code = await callbacks.onPrompt({
          message: 'Paste the authorization code:',
        });
        return {
          access: code,
          refresh: code,
          expires: Date.now() + 60 * 60 * 1000,
        };
      },
      async refreshToken(credentials) {
        return credentials;
      },
      getApiKey(credentials) {
        return credentials.access;
      },
    },
  });
}
