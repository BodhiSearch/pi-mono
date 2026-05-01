import type { AppContext } from './context';
import type { SlashCommandSummary } from './types';

export interface SlashCommand {
  name: string;
  /** One-line summary surfaced by `/help` and the autocomplete provider. */
  description: string;
  /** Optional usage line, e.g. `/mcp add <url>`. */
  usage?: string;
  /** Aliases (e.g. `/q` for `/quit`). */
  aliases?: string[];
  /** Hidden from `/help` listings (still dispatchable). */
  hidden?: boolean;
  handler(ctx: AppContext, args: string[]): Promise<void>;
}

export class CommandRegistry {
  readonly #byName = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.#byName.set(command.name, command);
    for (const alias of command.aliases ?? []) {
      this.#byName.set(alias, command);
    }
  }

  registerAll(commands: SlashCommand[]): void {
    for (const command of commands) this.register(command);
  }

  get(name: string): SlashCommand | undefined {
    return this.#byName.get(name);
  }

  /** All registered names (canonical + aliases), unique. */
  names(): string[] {
    return [...new Set(this.#byName.keys())].sort();
  }

  /** Visible commands deduped by canonical name. */
  visible(): SlashCommand[] {
    const seen = new Set<SlashCommand>();
    const out: SlashCommand[] = [];
    for (const cmd of this.#byName.values()) {
      if (cmd.hidden) continue;
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      out.push(cmd);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  summaries(): SlashCommandSummary[] {
    return this.visible().map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      usage: cmd.usage,
    }));
  }
}
