import { parseInputLine } from './parser';
import type { CommandRegistry } from './registry';
import type { AppContext } from './context';
import { formatErrorChain } from '../auth/debug';

/**
 * Single entry-point the renderer calls when the user submits a line of
 * input. Decides whether the line is a CLI-shell command (routed through
 * `CommandRegistry`), an unknown `/<cmd>` (forwarded to the agent so vault
 * commands and agent built-ins like `/info`, `/copy`, `/mcp`, `/help`,
 * `/version` work), or a plain prompt (forwarded to the agent's LLM).
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
          if (command) {
            await command.handler(ctx, parsed.args);
            return;
          }
          // Fall-through: unknown CLI-shell command. Forward the raw
          // `/<cmd> <args>` line to the agent so vault commands
          // (`/wiki:greet alice`) and agent built-ins (`/info`,
          // `/copy`, `/mcp`, `/help`, `/version`) work.
          await onPrompt(parsed.raw);
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
