/**
 * Prompt template parsing, substitution, and vault-backed loading.
 *
 * Pure string logic (`parseCommandArgs`, `substituteArgs`,
 * `expandPromptTemplate`) is a direct port of
 * `packages/coding-agent/src/core/prompt-templates.ts`. The loader is
 * browser-native: it walks the mounted ZenFS vault through the
 * `VaultOperations` seam instead of `readdirSync` / `readFileSync`.
 */

import type { LsOperations, ReadOperations } from '../../fs/zenfs-operations';
import { parseFrontmatter } from './frontmatter';
import type { PromptTemplate } from './types';

const DECODER = new TextDecoder();

/**
 * Parse command arguments respecting quoted strings (bash-style).
 * Returns array of arguments.
 *
 * Port of coding-agent's `parseCommandArgs` — byte-for-byte behavioural
 * match so template authors can share the same prompts between runtimes.
 */
export function parseCommandArgs(argsString: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuote: string | null = null;

  for (let i = 0; i < argsString.length; i++) {
    const char = argsString[i];

    if (inQuote) {
      if (char === inQuote) {
        inQuote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuote = char;
    } else if (char === ' ' || char === '\t') {
      if (current) {
        args.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }

  if (current) {
    args.push(current);
  }

  return args;
}

/**
 * Substitute argument placeholders in template content.
 *
 * Supports:
 * - $1, $2, ... for positional args
 * - $@ and $ARGUMENTS for all args
 * - ${@:N} for args from Nth onwards (bash-style slicing)
 * - ${@:N:L} for L args starting from Nth
 *
 * Replacement happens on the template string only. Argument values
 * containing patterns like $1, $@, or $ARGUMENTS are NOT recursively
 * substituted.
 */
export function substituteArgs(content: string, args: string[]): string {
  let result = content;

  result = result.replace(/\$(\d+)/g, (_, num) => {
    const index = parseInt(num, 10) - 1;
    return args[index] ?? '';
  });

  result = result.replace(/\$\{@:(\d+)(?::(\d+))?\}/g, (_, startStr, lengthStr) => {
    let start = parseInt(startStr, 10) - 1;
    if (start < 0) start = 0;

    if (lengthStr) {
      const length = parseInt(lengthStr, 10);
      return args.slice(start, start + length).join(' ');
    }
    return args.slice(start).join(' ');
  });

  const allArgs = args.join(' ');
  result = result.replace(/\$ARGUMENTS/g, allArgs);
  result = result.replace(/\$@/g, allArgs);

  return result;
}

/**
 * Expand a prompt template if `text` matches a template invocation.
 * Returns the expanded content, or the original text when no template
 * matches. Mirrors coding-agent's `expandPromptTemplate`.
 */
export function expandPromptTemplate(text: string, templates: PromptTemplate[]): string {
  if (!text.startsWith('/')) return text;

  const spaceIndex = text.indexOf(' ');
  const templateName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
  const argsString = spaceIndex === -1 ? '' : text.slice(spaceIndex + 1);

  const template = templates.find(t => t.name === templateName);
  if (template) {
    const args = parseCommandArgs(argsString);
    return substituteArgs(template.content, args);
  }

  return text;
}

// ============================================================================
// Vault loader
// ============================================================================

/**
 * Narrow file operations the loader needs. Intentionally a subset of
 * `VaultOperations` so callers can pass a mock in tests without wiring
 * a full `ls` + `read` implementation.
 */
export interface PromptTemplateLoaderOps {
  ls: Pick<LsOperations, 'stat' | 'readdir'>;
  read: Pick<ReadOperations, 'readFile'>;
}

/**
 * Build a prompt template from a single `.md` vault file.
 *
 * Returns `null` if the file is unreadable or its basename is empty.
 */
async function loadTemplateFromPath(
  filePath: string,
  ops: PromptTemplateLoaderOps
): Promise<PromptTemplate | null> {
  try {
    const bytes = await ops.read.readFile(filePath);
    const rawContent = DECODER.decode(bytes);
    const { frontmatter, body } = parseFrontmatter(rawContent);

    const lastSlash = filePath.lastIndexOf('/');
    const basename = lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
    const name = basename.replace(/\.md$/, '');
    if (!name) return null;

    let description = frontmatter.description ?? '';
    if (!description) {
      const firstLine = body.split('\n').find(line => line.trim());
      if (firstLine) {
        description = firstLine.slice(0, 60);
        if (firstLine.length > 60) description += '...';
      }
    }

    const argumentHint = frontmatter['argument-hint'];

    return {
      name,
      description,
      ...(argumentHint ? { argumentHint } : {}),
      content: body,
      filePath,
    };
  } catch {
    return null;
  }
}

/**
 * Scan a single vault directory (non-recursive) for `.md` files and
 * return them as `PromptTemplate`s. Missing directories yield `[]` —
 * a vault with no `.pi/prompts/` folder is the common case.
 */
export async function loadPromptTemplatesFromDir(
  dir: string,
  ops: PromptTemplateLoaderOps
): Promise<PromptTemplate[]> {
  let entries: string[];
  try {
    const s = await ops.ls.stat(dir);
    if (!s.isDirectory()) return [];
    entries = await ops.ls.readdir(dir);
  } catch {
    return [];
  }

  const templates: PromptTemplate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue;
    const fullPath = dir.endsWith('/') ? `${dir}${entry}` : `${dir}/${entry}`;
    try {
      const entryStat = await ops.ls.stat(fullPath);
      if (!entryStat.isFile()) continue;
    } catch {
      continue;
    }
    const template = await loadTemplateFromPath(fullPath, ops);
    if (template) templates.push(template);
  }

  templates.sort((a, b) => a.name.localeCompare(b.name));
  return templates;
}
