# `session-counter`

Minimal `pi.session.appendEntry` exerciser. Increments a turn
counter on every `before_agent_start` and persists the new value
through `pi.session.appendEntry('counter', { turns })`. Reload
the host and the counter sequence is rebuilt from the persisted
`extension` entries via `walkEntries` in `acp/engine/replay.ts`.

## Origin

Synthesized for Phase 8 of the M6 Extensions plan. The
coding-agent reference set has `session-name` and `bookmark`
extensions that exercise `setName` / `setLabel`; this synthetic
sibling targets the same `pi.session.*` surface but with the
simplest possible state shape (a single integer) so the e2e
assertion stays cheap.

## Diff vs upstream

n/a (newly synthesized).

## What it demonstrates

- `pi.session.appendEntry(customType, data)` writes a custom
  entry that the host persists under `kind: 'extension'` and
  replays as a muted assistant chunk on `session/load`.
- Closure-held state (`turns`) reconstructs from the persisted
  trail when the host reloads — extensions with reload-survival
  semantics initialise from the latest entry rather than carrying
  state across the IPC boundary.
- `before_agent_start` is the right hook for "fires once per
  user-visible turn" use cases (it runs after built-in / extension
  command short-circuits, so `/help` etc. do not bump the count).
