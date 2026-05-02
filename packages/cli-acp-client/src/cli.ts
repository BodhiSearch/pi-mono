#!/usr/bin/env node
import * as path from 'node:path';
import { bootstrapCli } from './bootstrap';
import { createPrintOnlyOpener } from './auth/browser-opener';
import { resolveIsDev } from './cli/dev-flag';

interface ParsedArgs {
  ciLineMode: boolean;
  noBrowser: boolean;
  cwd: string;
  banner?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  let ciLineMode = false;
  let noBrowser = false;
  let cwd = process.cwd();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--ci-line-mode' || arg === '--line-mode') {
      ciLineMode = true;
    } else if (arg === '--no-browser') {
      noBrowser = true;
    } else if (arg === '--cwd') {
      const next = argv[++i];
      if (!next) throw new Error('--cwd requires a value');
      cwd = path.resolve(next);
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else if (!arg.startsWith('-')) {
      // Reserved for future positional args (e.g. one-shot prompt).
    }
  }
  return { ciLineMode, noBrowser, cwd };
}

function printUsage(): void {
  process.stdout.write(
    [
      'cli-acp - Claude-Code-style ACP CLI powered by @bodhiapp/web-acp-agent',
      '',
      'Usage:',
      '  cli-acp [options]',
      '',
      'Options:',
      '  --ci-line-mode     Use plain line-mode renderer (deterministic for CI/e2e).',
      '  --no-browser       Print the OAuth URL instead of launching a browser.',
      '  --cwd <path>       Use <path> as the working dir + auto-volume root.',
      '  --help, -h         Show this message.',
      '',
      'Get started:',
      '  /host <url>        Set BodhiApp URL and start the OAuth flow.',
      '  /models            List models registered on the connected host.',
      '  /model <id>        Pick the active model.',
      '  /help              Show all commands.',
    ].join('\n') + '\n'
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const banner = args.banner ?? 'cli-acp - type /help for commands, /host <url> to begin.';

  const opener =
    args.noBrowser || args.ciLineMode
      ? createPrintOnlyOpener(line => process.stdout.write(`${line}\n`))
      : undefined;

  const runtime = await bootstrapCli({
    cwd: args.cwd,
    renderer: args.ciLineMode ? 'line' : 'pi-tui',
    banner,
    opener,
    hostOptions: { isDev: resolveIsDev(process.env.CLI_ACP_DEV) },
  });

  await runtime.exited;
  await runtime.shutdown();
}

main()
  .then(() => {
    // The embedded ACP duplex + ZenFS keep async handles (timers, FS
    // ops) alive after our await chain resolves, so the Node event
    // loop won't drain on its own. Force-exit on success — the event
    // loop's pending work is just teardown noise at this point.
    process.exit(0);
  })
  .catch(err => {
    console.error('[cli-acp] fatal:', err);
    process.exit(1);
  });
