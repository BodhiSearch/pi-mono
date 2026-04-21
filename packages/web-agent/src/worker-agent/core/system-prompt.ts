/**
 * System-prompt assembly for the web-agent Worker.
 *
 * Browser-trimmed port of `packages/coding-agent/src/core/system-prompt.ts`.
 * Removes the Node-only bits (extension docs paths, `toolSnippets`
 * catalog, `promptGuidelines` plumbing) because web-agent has neither
 * an extension host nor filesystem-backed docs. Keeps the skills-block
 * append step so `/skill:<name>` and auto-invoked skills behave
 * identically across runtimes.
 *
 * Called from `WorkerAgentHost` on every vault mount / unmount /
 * reload — the registry owns the skill list and we rebuild the string
 * in one shot rather than patching in place.
 */

import { formatSkillsForPrompt, type Skill } from './commands/skills';

export interface BuildSystemPromptOptions {
  /** Custom system prompt text (overrides the default body). */
  customPrompt?: string;
  /** Working directory shown in the prompt footer, e.g. the vault mount. */
  cwd?: string;
  /** Loaded skills — gate-appended only when `hasReadTool` is true. */
  skills?: Skill[];
  /** Whether a `read` tool is wired; skills reference it for lazy SKILL.md load. */
  hasReadTool?: boolean;
  /** Override `new Date()` for tests; falls through to the live clock otherwise. */
  now?: Date;
}

const DEFAULT_BODY = `You are pi, a browser-native agent that helps users interact with a mounted vault of files using read, write, edit, ls, glob, grep, and any MCP tools the user has configured.

Guidelines:
- Be concise in your responses
- Show file paths clearly when working with files
- Prefer the dedicated vault tools (read, write, edit, ls, glob, grep) over generic shell commands for file operations`;

function formatDate(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Build the worker-owned system prompt.
 *
 * - `customPrompt` replaces the base body but still gets skills/cwd/date appended.
 * - Skills are appended only when both `skills.length > 0` and `hasReadTool` is true,
 *   matching coding-agent's `hasRead && skills.length > 0` gate in
 *   `packages/coding-agent/src/core/system-prompt.ts:163`.
 * - Working directory and date are always the last two lines so the LLM gets a
 *   fresh "current working directory" signal without running a tool.
 */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
  const { customPrompt, cwd, skills = [], hasReadTool = true, now = new Date() } = options;
  const date = formatDate(now);
  const promptCwd = cwd ? cwd.replace(/\\/g, '/') : '';

  let prompt = customPrompt ?? DEFAULT_BODY;

  if (hasReadTool && skills.length > 0) {
    prompt += formatSkillsForPrompt(skills);
  }

  prompt += `\nCurrent date: ${date}`;
  if (promptCwd) {
    prompt += `\nCurrent working directory: ${promptCwd}`;
  }

  return prompt;
}
