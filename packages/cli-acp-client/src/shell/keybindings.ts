/**
 * Configurable host-level keybindings.
 *
 * Per AGENTS.md: never hardcode `matchesKey(data, "ctrl+x")` inline —
 * keep every binding in this single map so users can override
 * defaults later. The TUI library (`pi-tui`) maintains its own
 * editor-level keybindings; these live one layer above and capture
 * keys before the focused component sees them (see
 * `tui.addInputListener`).
 */

export interface CliHostKeybindings {
  /** Cancel the current streaming turn. */
  cancelTurn: string;
}

export const DEFAULT_CLI_KEYBINDINGS: CliHostKeybindings = {
  cancelTurn: 'escape',
};
