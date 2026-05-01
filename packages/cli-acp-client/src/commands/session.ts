import type { SlashCommand } from '../shell/registry';

export const sessionCommand: SlashCommand = {
  name: 'session',
  description: 'Inspect or switch ACP sessions.',
  usage: '/session [list|new|load <id>|delete <id>]',
  async handler(ctx, args) {
    const [sub, ...rest] = args;
    const action = sub ?? 'list';
    switch (action) {
      case 'list': {
        const sessions = await ctx.client.listSessions();
        if (sessions.length === 0) {
          ctx.renderer.emit({ kind: 'info', text: 'No sessions yet.' });
          return;
        }
        const lines = sessions.map(
          s => `  ${s.id.slice(0, 12)}…  turns=${s.turnCount}  ${s.title ?? '(untitled)'}`
        );
        ctx.renderer.emit({
          kind: 'info',
          text: `Sessions (${sessions.length}):\n${lines.join('\n')}`,
        });
        return;
      }
      case 'new': {
        const result = await ctx.client.newSession(ctx.cwd, ctx.composedMcpServers);
        ctx.sessionId = result.sessionId;
        ctx.renderer.emit({
          kind: 'info',
          text: `Created session ${result.sessionId}`,
        });
        return;
      }
      case 'load': {
        const [id] = rest;
        if (!id) {
          ctx.renderer.emit({ kind: 'error', text: 'Usage: /session load <id>' });
          return;
        }
        await ctx.client.loadSession(id, ctx.cwd, ctx.composedMcpServers);
        ctx.sessionId = id;
        ctx.renderer.emit({ kind: 'info', text: `Loaded session ${id}` });
        return;
      }
      case 'delete':
      case 'rm': {
        const [id] = rest;
        if (!id) {
          ctx.renderer.emit({ kind: 'error', text: 'Usage: /session delete <id>' });
          return;
        }
        const deleted = await ctx.client.deleteSession(id);
        ctx.renderer.emit({
          kind: 'info',
          text: deleted ? `Deleted session ${id}` : `No session ${id}`,
        });
        if (deleted && ctx.sessionId === id) ctx.sessionId = null;
        return;
      }
      default:
        ctx.renderer.emit({
          kind: 'error',
          text: `Unknown /session action '${action}'.`,
        });
    }
  },
};
