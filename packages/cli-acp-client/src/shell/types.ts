/**
 * Renderer-agnostic message types emitted by the shell. The TUI (pi-tui)
 * and the CI line-mode renderer both consume these and decide how to
 * present them. The shell layer never imports pi-tui or chalk directly.
 */

export type ConnectionStatus =
  | { kind: 'disconnected'; reason?: string }
  | { kind: 'connecting'; host: string }
  | { kind: 'authenticating'; host: string }
  | { kind: 'authenticated'; host: string; modelId?: string };

export interface ShellMessage {
  /** Stable id for streaming updates; omit for one-shot lines. */
  id?: string;
  kind: 'info' | 'error' | 'user' | 'assistant' | 'system' | 'tool';
  text: string;
}

export interface Renderer {
  /** Write a ShellMessage. If `id` is set and a previous message had the
   *  same id, the renderer may replace it (used for streaming assistant
   *  output and live tool-call updates). */
  emit(message: ShellMessage): void;
  /** Update the connection status indicator surfaced in the status bar. */
  setStatus(status: ConnectionStatus): void;
  /** Render a list of registered slash commands for `/help`. */
  renderHelp(commands: SlashCommandSummary[]): void;
}

export interface SlashCommandSummary {
  name: string;
  description: string;
  usage?: string;
}
