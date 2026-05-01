/**
 * Line-mode REPL used by `--ci-line-mode` and tests. Reads from stdin
 * one line at a time via Node's `readline` and submits to the
 * dispatcher. Output goes through the line renderer.
 *
 * Output is intentionally deterministic: every emit prints exactly one
 * line per `\n` in the message, prefixed by a stable `[kind]` tag. e2e
 * specs match against these prefixes rather than ANSI-styled output.
 */

import * as readline from 'node:readline';
import { createLineRenderer } from './line-renderer';
import type { Renderer, SlashCommandSummary } from '../shell/types';

export interface LineReplOptions {
  banner?: string;
  prompt?: string;
  /** Stream to read input from (defaults to `process.stdin`). */
  input?: NodeJS.ReadableStream;
  /** Stream to write output to (defaults to `process.stdout`). */
  output?: NodeJS.WritableStream;
  /** Slash command summaries — used only for /help printing. */
  slashCommands: SlashCommandSummary[];
  /** Submit a single user line to the dispatcher. */
  onSubmit: (line: string) => Promise<void>;
}

export interface LineReplRuntime {
  renderer: Renderer;
  /** Resolves when the user closes stdin or `stop()` is called. */
  exited: Promise<void>;
  stop(): void;
}

export function createLineRepl(opts: LineReplOptions): LineReplRuntime {
  const input = opts.input ?? process.stdin;
  const output = opts.output ?? process.stdout;
  const writeLine = (line: string) => {
    output.write(line.endsWith('\n') ? line : `${line}\n`);
  };
  const renderer = createLineRenderer({
    write: writeLine,
    emitStatusLines: true,
  });

  if (opts.banner) {
    writeLine(opts.banner);
  }

  const rl = readline.createInterface({
    input,
    output,
    prompt: opts.prompt ?? '> ',
    terminal: false,
  });

  let exitResolve!: () => void;
  const exited = new Promise<void>(resolve => {
    exitResolve = resolve;
  });

  let busy = false;
  let pendingClose = false;

  rl.on('line', async line => {
    if (busy) {
      // Buffer would be nicer; rejecting keeps tests deterministic.
      writeLine('[error] busy — wait for the previous command to finish');
      rl.prompt();
      return;
    }
    busy = true;
    try {
      await opts.onSubmit(line);
    } catch (err) {
      writeLine(`[error] ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      busy = false;
      if (pendingClose) {
        rl.close();
      } else {
        rl.prompt();
      }
    }
  });

  rl.on('close', () => {
    exitResolve();
  });

  rl.prompt();

  return {
    renderer,
    exited,
    stop(): void {
      pendingClose = true;
      try {
        rl.close();
      } catch {
        // ignore
      }
    },
  };
}
