import type { BuiltinCommand } from './types';

export const helpCommand: BuiltinCommand = {
  name: 'help',
  description: 'List every available slash command.',
  handler: (_args, ctx) => {
    const commands = [...ctx.advertisedCommands].sort((a, b) => a.name.localeCompare(b.name));
    if (commands.length === 0) {
      return { replyText: 'No slash commands are currently available.' };
    }
    const lines: string[] = ['**Available commands**', ''];
    for (const cmd of commands) {
      const hint = cmd.input?.hint ? ` _${cmd.input.hint}_` : '';
      lines.push(`- \`/${cmd.name}\`${hint} — ${cmd.description}`);
    }
    return { replyText: lines.join('\n') };
  },
};
