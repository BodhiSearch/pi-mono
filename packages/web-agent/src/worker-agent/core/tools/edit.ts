/**
 * `edit` — targeted multi-edit of an existing vault file.
 *
 * Each edit matches `oldText` against the *original* file (not the running
 * result), so edits are independent. Matches must be unique — we reject
 * ambiguous or missing targets. Line-endings and leading BOM are preserved.
 *
 * Algorithm mirrors coding-agent's `edit` tool, trimmed to text edits.
 */

import { type Static, Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { resolveVaultPath } from '../../fs/path-utils';
import type { EditOperations } from '../../fs/zenfs-operations';
import { withFileMutationQueue } from './file-mutation-queue';

const replaceEditSchema = Type.Object(
  {
    oldText: Type.String({
      description: 'Exact text for one targeted replacement. Must appear uniquely in the file.',
    }),
    newText: Type.String({ description: 'Replacement text for this edit.' }),
  },
  { additionalProperties: false }
);

export const editSchema = Type.Object(
  {
    path: Type.String({ description: 'Path to the file to edit (relative to /vault).' }),
    edits: Type.Array(replaceEditSchema, {
      description:
        'One or more targeted replacements. Each matches against the original file text, not the running result.',
    }),
  },
  { additionalProperties: false }
);

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
  diff: string;
  firstChangedLine: number | undefined;
}

export interface CreateEditToolOptions {
  operations: EditOperations;
  cwd?: string;
}

type LineEnding = '\n' | '\r\n' | '\r';

function detectLineEnding(text: string): LineEnding {
  if (text.includes('\r\n')) return '\r\n';
  if (text.includes('\r')) return '\r';
  return '\n';
}

function normalizeToLf(text: string): { body: string; bom: string; ending: LineEnding } {
  const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
  const body = bom ? text.slice(1) : text;
  const ending = detectLineEnding(body);
  if (ending === '\n') return { body, bom, ending };
  return { body: body.replace(/\r\n|\r/g, '\n'), bom, ending };
}

function restore(bom: string, body: string, ending: LineEnding): string {
  const out = ending === '\n' ? body : body.replace(/\n/g, ending);
  return bom + out;
}

function applyEditsToOriginal(
  original: string,
  edits: readonly { oldText: string; newText: string }[]
): string {
  let result = original;
  for (let i = 0; i < edits.length; i++) {
    const { oldText, newText } = edits[i];
    if (oldText === newText) {
      throw new Error(`Edit #${i + 1}: oldText and newText are identical`);
    }
    if (oldText === '') {
      throw new Error(`Edit #${i + 1}: oldText must not be empty`);
    }
    const first = result.indexOf(oldText);
    if (first < 0) {
      throw new Error(`Edit #${i + 1}: oldText not found`);
    }
    const second = result.indexOf(oldText, first + oldText.length);
    if (second >= 0) {
      throw new Error(`Edit #${i + 1}: oldText matches more than once; make it unique`);
    }
    result = result.slice(0, first) + newText + result.slice(first + oldText.length);
  }
  return result;
}

function buildDiff(
  before: string,
  after: string
): { diff: string; firstChangedLine: number | undefined } {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lines: string[] = [];
  let i = 0;
  let firstChange: number | undefined;
  while (i < beforeLines.length || i < afterLines.length) {
    const b = i < beforeLines.length ? beforeLines[i] : undefined;
    const a = i < afterLines.length ? afterLines[i] : undefined;
    if (b === a) {
      if (b !== undefined) lines.push(` ${b}`);
    } else {
      if (firstChange === undefined) firstChange = i + 1;
      if (b !== undefined) lines.push(`-${b}`);
      if (a !== undefined) lines.push(`+${a}`);
    }
    i++;
  }
  return { diff: lines.join('\n'), firstChangedLine: firstChange };
}

export function createEditTool({
  operations,
  cwd,
}: CreateEditToolOptions): AgentTool<typeof editSchema, EditToolDetails | undefined> {
  return {
    name: 'edit',
    label: 'edit',
    description:
      'Apply one or more exact-text replacements to a vault file. Each oldText must appear uniquely in the file (as of read time). Prefer reading before editing.',
    parameters: editSchema,
    async execute(
      _toolCallId: string,
      { path, edits }: EditToolInput,
      signal?: AbortSignal
    ): Promise<AgentToolResult<EditToolDetails | undefined>> {
      if (signal?.aborted) throw new Error('Operation aborted');
      if (edits.length === 0) throw new Error('edit requires at least one edit');
      const { absolute } = resolveVaultPath(path, cwd);

      return await withFileMutationQueue(absolute, async () => {
        await operations.access(absolute);
        if (signal?.aborted) throw new Error('Operation aborted');
        const buffer = await operations.readFile(absolute);
        // ignoreBOM so we can detect-and-preserve it rather than silently strip.
        const originalText = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buffer);
        const { body, bom, ending } = normalizeToLf(originalText);
        const nextBody = applyEditsToOriginal(body, edits);
        if (nextBody === body) {
          throw new Error('Edits produced no changes');
        }
        const restored = restore(bom, nextBody, ending);
        if (signal?.aborted) throw new Error('Operation aborted');
        await operations.writeFile(absolute, restored);
        const { diff, firstChangedLine } = buildDiff(body, nextBody);

        return {
          content: [
            {
              type: 'text',
              text: `Edited ${absolute}:\n${diff}`,
            },
          ],
          details: { diff, firstChangedLine },
        };
      });
    },
  };
}
