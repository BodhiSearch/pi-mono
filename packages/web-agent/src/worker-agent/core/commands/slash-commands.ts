/**
 * Built-in slash commands exposed by web-agent.
 *
 * This is the web subset of coding-agent's
 * `BUILTIN_SLASH_COMMANDS` (see
 * `packages/coding-agent/src/core/slash-commands.ts`). Commands whose
 * semantics only make sense for a TUI (`/quit`, `/hotkeys`,
 * `/settings`, `/share`, `/export`, `/import`, `/copy`,
 * `/scoped-models`, `/login`, `/logout`, `/changelog`) are omitted.
 *
 * Handlers live on the main thread (React UI) — see `useAgent.ts`. The
 * Worker only cares about this list for the unified `list_commands`
 * autocomplete surface.
 */

import type { BuiltinSlashCommand } from './types';

export const BUILTIN_SLASH_COMMANDS: ReadonlyArray<BuiltinSlashCommand> = [
  { name: 'help', description: 'Show available commands' },
  { name: 'model', description: 'Select a model (/model <id>) or list options' },
  { name: 'new', description: 'Start a new session' },
  { name: 'compact', description: 'Manually compact the session context' },
  { name: 'session', description: 'Show current session info' },
  { name: 'name', description: 'Set session display name' },
  { name: 'fork', description: 'Create a fork from a previous message' },
  { name: 'tree', description: 'Navigate session tree (switch branches)' },
  { name: 'resume', description: 'Resume a different session' },
  { name: 'reload', description: 'Reload prompt templates from the vault' },
];

export const BUILTIN_COMMAND_NAMES: ReadonlySet<string> = new Set(
  BUILTIN_SLASH_COMMANDS.map(c => c.name)
);
