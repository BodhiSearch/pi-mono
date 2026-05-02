/**
 * Wrapper around pi-tui's `CombinedAutocompleteProvider` that lets us
 * swap the slash-command list at runtime (when the agent emits a
 * fresh `available_commands_update`).
 *
 * The real provider keeps `commands` as a private field; rather than
 * mutate it via reflection, we recreate the inner provider whenever
 * `setSlashCommands` is called and forward `getSuggestions` to the
 * current instance.
 */

import {
  CombinedAutocompleteProvider,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
  type SlashCommand as TuiSlashCommand,
} from '@mariozechner/pi-tui';

export class DynamicAutocompleteProvider implements AutocompleteProvider {
  #inner: CombinedAutocompleteProvider;
  readonly #basePath: string;

  constructor(commands: TuiSlashCommand[], basePath: string) {
    this.#basePath = basePath;
    this.#inner = new CombinedAutocompleteProvider(commands, basePath);
  }

  setSlashCommands(commands: TuiSlashCommand[]): void {
    this.#inner = new CombinedAutocompleteProvider(commands, this.#basePath);
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean }
  ): Promise<AutocompleteSuggestions | null> {
    return this.#inner.getSuggestions(lines, cursorLine, cursorCol, options);
  }
}
