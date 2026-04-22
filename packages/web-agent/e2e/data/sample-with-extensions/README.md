# Sample vault with extensions

Fixture for `extensions.spec.ts`. Seeds `/vault/.pi/extensions/` with four
tiny extension packages that exercise the Phase 1 surface:

- `fancy-prompt` — ports `packages/coding-agent/examples/extensions/pirate.ts`
  down to the browser-compatible subset. Toggles a system-prompt override
  via `/fancy-prompt` and wires the `before_agent_start` hook. Adaptation:
  drops `ctx.ui.notify` (no UI RPC channel in Phase 1) and swaps the
  `@mariozechner/pi-coding-agent` import for the `pi` object passed
  directly to the factory.
- `hello-tool` — ports `packages/coding-agent/examples/extensions/hello.ts`.
  Uses `pi.Type` + `pi.defineTool` re-exports instead of importing
  `@mariozechner/pi-ai` and `@mariozechner/pi-coding-agent` (the worker
  has no bundler-style module resolver for extension code).
- `broken` — intentionally malformed JS to verify the loader captures
  syntax errors per-extension without taking down the rest of the scan.
- `thrower` — registers a `before_agent_start` handler that throws on
  every turn. Verifies the runner's error isolation and the
  `extension_error` RPC event.

Phase 2a adds five more fixtures exercising the new context / tool_call /
lifecycle hooks and the `pi.ui.*` channel:

- `context-injector` — subscribes to `on('context')`, prepends a synthetic
  user preamble on every LLM call, and surfaces the last observed
  `messages` count via the `/ctx-show` command so the e2e spec can
  assert on the hook's effect without LLM output.
- `tool-gate` — registers a `gated` tool and subscribes to
  `on('tool_call')`. The hook mutates `event.input.tag` in place and
  short-circuits with `{ block: true }` when the caller sets
  `input.block = true`. The `/gate-run` command drives the tool so the
  test doesn't depend on the LLM choosing it.
- `notifier` — subscribes to the observer-only `on('turn_start')` and
  `on('message_end')` hooks (Phase 2a fan-out). `/notify-test` emits a
  toast through `pi.ui.notify`; `/notify-stats` reports the observed
  counts.
- `asker` — registers `/ask-select`, `/ask-confirm`, `/ask-input`, and
  `/ask-status` so the spec can open each dialog kind (plus the
  `setStatus` chip surface) and assert the round-tripped answer through
  `pi.ui.notify`.
- `reload-observer` — subscribes to `on('session_loaded')`, which Phase 2a
  dispatches only from `/reload`. Increments a counter on every fire;
  `/reload-count` surfaces the counter as a toast.

Each extension ships a single `index.js` entry — TypeScript source loading
is a Phase 3 concern (see `ai-docs/extension-impl/phase-3-prompt.md`).
