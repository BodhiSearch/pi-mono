import type { BuiltinCommand } from './types';

export const versionCommand: BuiltinCommand = {
  name: 'version',
  description: 'Show the web-acp build, ACP SDK, model, and Bodhi server URL.',
  handler: (_args, ctx) => {
    const lines = [
      '**Version**',
      '',
      `- web-acp: \`${ctx.buildVersion}\``,
      `- ACP SDK: \`${ctx.acpSdkVersion}\``,
      `- Model: \`${ctx.modelId ?? '(none selected)'}\``,
      `- Bodhi server: \`${ctx.serverUrl ?? '(not connected)'}\``,
    ];
    return { replyText: lines.join('\n') };
  },
};
