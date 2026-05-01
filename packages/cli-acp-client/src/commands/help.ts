import type { SlashCommand } from '../shell/registry';
import type { CommandRegistry } from '../shell/registry';

export function buildHelpCommand(registry: CommandRegistry): SlashCommand {
  return {
    name: 'help',
    description: 'List all slash commands.',
    aliases: ['?'],
    async handler(ctx) {
      ctx.renderer.renderHelp(registry.summaries());
    },
  };
}
