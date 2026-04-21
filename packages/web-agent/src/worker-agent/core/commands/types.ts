/**
 * Slash-command types for the web-agent Worker.
 *
 * Mirrors the shape of `packages/coding-agent/src/core/slash-commands.ts`
 * but trimmed to the sources web-agent currently supports. Skills and
 * extension-registered commands will expand `SlashCommandSource` in
 * later phases.
 */

export type SlashCommandSource = 'builtin' | 'prompt';

/**
 * Plain-data descriptor emitted over RPC for the main-thread autocomplete.
 *
 * No handler or file content — those remain on the side that produces them
 * (builtin side-effects on main, template bodies in the Worker registry).
 */
export interface SlashCommandInfo {
  name: string;
  description?: string;
  argumentHint?: string;
  source: SlashCommandSource;
}

/**
 * Built-in slash command metadata. Runs on the main thread (React UI
 * handlers). The Worker knows about them only so `list_commands` can
 * include them alongside prompt templates for a single autocomplete
 * source of truth.
 */
export interface BuiltinSlashCommand {
  name: string;
  description: string;
}

/**
 * A markdown prompt template loaded from `<vault>/.pi/prompts/*.md`.
 *
 * Shape mirrors coding-agent's `PromptTemplate` (core/prompt-templates.ts)
 * minus Node-specific fields (no `sourceInfo` package resolution; the
 * vault is the single source in browser).
 */
export interface PromptTemplate {
  name: string;
  description: string;
  argumentHint?: string;
  content: string;
  /** Absolute vault path the template was loaded from, e.g. `/vault/.pi/prompts/review.md`. */
  filePath: string;
}
