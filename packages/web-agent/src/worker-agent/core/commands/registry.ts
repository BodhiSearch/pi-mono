/**
 * Worker-side command registry.
 *
 * Holds the currently loaded prompt templates and skills and exposes a
 * unified listing (builtins + prompts + skills) that the main thread
 * consumes via the `list_commands` RPC for its autocomplete palette.
 * Template bodies and SKILL.md contents never cross the wire — only
 * `SlashCommandInfo` descriptors.
 *
 * Template expansion is pure and synchronous (`prompt-templates.ts`).
 * Skill expansion is async because `SKILL.md` content is re-read from
 * the vault at expansion time, matching coding-agent's
 * `_expandSkillCommand` behaviour so edits to a skill take effect on
 * the next invocation without a separate reload.
 */

import type { ReadOperations } from '../../fs/zenfs-operations';
import type {
  RegisteredCommand as ExtensionRegisteredCommand,
  RegisteredSkill as ExtensionRegisteredSkill,
} from '../extensions/types';
import {
  expandPromptTemplate as expandPromptTemplatePure,
  loadPromptTemplatesFromDir,
  type PromptTemplateLoaderOps,
} from './prompt-templates';
import {
  loadSkillsFromVault,
  stripSkillFrontmatter,
  type Skill,
  type SkillDiagnostic,
  type SkillLoaderOps,
} from './skills';
import { BUILTIN_SLASH_COMMANDS } from './slash-commands';
import type { PromptTemplate, SlashCommandInfo } from './types';

const PROMPTS_DIR_SEGMENT = '.pi/prompts';
const DECODER = new TextDecoder();

function joinPromptsDir(mount: string): string {
  const trimmed = mount.endsWith('/') ? mount.slice(0, -1) : mount;
  return `${trimmed}/${PROMPTS_DIR_SEGMENT}`;
}

export class CommandRegistry {
  private promptTemplates: PromptTemplate[] = [];
  private skills: Skill[] = [];
  private skillDiagnostics: SkillDiagnostic[] = [];
  /**
   * Commands contributed by loaded extensions. The handler closure stays
   * in the worker — only the `SlashCommandInfo` descriptor crosses RPC.
   * Collisions with builtins / prompts / skills are resolved first-found
   * in `list()` order (builtin > prompt > skill > extension) to match
   * coding-agent's precedence.
   */
  private extensionCommands: ExtensionRegisteredCommand[] = [];
  /**
   * Skills contributed by extensions via `pi.registerSkill`. Stored
   * in-memory (no SKILL.md file on disk). Listed under
   * `source: 'extension-skill'` and expanded by `expandSkill` using the
   * stored `body` directly.
   */
  private extensionSkills: ExtensionRegisteredSkill[] = [];

  /**
   * Load `<vaultMount>/.pi/prompts/*.md` into the registry, replacing
   * any previously loaded templates. Missing directories are a no-op
   * (the common fresh-vault case).
   */
  async loadPromptsFromVault(ops: PromptTemplateLoaderOps, vaultMount: string): Promise<void> {
    this.promptTemplates = await loadPromptTemplatesFromDir(joinPromptsDir(vaultMount), ops);
  }

  /**
   * Load `<vaultMount>/.pi/skills/<name>/SKILL.md` descriptors, replacing
   * any previously loaded skills. Diagnostics from validation /
   * collision checks are stored alongside so the worker host can log
   * them after the scan.
   */
  async loadSkillsFromVault(ops: SkillLoaderOps, vaultMount: string): Promise<void> {
    const result = await loadSkillsFromVault(ops, vaultMount);
    this.skills = result.skills;
    this.skillDiagnostics = result.diagnostics;
  }

  /** Drop all loaded prompt templates (e.g. on vault unmount). */
  clearPrompts(): void {
    this.promptTemplates = [];
  }

  /** Drop all loaded skills (e.g. on vault unmount). */
  clearSkills(): void {
    this.skills = [];
    this.skillDiagnostics = [];
  }

  /** Drop all extension-registered commands (e.g. when the runner clears). */
  clearExtensionCommands(): void {
    this.extensionCommands = [];
  }

  /** Replace the extension-command set in one shot (called from the runner). */
  setExtensionCommands(commands: ExtensionRegisteredCommand[]): void {
    this.extensionCommands = commands;
  }

  /** Drop all extension-registered skills (e.g. when the runner clears). */
  clearExtensionSkills(): void {
    this.extensionSkills = [];
  }

  /** Replace the extension-skill set in one shot (called from the runner). */
  setExtensionSkills(skills: ExtensionRegisteredSkill[]): void {
    this.extensionSkills = skills;
  }

