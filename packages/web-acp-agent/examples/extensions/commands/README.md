# `commands`

Registers a `/volumes` slash command that lists every currently
mounted volume. Demonstrates Phase 7 of the M6 Extensions plan:
`pi.registerCommand(name, def)` returns a `Disposable`, the
command surfaces in `available_commands_update`, and dispatch
runs through the same muted-reply path as `/help` (no LLM call,
no entry into the LLM transcript).

## Origin

Ported (loosely) from
`packages/coding-agent/examples/extensions/commands.ts`.

## Diff vs upstream

- Upstream uses `ctx.ui.select`, `ctx.ui.confirm`, and
  `ctx.ui.notify` to drive an interactive command picker.
  web-acp has no UI surface for extensions in M6 — Phase 7 of
  the plan locks `pi.registerCommand` to text-only handlers
  returning a `string` (rendered as a muted reply, identical
  to built-in slash commands).
- Upstream's `pi.getCommands()` introspection API is not part
  of the Phase 7 surface; the demo command instead uses
  `pi.volumes.list()` (Phase 3) so it has something concrete
  to render and the e2e has a deterministic assertion target.
- Drops argument completion (`getArgumentCompletions`) — that
  belongs to a future host-side completion surface, not the
  agent runtime.

## What it demonstrates

- `pi.registerCommand(name, { description, handler })` registers
  a slash command. The registration surfaces on
  `ExtensionInfo.capabilities.commands` and rides the
  `available_commands_update` notification alongside
  built-ins and vault commands.
- The handler signature is `(args: string) => string |
  Promise<string>`. The returned text is emitted as a single
  muted reply (`_meta.bodhi.builtin.command` carries the
  command name) and persisted as a `'builtin'` entry, so
  replay reproduces the output verbatim.
- Last-write-wins conflict resolution: a second extension
  registering `/volumes` replaces this owner and the prior
  owner's `capabilities.commands` shrinks accordingly.
- Browser e2e (`extensions.spec.ts`) types `/volumes` and
  asserts the assistant bubble contains `/mnt/wiki` plus the
  builtin badge ("not sent to LLM") — proving the command ran
  on the agent without hitting the LLM.
