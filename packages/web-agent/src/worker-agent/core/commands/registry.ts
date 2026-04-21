/**
 * Worker-side command registry.
 *
 * Holds the currently loaded prompt templates and exposes a unified
 * listing (builtins + prompts) that the main thread consumes via the
 * `list_commands` RPC for its autocomplete palette. Template bodies
 * never cross the wire — only `SlashCommandInfo` descriptors.
 *
 * Template expansion (invoked from the prompt pipeline) uses
 * `findTemplate` + `expandPromptTemplate` from `prompt-templates.ts`.
 */

import {
  expandPromptTemplate as expandPromptTemplatePure,
  loadPromptTemplatesFromDir,
  type PromptTemplateLoaderOps,
} from './prompt-templates';
import { BUILTIN_SLASH_COMMANDS } from './slash-commands';
import type { PromptTemplate, SlashCommandInfo } from './types';

const PROMPTS_DIR_SEGMENT = '.pi/prompts';

function joinPromptsDir(mount: string): string {
  const trimmed = mount.endsWith('/') ? mount.slice(0, -1) : mount;
  return `${trimmed}/${PROMPTS_DIR_SEGMENT}`;
}

export class CommandRegistry {
  private promptTemplates: PromptTemplate[] = [];

  /**
   * Load `<vaultMount>/.pi/prompts/*.md` into the registry, replacing
   * any previously loaded templates. Missing directories are a no-op
   * (the common fresh-vault case).
   */
  async loadPromptsFromVault(ops: PromptTemplateLoaderOps, vaultMount: string): Promise<void> {
    this.promptTemplates = await loadPromptTemplatesFromDir(joinPromptsDir(vaultMount), ops);
  }

  /** Drop all loaded prompt templates (e.g. on vault unmount). */
  clearPrompts(): void {
    this.promptTemplates = [];
  }

  /**
   * Plain-data listing for RPC. Builtins are listed first so the
   * autocomplete palette surfaces them above user-authored prompts.
   */
  list(): SlashCommandInfo[] {
    const builtins: SlashCommandInfo[] = BUILTIN_SLASH_COMMANDS.map(cmd => ({
      name: cmd.name,
      description: cmd.description,
      source: 'builtin',
    }));
    const prompts: SlashCommandInfo[] = this.promptTemplates.map(t => ({
      name: t.name,
      description: t.description,
      ...(t.argumentHint ? { argumentHint: t.argumentHint } : {}),
      source: 'prompt',
    }));
    return [...builtins, ...prompts];
  }

  getPromptTemplates(): PromptTemplate[] {
    return this.promptTemplates;
  }

  findTemplate(name: string): PromptTemplate | null {
    return this.promptTemplates.find(t => t.name === name) ?? null;
  }

  /**
   * Convenience wrapper: expand `text` against the currently loaded
   * templates, or return it unchanged when no template matches (or
   * when `text` doesn't start with `/`).
   */
  expand(text: string): string {
    return expandPromptTemplatePure(text, this.promptTemplates);
  }
}
