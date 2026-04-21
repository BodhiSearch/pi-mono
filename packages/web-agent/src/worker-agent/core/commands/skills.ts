/**
 * Browser-native port of coding-agent's skill loader.
 *
 * Coding-agent (see `packages/coding-agent/src/core/skills.ts`) scans
 * three tiers of filesystem locations (`~/.pi/agent/skills/`, project
 * `.pi/skills/`, explicit `--skill` paths) using Node `fs`/`path` APIs.
 * Web-agent runs in the browser with a single mounted ZenFS vault, so
 * this module trims the discovery down to a single scan of
 * `<vaultMount>/.pi/skills/` and swaps synchronous Node filesystem
 * calls for the narrow `VaultOperations` seam used by prompt-template
 * loading.
 *
 * Validation rules (name length, character set, description presence,
 * `disable-model-invocation`, name-collision handling) match the
 * Agent Skills specification (https://agentskills.io/specification)
 * byte-for-byte so skills authored for coding-agent render identically.
 */

import type { LsOperations, ReadOperations } from '../../fs/zenfs-operations';
import { parseFrontmatter } from './frontmatter';

const DECODER = new TextDecoder();

/** Max name length per Agent Skills spec. */
export const MAX_NAME_LENGTH = 64;

/** Max description length per Agent Skills spec. */
export const MAX_DESCRIPTION_LENGTH = 1024;

/** Sub-path (relative to the vault mount) that holds skill folders. */
export const SKILLS_DIR_SEGMENT = '.pi/skills';

/**
 * Narrow fs surface the loader needs. Intentionally a subset of
 * `VaultOperations` so tests can wire an in-memory fake without
 * building the full glob/grep/edit/write stack.
 */
export interface SkillLoaderOps {
  ls: Pick<LsOperations, 'stat' | 'readdir'>;
  read: Pick<ReadOperations, 'readFile'>;
}

export interface Skill {
  /** Canonical skill name (from frontmatter or falls back to parent dir). */
  name: string;
  /** Single-line description surfaced to the model in the system prompt. */
  description: string;
  /** Absolute vault path to the `SKILL.md` file. */
  filePath: string;
  /** Absolute vault path to the directory containing `SKILL.md`. */
  baseDir: string;
  /** When true, skill is hidden from the system prompt (palette still lists it). */
  disableModelInvocation: boolean;
}

export type SkillDiagnosticType = 'warning' | 'collision';

export interface SkillDiagnostic {
  type: SkillDiagnosticType;
  message: string;
  path: string;
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

/**
 * Validate skill name per Agent Skills spec.
 * Returns an array of validation errors; empty when valid.
 */
function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];

  if (name !== parentDirName) {
    errors.push(`name "${name}" does not match parent directory "${parentDirName}"`);
  }

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push('name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)');
  }

  if (name.startsWith('-') || name.endsWith('-')) {
    errors.push('name must not start or end with a hyphen');
  }

  if (name.includes('--')) {
    errors.push('name must not contain consecutive hyphens');
  }

  return errors;
}

/** Validate description per Agent Skills spec. */
function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];
  if (!description || description.trim() === '') {
    errors.push('description is required');
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
  }
  return errors;
}

function joinPath(dir: string, child: string): string {
  return dir.endsWith('/') ? `${dir}${child}` : `${dir}/${child}`;
}

