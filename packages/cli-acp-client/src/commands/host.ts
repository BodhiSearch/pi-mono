import type { SlashCommand } from '../shell/registry';
import { setStatus } from '../shell/context';
import { runLogin } from './login';

export const hostCommand: SlashCommand = {
  name: 'host',
  description: 'Set the BodhiApp host URL and trigger /login.',
  usage: '/host <url>   e.g. /host http://localhost:1135',
  async handler(ctx, args) {
    const [url] = args;
    if (!url) {
      ctx.renderer.emit({
        kind: 'error',
        text: 'Usage: /host <url>',
      });
      return;
    }
    let normalized: string;
    try {
      // Tolerate bare host:port input (`localhost:1135`) — `new URL`
      // would otherwise parse it with `localhost:` as the scheme. We
      // also reject protocol-less inputs that look like authority but
      // don't normalize cleanly.
      const candidate = looksLikeAuthority(url) ? `http://${url}` : url;
      const parsed = new URL(candidate);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`unsupported protocol ${parsed.protocol}`);
      }
      normalized = stripTrailingSlash(parsed.toString());
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      ctx.renderer.emit({
        kind: 'error',
        text: `Invalid URL: ${url} — ${reason}. Examples: http://localhost:1135, https://my.bodhi.example.com.`,
      });
      return;
    }

    const current = await ctx.settings.load();
    if (current.host !== normalized) {
      await ctx.settings.patch({ host: normalized, tokens: undefined });
      ctx.tokens = null;
    } else {
      await ctx.settings.patch({ host: normalized });
    }
    setStatus(ctx, { kind: 'disconnected', reason: 'host updated' });
    ctx.renderer.emit({
      kind: 'info',
      text: `Host set to ${normalized}. Starting /login flow...`,
    });
    await runLogin(ctx);
  },
};

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * `new URL('localhost:1135')` parses with `localhost:` as the scheme,
 * which is almost never what the user means. Detect bare authority
 * input (`hostname[:port]` or `127.0.0.1:port`) so we can prepend
 * `http://` before parsing.
 */
function looksLikeAuthority(value: string): boolean {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) return false;
  return /^[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(value);
}
