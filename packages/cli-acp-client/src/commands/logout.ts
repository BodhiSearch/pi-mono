import type { SlashCommand } from '../shell/registry';
import { setStatus } from '../shell/context';
import { revokeRefreshToken } from '../auth/token-exchange';
import { DEFAULT_AUTH_SERVER_URL } from '../auth/config';

export const logoutCommand: SlashCommand = {
  name: 'logout',
  description: 'Clear stored tokens and reset the embedded agent auth.',
  async handler(ctx) {
    const settings = await ctx.settings.load();
    if (settings.tokens?.refreshToken) {
      await revokeRefreshToken(
        settings.authServerUrl ?? DEFAULT_AUTH_SERVER_URL,
        settings.tokens.refreshToken
      );
    }
    await ctx.settings.patch({ tokens: undefined });
    ctx.tokens = null;
    ctx.sessionId = null;
    setStatus(ctx, { kind: 'disconnected', reason: 'logged out' });
    ctx.renderer.emit({ kind: 'info', text: 'Logged out.' });
  },
};
