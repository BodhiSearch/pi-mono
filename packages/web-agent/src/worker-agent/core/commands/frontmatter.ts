/**
 * Minimal frontmatter parser for prompt template markdown files.
 *
 * Coding-agent uses the full `yaml` package (see
 * `packages/coding-agent/src/utils/frontmatter.ts`); web-agent keeps
 * the Worker bundle lean by handling the tiny subset prompt templates
 * actually need — string key/value pairs (optionally quoted) on their
 * own lines, e.g.:
 *
 *   ---
 *   description: Greet the user by name
 *   argument-hint: <name>
 *   ---
 *
 * Arrays, nested structures, and anchors are intentionally unsupported.
 * Matches coding-agent's behaviour for the keys `PromptTemplate`
 * actually reads (`description`, `argument-hint`).
 */

export interface ParsedFrontmatter {
  frontmatter: Record<string, string>;
  body: string;
}

const normalizeNewlines = (value: string): string =>
  value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function parseKeyValueBlock(yamlString: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = yamlString.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colonIdx = line.indexOf(':');
    if (colonIdx <= 0) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1);
    result[key] = stripQuotes(value);
  }
  return result;
}

export function parseFrontmatter(content: string): ParsedFrontmatter {
  const normalized = normalizeNewlines(content);
  if (!normalized.startsWith('---')) {
    return { frontmatter: {}, body: normalized };
  }
  const endIndex = normalized.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: normalized };
  }
  const yamlString = normalized.slice(4, endIndex);
  const body = normalized.slice(endIndex + 4).trim();
  return { frontmatter: parseKeyValueBlock(yamlString), body };
}
