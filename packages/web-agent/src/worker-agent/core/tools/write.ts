/**
 * `write` — write a UTF-8 text file to the vault (overwrite semantics).
 *
 * Parents are created as needed (`mkdir -p`). Writes are serialised per-path
 * via `withFileMutationQueue` to match coding-agent behaviour and prevent
 * concurrent-write races.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { resolveVaultPath } from '../../fs/path-utils';
import type { WriteOperations } from '../../fs/zenfs-operations';
import { withFileMutationQueue } from './file-mutation-queue';

export const writeSchema = Type.Object({
  path: Type.String({
    description: 'Path to write (relative to /vault, or absolute starting /vault/).',
  }),
  content: Type.String({ description: 'UTF-8 content to write. Overwrites any existing file.' }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface CreateWriteToolOptions {
  operations: WriteOperations;
  cwd?: string;
}

export function createWriteTool({
  operations,
  cwd,
}: CreateWriteToolOptions): AgentTool<typeof writeSchema, undefined> {
  return {
    name: 'write',
    label: 'write',
    description:
      'Write a file in the vault (overwrites if it exists). Parent directories are created automatically.',
    parameters: writeSchema,
    async execute(
      _toolCallId: string,
      { path, content }: WriteToolInput,
      signal?: AbortSignal
    ): Promise<AgentToolResult<undefined>> {
      if (signal?.aborted) throw new Error('Operation aborted');
      const { absolute } = resolveVaultPath(path, cwd);
      const lastSlash = absolute.lastIndexOf('/');
      const parent = lastSlash > 0 ? absolute.slice(0, lastSlash) : '/';

      await withFileMutationQueue(absolute, async () => {
        if (parent !== '/') {
          await operations.mkdir(parent);
        }
        if (signal?.aborted) throw new Error('Operation aborted');
        await operations.writeFile(absolute, content);
      });

      return {
        content: [{ type: 'text', text: `Wrote ${absolute} (${content.length} chars).` }],
        details: undefined,
      };
    },
  };
}