function basename(path: string): string {
  const trimmed = path.endsWith('/') ? path.slice(0, -1) : path;
  const idx = trimmed.lastIndexOf('/');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function parseSkillFrontmatterValue(raw: string): string | boolean | undefined {
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed;
}

/**
 * Load a single `SKILL.md` and return either a `Skill` plus diagnostics,
 * or `null` when the file is unreadable / unparseable / missing its
 * required description.
 */
async function loadSkillFromFile(
  filePath: string,
  ops: SkillLoaderOps
): Promise<{ skill: Skill | null; diagnostics: SkillDiagnostic[] }> {
  const diagnostics: SkillDiagnostic[] = [];

  let rawContent: string;
  try {
    const bytes = await ops.read.readFile(filePath);
    rawContent = DECODER.decode(bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to read SKILL.md';
    diagnostics.push({ type: 'warning', message, path: filePath });
    return { skill: null, diagnostics };
  }

  const { frontmatter } = parseFrontmatter(rawContent);
  const lastSlash = filePath.lastIndexOf('/');
  const skillDir = lastSlash === -1 ? '' : filePath.slice(0, lastSlash);
  const parentDirName = basename(skillDir);

  const description = frontmatter.description ?? '';

  for (const error of validateDescription(description)) {
    diagnostics.push({ type: 'warning', message: error, path: filePath });
  }

  const name = frontmatter.name || parentDirName;

  for (const error of validateName(name, parentDirName)) {
    diagnostics.push({ type: 'warning', message: error, path: filePath });
  }

  if (!description || description.trim() === '') {
    return { skill: null, diagnostics };
  }

  const disableRaw = parseSkillFrontmatterValue(frontmatter['disable-model-invocation'] ?? '');

  return {
    skill: {
      name,
      description,
      filePath,
      baseDir: skillDir,
      disableModelInvocation: disableRaw === true,
    },
    diagnostics,
  };
}

/**
 * Recursively walk a skills root directory.
 *
 * Discovery rules (ported from coding-agent):
 * - If a directory contains `SKILL.md`, treat it as a skill root and stop recursing.
 * - Otherwise, recurse into child directories looking for `SKILL.md`.
 * - Files other than `SKILL.md` are ignored at any depth.
 * - Names starting with `.` are skipped.
 */
async function walkSkills(
  dir: string,
  ops: SkillLoaderOps,
  skills: Skill[],
  diagnostics: SkillDiagnostic[]
): Promise<void> {
  let entries: string[];
  try {
    entries = await ops.ls.readdir(dir);
  } catch {
    return;
  }

  // If this dir contains a SKILL.md, load it and stop.
  if (entries.includes('SKILL.md')) {
    const fullPath = joinPath(dir, 'SKILL.md');
    try {
      const s = await ops.ls.stat(fullPath);
      if (s.isFile()) {
        const { skill, diagnostics: diag } = await loadSkillFromFile(fullPath, ops);
        diagnostics.push(...diag);
        if (skill) skills.push(skill);
        return;
      }
    } catch {
      // fall through to recursion
    }
  }

  for (const entry of entries) {
    if (entry.startsWith('.') || entry === 'node_modules') continue;
    const fullPath = joinPath(dir, entry);
    let isDir = false;
    try {
      const s = await ops.ls.stat(fullPath);
      isDir = s.isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      await walkSkills(fullPath, ops, skills, diagnostics);
    }
  }
}

/**
 * Scan `<vaultMount>/.pi/skills/` for `SKILL.md` files and return them
 * as validated `Skill` descriptors plus any validation diagnostics.
 *
 * Missing directories yield an empty result — a vault without a
 * skills folder is the common fresh-vault case.
 *
 * Name collisions are resolved first-found-wins, matching
 * coding-agent's multi-tier behaviour. The losers are surfaced as
 * `collision` diagnostics so the UI can surface them later.
 */
export async function loadSkillsFromVault(
  ops: SkillLoaderOps,
  vaultMount: string
): Promise<LoadSkillsResult> {
  const trimmed = vaultMount.endsWith('/') ? vaultMount.slice(0, -1) : vaultMount;
  const root = `${trimmed}/${SKILLS_DIR_SEGMENT}`;
  const collected: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  try {
    const s = await ops.ls.stat(root);
    if (!s.isDirectory()) return { skills: [], diagnostics };
  } catch {
    return { skills: [], diagnostics };
  }

  await walkSkills(root, ops, collected, diagnostics);

  const byName = new Map<string, Skill>();
  for (const skill of collected) {
    const existing = byName.get(skill.name);
    if (existing) {
      diagnostics.push({
        type: 'collision',
        message: `name "${skill.name}" collides with ${existing.filePath}`,
        path: skill.filePath,
      });
      continue;
    }
    byName.set(skill.name, skill);
  }

  const skills = Array.from(byName.values()).sort((a, b) => a.name.localeCompare(b.name));
  return { skills, diagnostics };
}

/**
 * Escape the five characters that have XML-special meaning so skill
 * names and descriptions don't break out of the `<available_skills>`
 * block in the system prompt.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Format skills for inclusion in a system prompt using the XML shape
 * from the Agent Skills standard (https://agentskills.io/integrate-skills).
 *
 * Skills with `disableModelInvocation=true` are excluded — they can
 * only be invoked explicitly via `/skill:<name>`.
 *
 * Returns an empty string when no skills are visible; callers should
 * skip appending the block in that case.
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visible = skills.filter(s => !s.disableModelInvocation);
  if (visible.length === 0) return '';

  const lines = [
    '\n\nThe following skills provide specialized instructions for specific tasks.',
    "Use the read tool to load a skill's file when the task matches its description.",
    'When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.',
    '',
    '<available_skills>',
  ];

  for (const skill of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(`    <description>${escapeXml(skill.description)}</description>`);
    lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
    lines.push('  </skill>');
  }

  lines.push('</available_skills>');
  return lines.join('\n');
}

/**
 * Strip the YAML frontmatter block from a SKILL.md body before
 * injecting it into a user message. Matches the behaviour of
 * coding-agent's `stripFrontmatter` in
 * `packages/coding-agent/src/utils/frontmatter.ts`.
 */
export function stripSkillFrontmatter(content: string): string {
  const { body } = parseFrontmatter(content);
  return body;
}
