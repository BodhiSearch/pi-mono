/**
 * Pretty tool-call renderer for the pi-tui mode.
 *
 * Strategy:
 *   - title from web-acp-agent's `toolTitle` so the line matches what
 *     the agent itself logs (`bash: <first line>`),
 *   - status badge (`[in_progress]`/`[completed]`/`[failed]`),
 *   - bash-specific formatting: separate `$ <script>` block (full
 *     multiline preserved), then exitCode, stdout, stderr blocks
 *     pulled out of the rawOutput envelope,
 *   - everything else falls back to the title + text payload that the
 *     agent already serialised into `view.text`.
 *
 * The line-mode renderer keeps using the default one-line emit so its
 * output stays deterministic for snapshot tests.
 */

import { toolTitle } from '@bodhiapp/web-acp-agent';
import type { ToolCallView } from '../acp/streaming-reducer';
import type { ShellMessage } from '../shell/types';

const STATUS_PREFIX: Record<ToolCallView['status'], string> = {
  in_progress: '⋯ running',
  completed: '✓ done',
  failed: '✗ failed',
  pending: '◌ pending',
};

const MAX_OUTPUT_BYTES = 4096;

export function renderRichToolCall(view: ToolCallView): ShellMessage {
  const status = STATUS_PREFIX[view.status] ?? `[${view.status}]`;
  const title = formatTitle(view);
  const lines: string[] = [`${status}  ${title}`];

  if (view.toolName === 'bash') {
    appendBashBlocks(lines, view);
  } else {
    appendGenericBlocks(lines, view);
  }

  const text = lines.join('\n');
  return { id: view.toolCallId, kind: 'tool', text };
}

function formatTitle(view: ToolCallView): string {
  if (view.title && view.title !== view.toolCallId) return view.title;
  return toolTitle(view.toolName, view.rawInput);
}

function appendBashBlocks(lines: string[], view: ToolCallView): void {
  const script = readString(view.rawInput, 'script');
  if (script) {
    const trimmed =
      script.length > MAX_OUTPUT_BYTES ? `${script.slice(0, MAX_OUTPUT_BYTES)}…` : script;
    lines.push(prefixLines(trimmed, '  $ '));
  }

  const out = view.rawOutput;
  if (!out || typeof out !== 'object') {
    if (view.text) lines.push(prefixLines(view.text, '  '));
    return;
  }

  const exitCode = (out as { exitCode?: unknown }).exitCode;
  if (typeof exitCode === 'number' && exitCode !== 0) {
    lines.push(`  exit: ${exitCode}`);
  }

  const stdout = readString(out, 'stdout');
  if (stdout && stdout.trim().length > 0) {
    lines.push('  stdout:');
    lines.push(prefixLines(truncate(stdout), '    '));
  }
  const stderr = readString(out, 'stderr');
  if (stderr && stderr.trim().length > 0) {
    lines.push('  stderr:');
    lines.push(prefixLines(truncate(stderr), '    '));
  }

  if (!stdout && !stderr && view.text) {
    lines.push(prefixLines(view.text, '  '));
  }
}

function appendGenericBlocks(lines: string[], view: ToolCallView): void {
  if (!view.text) return;
  lines.push(prefixLines(truncate(view.text), '  '));
}

function readString(source: unknown, key: string): string | undefined {
  if (!source || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split('\n')
    .map(line => `${prefix}${line}`)
    .join('\n');
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_BYTES) return text;
  return `${text.slice(0, MAX_OUTPUT_BYTES)}…`;
}
