/**
 * `read` — read a UTF-8 text file from the vault.
 *
 * Schema + algorithm adapted from
 * `packages/coding-agent/src/core/tools/read.ts` (see principle #1 — copy,
 * don't import). Simplifications for v1:
 *   - text files only (binary / image support deferred to a later milestone)
 *   - no TUI render functions (browser UI is React)
 */

import { type Static, Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { resolveVaultPath } from '../../fs/path-utils';
import type { ReadOperations } from '../../fs/zenfs-operations';
import { DEFAULT_MAX_BYTES, formatSize, truncateHead, type TruncationResult } from './truncation';

export const readSchema = Type.Object({
  path: Type.String({
    description: 'Path to the file to read (relative to /vault, or absolute starting /vault/).',
  }),
  offset: Type.Optional(
    Type.Number({ description: 'Line number to start reading from (1-indexed).' })
  ),
  limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read.' })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
  truncation?: TruncationResult;
}

export interface CreateReadToolOptions {
  operations: ReadOperations;
  /** Directory against which relative paths resolve. Defaults to /vault. */
  cwd?: string;
}

const DESCRIPTION = `Read the contents of a file in the vault. Text files only. Output is capped at ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit to page through large files.`;

export function createReadTool({
  operations,
  cwd,
}: CreateReadToolOptions): AgentTool<typeof readSchema, ReadToolDetails | undefined> {
  return {
    name: 'read',
    label: 'read',
    description: DESCRIPTION,
    parameters: readSchema,
    async execute(
      _toolCallId: string,
      { path, offset, limit }: ReadToolInput,
      signal?: AbortSignal
    ): Promise<AgentToolResult<ReadToolDetails | undefined>> {
      if (signal?.aborted) throw new Error('Operation aborted');
      const { absolute } = resolveVaultPath(path, cwd);
      await operations.access(absolute);
      if (signal?.aborted) throw new Error('Operation aborted');

      const buffer = await operations.readFile(absolute);
      if (signal?.aborted) throw new Error('Operation aborted');
      const textContent = new TextDecoder().decode(buffer);

      const allLines = textContent.split('\n');
      const totalLines = allLines.length;
      const startLine = offset ? Math.max(0, offset - 1) : 0;
      if (startLine >= allLines.length) {
        throw new Error(`Offset ${offset} is beyond end of file (${totalLines} lines total)`);
      }
      const startLineDisplay = startLine + 1;

      let selected: string;
      let userLimitedLines: number | undefined;
      if (limit !== undefined) {
        const endLine = Math.min(startLine + limit, allLines.length);
        selected = allLines.slice(startLine, endLine).join('\n');
        userLimitedLines = endLine - startLine;
      } else {
        selected = allLines.slice(startLine).join('\n');
      }

      const truncation = truncateHead(selected);
      let outputText: string;
      let details: ReadToolDetails | undefined;

      if (truncation.firstLineExceedsLimit) {
        outputText = `[Line ${startLineDisplay} exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit; narrow your offset/limit to fetch manageable slices.]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;
        outputText = truncation.content;
        if (truncation.truncatedBy === 'lines') {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines}. Use offset=${nextOffset} to continue.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
        }
        details = { truncation };
      } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
        const remaining = allLines.length - (startLine + userLimitedLines);
        const nextOffset = startLine + userLimitedLines + 1;
        outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
      } else {
        outputText = truncation.content;
      }

      return {
        content: [{ type: 'text', text: outputText }],
        details,
      };
    },
  };
}