  /** Drop prompt templates, skills, extension commands, and extension skills. */
  clearAll(): void {
    this.clearPrompts();
    this.clearSkills();
    this.clearExtensionCommands();
    this.clearExtensionSkills();
  }

  /**
   * Plain-data listing for RPC. Order: builtins, prompt templates,
   * skills — so the autocomplete palette surfaces builtins first.
   *
   * Skills with `disableModelInvocation` are still listed (coding-agent
   * parity) so a user can invoke them explicitly; the flag is carried
   * along for the UI to render a hint.
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
    const skills: SlashCommandInfo[] = this.skills.map(s => ({
      name: `skill:${s.name}`,
      description: s.description,
      source: 'skill',
      disableModelInvocation: s.disableModelInvocation,
    }));
    const extensions: SlashCommandInfo[] = this.extensionCommands.map(c => ({
      name: c.name,
      ...(c.description ? { description: c.description } : {}),
      ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
      source: 'extension',
    }));
    const extensionSkills: SlashCommandInfo[] = this.extensionSkills.map(s => ({
      name: `skill:${s.name}`,
      description: s.description,
      source: 'extension-skill',
      disableModelInvocation: s.disableModelInvocation,
    }));
    return [...builtins, ...prompts, ...skills, ...extensions, ...extensionSkills];
  }

  getPromptTemplates(): PromptTemplate[] {
    return this.promptTemplates;
  }

  getSkills(): Skill[] {
    return this.skills;
  }

  getSkillDiagnostics(): SkillDiagnostic[] {
    return this.skillDiagnostics;
  }

  findTemplate(name: string): PromptTemplate | null {
    return this.promptTemplates.find(t => t.name === name) ?? null;
  }

  findSkill(name: string): Skill | null {
    return this.skills.find(s => s.name === name) ?? null;
  }

  findExtensionSkill(name: string): ExtensionRegisteredSkill | null {
    return this.extensionSkills.find(s => s.name === name) ?? null;
  }

  findExtensionCommand(name: string): ExtensionRegisteredCommand | null {
    return this.extensionCommands.find(c => c.name === name) ?? null;
  }

  getExtensionCommands(): ExtensionRegisteredCommand[] {
    return this.extensionCommands;
  }

  getExtensionSkills(): ExtensionRegisteredSkill[] {
    return this.extensionSkills;
  }

  /**
   * Convenience wrapper: expand `text` against the currently loaded
   * templates, or return it unchanged when no template matches (or
   * when `text` doesn't start with `/`).
   *
   * Does NOT expand `/skill:<name>` commands — use `expandSkill` for
   * that (it needs async vault access).
   */
  expand(text: string): string {
    return expandPromptTemplatePure(text, this.promptTemplates);
  }

  /**
   * Expand `/skill:<name> [args]` into a `<skill>` block by reading the
   * referenced SKILL.md via the vault. Mirrors coding-agent's
   * `_expandSkillCommand` in `agent-session.ts`.
   *
   * Returns the original text unchanged when:
   * - `text` doesn't start with `/skill:`
   * - the skill name is unknown
   * - SKILL.md can no longer be read (skill was deleted between scan
   *   and invocation)
   */
  async expandSkill(text: string, readOps: Pick<ReadOperations, 'readFile'>): Promise<string> {
    if (!text.startsWith('/skill:')) return text;

    const spaceIndex = text.indexOf(' ');
    const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
    const args = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1).trim();

    // Extension skills win when names collide so authors can override
    // a vault skill by registering their own. In-memory body means no
    // readFile round-trip.
    const extSkill = this.findExtensionSkill(skillName);
    if (extSkill) {
      const body = extSkill.body.trim();
      const skillBlock = `<skill name="${extSkill.name}" location="extension:${extSkill.extensionPath}">\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
    }

    const skill = this.findSkill(skillName);
    if (!skill) return text;

    let content: string;
    try {
      const bytes = await readOps.readFile(skill.filePath);
      content = DECODER.decode(bytes);
    } catch {
      return text;
    }

    const body = stripSkillFrontmatter(content).trim();
    const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
    return args ? `${skillBlock}\n\n${args}` : skillBlock;
  }

  /**
   * Expand both skills (async) and prompt templates (sync) in one
   * call, mirroring coding-agent's `_expandSkillCommand` + `expandPromptTemplate`
   * pipeline in `agent-session.ts:prompt`.
   */
  async expandAsync(text: string, readOps: Pick<ReadOperations, 'readFile'>): Promise<string> {
    const afterSkill = await this.expandSkill(text, readOps);
    return this.expand(afterSkill);
  }
}
