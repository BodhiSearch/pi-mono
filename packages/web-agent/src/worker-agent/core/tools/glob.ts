/**
 * `glob` — JS walker over the vault, matching with `minimatch`.
 *
 * Replaces coding-agent's `fd` subprocess. Walks the directory tree beneath
 * the resolved `path`, matches each file path (relative to the root) against
 * the glob `pattern` with minimatch, and returns relative paths.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { minimatch } from 'minimatch';
import { resolveVaultPath } from '../../fs/path-utils';
import type { GlobOperations } from '../../fs/zenfs-operations';

export const globSchema = Type.Object({
  pattern: Type.String({
    description: 'Glob pattern, e.g. "*.ts", "**/*.json", "src/**/*.spec.ts".',
  }),
  path: Type.Optional(Type.String({ description: 'Directory to search (default /vault).' })),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of results (default 1000).' })),
});

export type GlobToolInput = Static<typeof globSchema>;

export interface GlobToolDetails {
  resultLimitReached?: number;
}

export interface CreateGlobToolOptions {
  operations: GlobOperations;
  cwd?: string;
}

const DEFAULT_LIMIT = 1000;

export function createGlobTool({
  operations,
  cwd,
}: CreateGlobToolOptions): AgentTool<typeof globSchema, GlobToolDetails | undefined> {
  return {
    name: 'glob',
    label: 'glob',
    description:
      'List files in the vault whose path matches a glob pattern (minimatch syntax). Returns paths relative to the search root.',
    parameters: globSchema,
    async execute(
      _toolCallId: string,
      { pattern, path, limit }: GlobToolInput,
      signal?: AbortSignal
    ): Promise<AgentToolResult<GlobToolDetails | undefined>> {
      if (signal?.aborted) throw new Error('Operation aborted');
      const { absolute: root } = resolveVaultPath(path ?? cwd ?? '/vault', cwd);
      const rootStat = await operations.stat(root);
      if (!rootStat.isDirectory()) throw new Error(`Not a directory: ${root}`);

      const cap = limit ?? DEFAULT_LIMIT;
      const matcher = (rel: string): boolean => minimatch(rel, pattern, { dot: false });

      const results: string[] = [];

      async function walk(dirAbs: string, dirRel: string): Promise<void> {
        if (signal?.aborted) throw new Error('Operation aborted');
        if (results.length >= cap + 1) return;
        const names = await operations.readdir(dirAbs);
        names.sort();
        for (const name of names) {
          if (results.length >= cap + 1) return;
          const childAbs = dirAbs.endsWith('/') ? `${dirAbs}${name}` : `${dirAbs}/${name}`;
          const childRel = dirRel ? `${dirRel}/${name}` : name;
          let s: Awaited<ReturnType<GlobOperations['stat']>>;
          try {
            s = await operations.stat(childAbs);
          } catch {
            continue;
          }
          if (s.isDirectory()) {
            await walk(childAbs, childRel);
          } else if (s.isFile() && matcher(childRel)) {
            results.push(childRel);
          }
        }
      }

      await walk(root, '');

      const limited = results.length > cap;
      const shown = limited ? results.slice(0, cap) : results;
      let text = shown.length === 0 ? '[no matches]' : shown.join('\n');
      if (limited) {
        text += `\n\n[Result limit ${cap} reached; narrow your pattern to see more.]`;
      }

      return {
        content: [{ type: 'text', text }],
        details: limited ? { resultLimitReached: cap } : undefined,
      };
    },
  };
}
