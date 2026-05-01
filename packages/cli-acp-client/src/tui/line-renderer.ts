/**
 * Line-mode renderer used by `--ci-line-mode` and unit tests. Emits one
 * deterministic line per `ShellMessage` to stdout (or a redirected
 * writable). No ANSI cursor moves, no spinner, no markdown wrapping.
 *
 * Streaming is tracked by `id` — when the same id is emitted multiple
 * times we print delta lines tagged with `[stream]` so transcripts can
 * tell start/finish apart.
 */

import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from '../shell/types';

export interface LineRendererOptions {
  write: (line: string) => void;
  /** True to emit `[status:...]` lines on every status change. */
  emitStatusLines?: boolean;
  /** True to print a one-line prefix for each emit so e2e logs are stable. */
  prefixed?: boolean;
}

export function createLineRenderer(opts: LineRendererOptions): Renderer {
  const seenIds = new Map<string, string>();
  const emitStatusLines = opts.emitStatusLines ?? true;
  const prefixed = opts.prefixed ?? false;

  function tag(kind: ShellMessage['kind'], idHint: string | undefined): string {
    if (!prefixed) return tagShort(kind);
    return `[${kind}${idHint ? `:${idHint}` : ''}]`;
  }

  return {
    emit(message: ShellMessage) {
      const idKey = message.id;
      const isStream = idKey ? seenIds.has(idKey) : false;
      if (idKey) seenIds.set(idKey, message.text);
      const prefix = isStream ? '[stream]' : tag(message.kind, message.id);
      const lines = message.text.split('\n');
      for (const line of lines) {
        opts.write(`${prefix} ${line}`);
      }
    },
    setStatus(status: ConnectionStatus) {
      if (!emitStatusLines) return;
      opts.write(`[status] ${formatStatus(status)}`);
    },
    renderHelp(commands: SlashCommandSummary[]) {
      opts.write('[help] available commands:');
      for (const cmd of commands) {
        const usage = cmd.usage ? `  ${cmd.usage}` : '';
        opts.write(`  /${cmd.name}  — ${cmd.description}${usage}`);
      }
    },
  };
}

function tagShort(kind: ShellMessage['kind']): string {
  switch (kind) {
    case 'user':
      return '[you]';
    case 'assistant':
      return '[bot]';
    case 'tool':
      return '[tool]';
    case 'error':
      return '[error]';
    case 'system':
      return '[sys]';
    default:
      return '[info]';
  }
}

function formatStatus(status: ConnectionStatus): string {
  switch (status.kind) {
    case 'disconnected':
      return `disconnected${status.reason ? ` — ${status.reason}` : ''}`;
    case 'connecting':
      return `connecting to ${status.host}`;
    case 'authenticating':
      return `authenticating with ${status.host}`;
    case 'authenticated':
      return `authenticated to ${status.host}${status.modelId ? ` model=${status.modelId}` : ''}`;
  }
}
