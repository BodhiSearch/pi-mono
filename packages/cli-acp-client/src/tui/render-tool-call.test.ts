/**
 * Tests for `renderRichToolCall`.
 *
 * The renderer is the difference between "user can read tool output"
 * and "wall of unstructured JSON". We pin every format choice that
 * the user sees (status badge, script preview, stdout/stderr split,
 * exit code, truncation) so a regression here surfaces immediately.
 */

import { describe, expect, it } from 'vitest';
import { renderRichToolCall } from './render-tool-call';
import type { ToolCallView } from '../acp/streaming-reducer';

function bashView(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    toolCallId: 'tc-1',
    toolName: 'bash',
    title: 'bash: ls',
    status: 'completed',
    rawInput: { script: 'ls' },
    text: '',
    turn: 0,
    ...overrides,
  };
}

describe('renderRichToolCall / bash', () => {
  it('renders status, title, script preview, and stdout block', () => {
    const view = bashView({
      rawInput: { script: 'ls -la' },
      rawOutput: { stdout: 'total 0\nfile.txt', stderr: '', exitCode: 0 },
    });
    const msg = renderRichToolCall(view);
    expect(msg.kind).toBe('tool');
    expect(msg.id).toBe('tc-1');
    const text = msg.text!;
    expect(text).toMatch(/^✓ done\s+bash: ls/);
    expect(text).toMatch(/ {2}\$ ls -la/);
    expect(text).toMatch(/ {2}stdout:\n {4}total 0\n {4}file\.txt/);
    expect(text).not.toMatch(/stderr:/);
    expect(text).not.toMatch(/exit:/);
  });

  it('renders separate stderr block when stderr is non-empty', () => {
    const view = bashView({
      status: 'failed',
      title: 'bash: cat missing',
      rawInput: { script: 'cat missing' },
      rawOutput: { stdout: '', stderr: 'cat: missing: No such file', exitCode: 1 },
    });
    const text = renderRichToolCall(view).text!;
    expect(text).toMatch(/^✗ failed\s+bash: cat missing/);
    expect(text).toMatch(/ {2}exit: 1/);
    expect(text).toMatch(/ {2}stderr:\n {4}cat: missing: No such file/);
    expect(text).not.toMatch(/ {2}stdout:/);
  });

  it('drops exit line when exitCode is 0', () => {
    const view = bashView({
      rawOutput: { stdout: 'ok', stderr: '', exitCode: 0 },
    });
    expect(renderRichToolCall(view).text).not.toMatch(/exit:/);
  });

  it('drops exit line when exitCode is missing', () => {
    const view = bashView({
      rawOutput: { stdout: 'ok' },
    });
    expect(renderRichToolCall(view).text).not.toMatch(/exit:/);
  });

  it('falls back to view.text when rawOutput is absent', () => {
    const view = bashView({ rawOutput: undefined, text: 'plain text body' });
    const text = renderRichToolCall(view).text!;
    expect(text).toMatch(/ {2}plain text body/);
  });

  it('falls back to view.text when stdout+stderr are both empty', () => {
    const view = bashView({
      rawOutput: { stdout: '', stderr: '' },
      text: 'fallback body',
    });
    const text = renderRichToolCall(view).text!;
    expect(text).toMatch(/ {2}fallback body/);
  });

  it.each([
    ['in_progress', '⋯ running'],
    ['completed', '✓ done'],
    ['failed', '✗ failed'],
    ['pending', '◌ pending'],
  ] as const)('uses %s status badge "%s"', (status, expected) => {
    const view = bashView({ status });
    expect(renderRichToolCall(view).text).toMatch(
      new RegExp('^' + expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    );
  });

  it('preserves multi-line scripts', () => {
    const view = bashView({
      rawInput: { script: 'echo a\necho b\necho c' },
      rawOutput: { stdout: 'a\nb\nc' },
    });
    const text = renderRichToolCall(view).text!;
    expect(text).toMatch(/ {2}\$ echo a\n {2}\$ echo b\n {2}\$ echo c/);
  });

  it('truncates very large stdout with an ellipsis', () => {
    const big = 'x'.repeat(5000);
    const view = bashView({ rawOutput: { stdout: big } });
    const text = renderRichToolCall(view).text!;
    expect(text).toMatch(/…/);
    // The 4096-byte cap + 4-space indent + "stdout:" header keeps total well under 5000.
    expect(text.length).toBeLessThan(5000);
  });

  it('handles bash with no script (synthesised title from toolTitle)', () => {
    const view = bashView({ rawInput: undefined, title: '', rawOutput: { stdout: 'hi' } });
    const text = renderRichToolCall(view).text!;
    // toolTitle('bash', undefined) yields a generic title; we just check it's non-empty.
    expect(text.split('\n')[0]).not.toBe('✓ done  ');
  });
});

describe('renderRichToolCall / generic', () => {
  it('renders status + title + indented text block', () => {
    const view: ToolCallView = {
      toolCallId: 'tc-9',
      toolName: 'wiki:search',
      title: 'wiki:search "node js"',
      status: 'completed',
      text: 'result line 1\nresult line 2',
      turn: 0,
    };
    const text = renderRichToolCall(view).text!;
    expect(text).toMatch(/^✓ done\s+wiki:search "node js"/);
    expect(text).toMatch(/ {2}result line 1\n {2}result line 2/);
  });

  it('omits the body block entirely when text is empty', () => {
    const view: ToolCallView = {
      toolCallId: 'tc-9',
      toolName: 'wiki:search',
      title: 'wiki:search',
      status: 'completed',
      text: '',
      turn: 0,
    };
    const text = renderRichToolCall(view).text!;
    expect(text.split('\n')).toHaveLength(1);
    expect(text).toMatch(/^✓ done\s+wiki:search$/);
  });

  it('truncates oversized generic text', () => {
    const big = 'a'.repeat(5000);
    const view: ToolCallView = {
      toolCallId: 'tc-9',
      toolName: 'wiki:search',
      title: 'wiki:search',
      status: 'completed',
      text: big,
      turn: 0,
    };
    const text = renderRichToolCall(view).text!;
    expect(text).toMatch(/…$/);
  });
});

describe('renderRichToolCall / title fallback', () => {
  it('uses view.title when distinct from toolCallId', () => {
    const view: ToolCallView = {
      toolCallId: 'tc-9',
      toolName: 'bash',
      title: 'custom title',
      status: 'completed',
      text: '',
      turn: 0,
    };
    expect(renderRichToolCall(view).text).toMatch(/✓ done\s+custom title/);
  });

  it('falls through to toolTitle when title equals toolCallId', () => {
    const view: ToolCallView = {
      toolCallId: 'tc-9',
      toolName: 'bash',
      title: 'tc-9',
      status: 'completed',
      rawInput: { script: 'echo hi' },
      text: '',
      turn: 0,
    };
    const text = renderRichToolCall(view).text!;
    // toolTitle for bash uses the script's first line.
    expect(text).toMatch(/echo hi/);
  });
});
