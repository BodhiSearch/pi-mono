# `hello-passive`

Smallest possible M6 extension. Subscribes to `session_start`
through `pi.on(...)` so `_bodhi/extensions/list` surfaces a
non-empty `capabilities.events: ["session_start"]`. The handler
body is intentionally empty — it exists to anchor the loader
contract (discovery, dynamic import, factory-arg validation,
capability recording, lifecycle dispatch).

## Origin

Synthesized for Phase 2 of the M6 Extensions plan. Originally
shipped as `hello/`; renamed to `hello-passive` in Phase 5 so it
can coexist with `hello-tool/` (the active sibling that registers
an LLM-callable tool).

## Diff vs upstream

n/a (newly synthesized).

## What it demonstrates

- The `default export = factory(pi)` contract.
- `pi.on(event, handler)` returns a `Disposable`; the
  registration is recorded onto `capabilities.events` even when
  the handler body itself does nothing.
- The loader walks every mounted volume's
  `<mount>/.pi/extensions/<name>/index.js`, dynamic-imports the
  module, and surfaces it through `_bodhi/extensions/list`.
