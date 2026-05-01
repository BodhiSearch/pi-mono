/**
 * Simple bounded history buffer for the input editor. The TUI binds
 * up/down arrow keys to `previous()` / `next()`. Persistence to
 * `.cli-acp-client/history` is deferred to a follow-up.
 */

const DEFAULT_CAP = 200;

export class History {
  readonly #items: string[] = [];
  readonly #cap: number;
  #cursor: number;

  constructor(cap = DEFAULT_CAP) {
    this.#cap = cap;
    this.#cursor = 0;
  }

  push(line: string): void {
    if (line.length === 0) return;
    if (this.#items.at(-1) === line) {
      this.#cursor = this.#items.length;
      return;
    }
    this.#items.push(line);
    if (this.#items.length > this.#cap) this.#items.shift();
    this.#cursor = this.#items.length;
  }

  previous(): string | undefined {
    if (this.#items.length === 0) return undefined;
    this.#cursor = Math.max(0, this.#cursor - 1);
    return this.#items[this.#cursor];
  }

  next(): string | undefined {
    if (this.#items.length === 0) return undefined;
    this.#cursor = Math.min(this.#items.length, this.#cursor + 1);
    return this.#cursor === this.#items.length ? '' : this.#items[this.#cursor];
  }

  snapshot(): string[] {
    return [...this.#items];
  }
}
