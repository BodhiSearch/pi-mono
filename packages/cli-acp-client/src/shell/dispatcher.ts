import { parseInputLine } from './parser';
import type { CommandRegistry } from './registry';
import type { AppContext } from './context';
import { formatErrorChain } from '../auth/debug';

/**
 * Single entry-point the renderer calls when the user submits a line of
 * input. Decides whether the line is a slash command (routed through
 * `CommandRegistry`) or a prompt (forwarded to the agent via the context's
 * `AcpClient`).
 *
 * Errors are caught and reported via `ctx.renderer.emit({ kind: 'error' })`
 * so a misbehaving command never crashes the shell loop.
 */

export interface Dispatcher {
  /**
   * Submit a single input line. Resolves once the command (or prompt)
   * has fully completed, including streaming responses.
   */
  submit(line: string): Promise<void>;
}

export function createDispatcher(
  ctx: AppContext,
  registry: CommandRegistry,
  onPrompt: (text: string) => Promise<void>
): Dispatcher {
  return {
    async submit(line: string): Promise<void> {
      const parsed = parseInputLine(line);
      if (parsed.kind === 'empty') return;
      try {
        if (parsed.kind === 'command') {
          const command = registry.get(parsed.name);
          if (!command) {
            ctx.renderer.emit({
              kind: 'error',
              text: `Unknown command: /${parsed.name}. Type /help for a list.`,
            });
            return;
          }
          await command.handler(ctx, parsed.args);
          return;
        }
        await onPrompt(parsed.text);
      } catch (err) {
        ctx.renderer.emit({ kind: 'error', text: formatErrorChain(err) });
        if (err instanceof Error && err.stack) {
          ctx.renderer.emit({ kind: 'error', text: err.stack });
        }
      }
    },
  };
}
