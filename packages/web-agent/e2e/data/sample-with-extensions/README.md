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

Each extension ships a single `index.js` entry — TypeScript source loading
is a Phase 3 concern (see `ai-docs/extension-impl/phase-3-prompt.md`).
