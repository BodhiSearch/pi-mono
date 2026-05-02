import type { SlashCommand } from '../shell/registry';
import { setStatus } from '../shell/context';
import { KV_LAST_MODEL_ID } from '../storage/kv-keys';

export const modelsCommand: SlashCommand = {
  name: 'models',
  description: 'List models available on the connected BodhiApp host.',
  async handler(ctx) {
    if (ctx.status.kind !== 'authenticated') {
      ctx.renderer.emit({
        kind: 'error',
        text: 'Not authenticated. Run /host <url> then /login first.',
      });
      return;
    }
    const models = await ctx.client.listModels();
    if (models.length === 0) {
      ctx.renderer.emit({ kind: 'info', text: 'No models registered on this host.' });
      return;
    }
    const lines = models.map(m => `  ${m.id}   (${m.apiFormat})`);
    const active = ctx.modelId ? `  active: ${ctx.modelId}\n` : '';
    ctx.renderer.emit({
      kind: 'info',
      text: `Available models (${models.length}):\n${lines.join('\n')}\n${active}`.trimEnd(),
    });
  },
};

export const modelCommand: SlashCommand = {
  name: 'model',
  description: 'Set the active model id for subsequent prompts.',
  usage: '/model <id>',
  async handler(ctx, args) {
    const [id] = args;
    if (!id) {
      ctx.renderer.emit({
        kind: 'info',
        text: ctx.modelId
          ? `Current model: ${ctx.modelId}`
          : 'No model selected. Run /models to list options.',
      });
      return;
    }
    ctx.modelId = id;
    ctx.host.kv.set(KV_LAST_MODEL_ID, id);
    if (ctx.status.kind === 'authenticated') {
      setStatus(ctx, { ...ctx.status, modelId: id });
    }
    ctx.renderer.emit({ kind: 'info', text: `Active model set to ${id}.` });
  },
};
