/**
 * pi-tui-backed renderer + REPL.
 *
 * Lays out a vertical stack:
 *   [welcome banner]
 *   [chat history container — appended user/assistant/tool/info Text]
 *   [editor with slash autocomplete]
 *
 * Runs an `Editor.onSubmit` loop that pushes lines into the dispatcher.
 * Streaming is handled by tracking the per-id last `Text` component so
 * we can `setText` in place rather than appending fragment lines.
 *
 * The renderer is intentionally minimal — markdown rendering, message
 * widgets, and richer status bars are easy to add by swapping in
 * `Markdown` or custom `Component`s without changing the shell layer.
 */

import { Chalk } from 'chalk';
import {
  Editor,
  matchesKey,
  ProcessTerminal,
  type SlashCommand as TuiSlashCommand,
  Text,
  TUI,
} from '@mariozechner/pi-tui';
import type { ConnectionStatus, Renderer, ShellMessage, SlashCommandSummary } from '../shell/types';
import { DEFAULT_CLI_KEYBINDINGS, type CliHostKeybindings } from '../shell/keybindings';
import { DynamicAutocompleteProvider } from './dynamic-autocomplete';
import { defaultEditorTheme } from './themes';

const chalk = new Chalk({ level: 3 });

export interface PiRendererSubmitContext {
  submit: (line: string) => Promise<void>;
}

export interface PiRendererInit {
  banner?: string;
  /** Slash commands to register with the autocomplete provider. */
  slashCommands: SlashCommandSummary[];
  basePath: string;
  /** Set up the submit handler — called once after the editor is ready. */
  onSubmit: (line: string) => Promise<void>;
  /**
   * Host-level keybindings (Esc to cancel etc). Falls back to
   * `DEFAULT_CLI_KEYBINDINGS` when omitted.
   */
  keybindings?: CliHostKeybindings;
  /**
   * Called when the user presses the cancel-turn key (Esc by
   * default). Return `true` to consume the keypress (so the editor
   * doesn't see it); return `false` to fall through to the editor's
   * own Esc handler (e.g. dismiss autocomplete popup).
   */
  onCancelTurn?: () => boolean;
}

export interface PiRendererRuntime {
  renderer: Renderer;
  /** Resolves when the user requests quit (Ctrl+C). */
  exited: Promise<void>;
  /** Force-stop the TUI. Called from the `/quit` controller. */
  stop: () => void;
  /**
   * Update the autocomplete provider's slash-command list. Called by
   * the StreamController when the agent emits an
   * `available_commands_update`.
   */
  setSlashCommands: (commands: SlashCommandSummary[]) => void;
}

export function createPiRenderer(init: PiRendererInit): PiRendererRuntime {
  const terminal = new ProcessTerminal();
  const tui = new TUI(terminal);

  if (init.banner) {
    tui.addChild(new Text(init.banner));
  }

  const statusText = new Text(formatStatus({ kind: 'disconnected', reason: 'starting' }));
  tui.addChild(statusText);

  const editor = new Editor(tui, defaultEditorTheme);
  const autocompleteProvider = new DynamicAutocompleteProvider(
    init.slashCommands.map(toTuiSlashCommand),
    init.basePath
  );
  editor.setAutocompleteProvider(autocompleteProvider);
  tui.addChild(editor);
  tui.setFocus(editor);

  const keybindings = init.keybindings ?? DEFAULT_CLI_KEYBINDINGS;
  const cancelHandler = init.onCancelTurn;
  if (cancelHandler) {
    tui.addInputListener(data => {
      if (!matchesKey(data, keybindings.cancelTurn)) {
        return undefined;
      }
      const consumed = cancelHandler();
      return consumed ? { consume: true } : undefined;
    });
  }

  const messageById = new Map<string, Text>();

  const renderer: Renderer = {
    emit(message: ShellMessage): void {
      const colored = colorize(message);
      const existing = message.id ? messageById.get(message.id) : undefined;
      if (existing) {
        existing.setText(colored);
        tui.requestRender();
        return;
      }
      const text = new Text(colored, 1, 0);
      if (message.id) messageById.set(message.id, text);
      // Insert before the editor so the editor stays at the bottom.
      const children = tui.children;
      children.splice(Math.max(children.length - 1, 0), 0, text);
      tui.requestRender();
    },
    setStatus(status: ConnectionStatus): void {
      statusText.setText(formatStatus(status));
      tui.requestRender();
    },
    renderHelp(commands: SlashCommandSummary[]): void {
      const lines = ['Available commands:'];
      for (const cmd of commands) {
        lines.push(
          `  ${chalk.cyan('/' + cmd.name).padEnd(18)} ${chalk.dim(cmd.description)}${cmd.usage ? `  ${chalk.dim(cmd.usage)}` : ''}`
        );
      }
      this.emit({ kind: 'info', text: lines.join('\n') });
    },
  };

  let exitResolve!: () => void;
  const exited = new Promise<void>(resolve => {
    exitResolve = resolve;
  });

  let busy = false;
  editor.onSubmit = async (value: string) => {
    if (busy) return;
    busy = true;
    editor.disableSubmit = true;
    try {
      await init.onSubmit(value);
    } finally {
      busy = false;
      editor.disableSubmit = false;
      tui.requestRender();
    }
  };

  tui.start();

  return {
    renderer,
    exited,
    stop(): void {
      try {
        tui.stop();
      } catch {
        // ignore
      }
      exitResolve();
    },
    setSlashCommands(commands: SlashCommandSummary[]): void {
      autocompleteProvider.setSlashCommands(commands.map(toTuiSlashCommand));
    },
  };
}

function toTuiSlashCommand(summary: SlashCommandSummary): TuiSlashCommand {
  return { name: summary.name, description: summary.description };
}

function colorize(message: ShellMessage): string {
  switch (message.kind) {
    case 'user':
      return chalk.cyan(`> ${message.text}`);
    case 'assistant':
      return message.text;
    case 'tool':
      return chalk.yellow(message.text);
    case 'error':
      return chalk.red(message.text);
    case 'system':
      return chalk.dim(message.text);
    case 'info':
    default:
      return chalk.dim(message.text);
  }
}

function formatStatus(status: ConnectionStatus): string {
  switch (status.kind) {
    case 'disconnected':
      return chalk.dim(`◯ disconnected${status.reason ? ` — ${status.reason}` : ''}`);
    case 'connecting':
      return chalk.yellow(`◌ connecting to ${status.host}`);
    case 'authenticating':
      return chalk.yellow(`◌ authenticating with ${status.host}`);
    case 'authenticated':
      return chalk.green(
        `● authenticated to ${status.host}${status.modelId ? ` model=${status.modelId}` : ''}`
      );
  }
}
