/**
 * `ls` — list directory entries in the vault.
 *
 * Entries are sorted case-insensitive; directories are displayed with a
 * trailing "/". Output is capped at `limit` entries (default 500).
 */

import { type Static, Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { resolveVaultPath } from '../../fs/path-utils';
import type { LsOperations } from '../../fs/zenfs-operations';

export const lsSchema = Type.Object({
  path: Type.Optional(
    Type.String({ description: 'Directory to list. Defaults to the vault root (/vault).' })
  ),
  limit: Type.Optional(
    Type.Number({ description: 'Maximum number of entries to return (default 500).' })
  ),
});

export type LsToolInput = Static<typeof lsSchema>;

export interface LsToolDetails {
  entryLimitReached?: number;
}

export interface CreateLsToolOptions {
  operations: LsOperations;
  cwd?: string;
}

const DEFAULT_LIMIT = 500;

export function createLsTool({
  operations,
  cwd,
}: CreateLsToolOptions): AgentTool<typeof lsSchema, LsToolDetails | undefined> {
  return {
    name: 'ls',
    label: 'ls',
    description:
      'List entries of a vault directory (default /vault). Directories are shown with a trailing "/".',
    parameters: lsSchema,
    async execute(
      _toolCallId: string,
      { path, limit }: LsToolInput,
      signal?: AbortSignal
    ): Promise<AgentToolResult<LsToolDetails | undefined>> {
      if (signal?.aborted) throw new Error('Operation aborted');
      const targetPath = path ?? cwd ?? '/vault';
      const { absolute } = resolveVaultPath(targetPath, cwd);
      const s = await operations.stat(absolute);
      if (!s.isDirectory()) {
        throw new Error(`Not a directory: ${absolute}`);
      }
      const rawEntries = await operations.readdir(absolute);
      const cap = limit ?? DEFAULT_LIMIT;

      const withKind = await Promise.all(
        rawEntries.map(async name => {
          try {
            const child = absolute.endsWith('/') ? `${absolute}${name}` : `${absolute}/${name}`;
            const childStat = await operations.stat(child);
            return { name, isDirectory: childStat.isDirectory() };
          } catch {
            return { name, isDirectory: false };
          }
        })
      );

      withKind.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
      const selected = withKind.slice(0, cap);
      const limited = withKind.length > cap ? withKind.length - cap : 0;

      const lines = selected.map(e => (e.isDirectory ? `${e.name}/` : e.name));
      let text = lines.join('\n');
      if (limited > 0) {
        text += `\n\n[${limited} more entries not shown (limit ${cap}).]`;
      }

      return {
        content: [{ type: 'text', text }],
        details: limited > 0 ? { entryLimitReached: limited } : undefined,
      };
    },
  };
}
