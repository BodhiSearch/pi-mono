# Sample vault — Phase 1 extensions only

Isolated fixture for `extensions.spec.ts`. Seeds `/vault/.pi/extensions/` with
the four original Phase 1 extension packages and nothing else so the LLM
turn in the "model can call the hello tool" step is not perturbed by every
Phase 2a / 2b hook (context injection, widget churn, title mutation, etc.).

Contents mirror the Phase 1 block of
`sample-with-extensions/README.md`:

- `fancy-prompt` — `/fancy-prompt` toggles pirate-style system prompt
  shaping via the `before_agent_start` hook.
- `hello-tool` — registers an LLM-callable `hello` tool.
- `broken` — intentionally malformed JS; loader captures the syntax error
  per-extension without taking down the rest of the scan.
- `thrower` — `before_agent_start` handler that throws; runner's error
  isolation + `extension_error` RPC event are exercised.

Phase 2a and Phase 2b fixtures live in `sample-with-extensions/` and are
driven by `extensions-ui.spec.ts` / `extensions-ui-2b.spec.ts`.
