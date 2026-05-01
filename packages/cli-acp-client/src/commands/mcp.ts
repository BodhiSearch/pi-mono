import type { SlashCommand } from '../shell/registry';

/**
 * `/mcp` user-facing surface. v0 manages the persisted "requested MCPs"
 * list locally — the agent-side `/mcp` builtin (inside web-acp-agent)
 * does the rendering during a turn. We only need a flat command here
 * for the user to manage their wishlist outside a prompt.
 */
export const mcpCommand: SlashCommand = {
  name: 'mcp',
  description: 'Manage the MCP server wishlist sent with /login.',
  usage: '/mcp [list|add <url>|remove <url>]',
  async handler(ctx, args) {
    const [sub, ...rest] = args;
    const action = sub ?? 'list';
    const settings = await ctx.settings.load();
    const current = settings.requestedMcps;
    switch (action) {
      case 'list':
      case 'ls': {
        if (current.length === 0) {
          ctx.renderer.emit({ kind: 'info', text: 'No MCP servers configured.' });
          return;
        }
        ctx.renderer.emit({
          kind: 'info',
          text:
            `Requested MCP servers (${current.length}):\n` + current.map(u => `  ${u}`).join('\n'),
        });
        return;
      }
      case 'add': {
        const [url] = rest;
        if (!url) {
          ctx.renderer.emit({ kind: 'error', text: 'Usage: /mcp add <url>' });
          return;
        }
        if (current.includes(url)) {
          ctx.renderer.emit({ kind: 'info', text: `Already in list: ${url}` });
          return;
        }
        const next = [...current, url];
        await ctx.settings.patch({ requestedMcps: next });
        ctx.renderer.emit({
          kind: 'info',
          text: `Added ${url}. Run /login to refresh the access-request scope.`,
        });
        return;
      }
      case 'remove':
      case 'rm': {
        const [url] = rest;
        if (!url) {
          ctx.renderer.emit({ kind: 'error', text: 'Usage: /mcp remove <url>' });
          return;
        }
        if (!current.includes(url)) {
          ctx.renderer.emit({ kind: 'info', text: `Not in list: ${url}` });
          return;
        }
        const next = current.filter(entry => entry !== url);
        await ctx.settings.patch({ requestedMcps: next });
        ctx.renderer.emit({
          kind: 'info',
          text: `Removed ${url}. Run /login to refresh.`,
        });
        return;
      }
      default:
        ctx.renderer.emit({
          kind: 'error',
          text: `Unknown /mcp action '${action}'. Try /mcp list|add|remove.`,
        });
    }
  },
};
