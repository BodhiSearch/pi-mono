# pirate

Always-on pirate-persona system-prompt mutator. Demonstrates Phase 3
of the M6 Extensions plan: `pi.on('before_agent_start', ...)` returning
a `{ systemPrompt }` patch that's chained into the next handler and
ultimately fed to `inline.setModel`.

## Origin

Ported from `packages/coding-agent/examples/extensions/pirate.ts`.

## Diff vs upstream

- Drops `pi.registerCommand('pirate', ...)` and the `pirateMode` toggle
  state. `pi.registerCommand` lands in Phase 7 of the M6 plan; until
  then the persona is unconditionally on whenever the extension is
  loaded.
- Removes the upstream `/pirate` toggle UI; reload the extension to
  toggle for now.

## What it demonstrates

- `before_agent_start` runs once per `session/prompt` turn, before
  `inline.setModel`.
- The patched `systemPrompt` chains across extensions in load order —
  see `claude-rules` for a peer that prepends rule text in the same
  hook.
- Browser e2e (`extensions.spec.ts`) asserts the persona keyword
  surfaces in the assistant response after a single prompt.
