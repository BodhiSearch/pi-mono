/**
 * `grep` — JS walker that regex-matches lines in the vault.
 *
 * Replaces coding-agent's `rg` subprocess. Walks the tree beneath `path`,
 * filters files by an optional glob, and matches each line against the
 * pattern (literal or regex, case-sensitive by default). Output format:
 * `path:lineno: matched-line` (trimmed to `GREP_MAX_LINE_LENGTH`).
 */

import { type Static, Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { minimatch } from 'minimatch';
import { resolveVaultPath } from '../../fs/path-utils';
import type { GrepOperations } from '../../fs/zenfs-operations';

export const grepSchema = Type.Object({
  pattern: Type.String({ description: 'Search pattern (regex by default).' }),
  path: Type.Optional(
    Type.String({ description: 'Directory or file to search (default /vault).' })
  ),
  glob: Type.Optional(Type.String({ description: 'Glob filter on file path, e.g. "*.ts".' })),
  ignoreCase: Type.Optional(
    Type.Boolean({ description: 'Case-insensitive search (default false).' })
  ),
  literal: Type.Optional(
    Type.Boolean({
      description: 'Treat pattern as a literal string instead of regex (default false).',
    })
  ),
  context: Type.Optional(
    Type.Number({ description: 'Lines of context before/after each match (default 0).' })
  ),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of matches (default 100).' })),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
  matchLimitReached?: number;
}

export interface CreateGrepToolOptions {
  operations: GrepOperations;
  cwd?: string;
}

const DEFAULT_LIMIT = 100;
const GREP_MAX_LINE_LENGTH = 512;

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function createGrepTool({
  operations,
  cwd,
}: CreateGrepToolOptions): AgentTool<typeof grepSchema, GrepToolDetails | undefined> {
  return {
    name: 'grep',
    label: 'grep',
    description:
      'Search vault file contents for a pattern. Regex by default (set literal=true for plain text). Returns path:lineno: matched-line.',
    parameters: grepSchema,
    async execute(
      _toolCallId: string,
      { pattern, path, glob, ignoreCase, literal, context, limit }: GrepToolInput,
      signal?: AbortSignal
    ): Promise<AgentToolResult<GrepToolDetails | undefined>> {
      if (signal?.aborted) throw new Error('Operation aborted');
      const { absolute: root } = resolveVaultPath(path ?? cwd ?? '/vault', cwd);
      const rootStat = await operations.stat(root);
      const rootIsDir = rootStat.isDirectory();
      if (!rootIsDir && !rootStat.isFile()) {
        throw new Error(`Not a file or directory: ${root}`);
      }

      const flags = ignoreCase ? 'i' : '';
      const source = literal ? escapeRegex(pattern) : pattern;
      let regex: RegExp;
      try {
        regex = new RegExp(source, flags);
      } catch (err) {
        throw new Error(
          `Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`
        );
      }

      const cap = limit ?? DEFAULT_LIMIT;
      const ctx = Math.max(0, context ?? 0);
      const matchLines: string[] = [];
      let matchCount = 0;

      async function searchFile(absPath: string, relPath: string): Promise<void> {
        if (signal?.aborted) throw new Error('Operation aborted');
        if (glob && !minimatch(relPath, glob, { dot: false })) return;
        let contentStr: string;
        try {
          contentStr = await operations.readFile(absPath);
        } catch {
          return;
        }
        const lines = contentStr.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (matchCount >= cap) return;
          const line = lines[i];
          if (!regex.test(line)) continue;
          matchCount++;
          const lineNo = i + 1;

          if (ctx === 0) {
            const trimmed =
              line.length > GREP_MAX_LINE_LENGTH
                ? `${line.slice(0, GREP_MAX_LINE_LENGTH)}… [truncated]`
                : line;
            matchLines.push(`${relPath}:${lineNo}: ${trimmed}`);
          } else {
            const start = Math.max(0, i - ctx);
            const end = Math.min(lines.length - 1, i + ctx);
            const block: string[] = [];
            for (let j = start; j <= end; j++) {
              const marker = j === i ? ':' : '-';
              const srcLine = lines[j];
              const trimmed =
                srcLine.length > GREP_MAX_LINE_LENGTH
                  ? `${srcLine.slice(0, GREP_MAX_LINE_LENGTH)}… [truncated]`
                  : srcLine;
              block.push(`${relPath}:${j + 1}${marker} ${trimmed}`);
            }
            matchLines.push(block.join('\n'));
          }
        }
      }

      async function walk(dirAbs: string, dirRel: string): Promise<void> {
        if (signal?.aborted) throw new Error('Operation aborted');
        if (matchCount >= cap) return;
        const names = await operations.readdir(dirAbs);
        names.sort();
        for (const name of names) {
          if (matchCount >= cap) return;
          const childAbs = dirAbs.endsWith('/') ? `${dirAbs}${name}` : `${dirAbs}/${name}`;
          const childRel = dirRel ? `${dirRel}/${name}` : name;
          let s: Awaited<ReturnType<GrepOperations['stat']>>;
          try {
            s = await operations.stat(childAbs);
          } catch {
            continue;
          }
          if (s.isDirectory()) {
            await walk(childAbs, childRel);
          } else if (s.isFile()) {
            await searchFile(childAbs, childRel);
          }
        }
      }

      if (rootIsDir) {
        await walk(root, '');
      } else {
        const rel = root.startsWith('/vault/') ? root.slice('/vault/'.length) : root;
        await searchFile(root, rel);
      }

      const limited = matchCount >= cap;
      const text =
        matchLines.length === 0 ? '[no matches]' : matchLines.join(ctx ? '\n--\n' : '\n');
      const finalText = limited
        ? `${text}\n\n[Match limit ${cap} reached; narrow your pattern or path.]`
        : text;

      return {
        content: [{ type: 'text', text: finalText }],
        details: limited ? { matchLimitReached: cap } : undefined,
      };
    },
  };
}
