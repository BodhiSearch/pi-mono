import type { SlashCommand } from '../shell/registry';

export const QUIT_SIGNAL = Symbol('cli-acp-client:quit');

export interface QuitController {
  request(): void;
  readonly requested: () => boolean;
}

export function createQuitController(onQuit: () => void): QuitController {
  let pending = false;
  return {
    request(): void {
      if (pending) return;
      pending = true;
      onQuit();
    },
    requested(): boolean {
      return pending;
    },
  };
}

export function buildQuitCommand(controller: QuitController): SlashCommand {
  return {
    name: 'quit',
    description: 'Exit the CLI.',
    aliases: ['exit', 'q'],
    async handler(ctx) {
      ctx.renderer.emit({ kind: 'info', text: 'Goodbye.' });
      controller.request();
    },
  };
}
