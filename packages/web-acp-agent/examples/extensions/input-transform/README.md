# input-transform

Demonstrates `pi.on('input', ...)` (Phase 4 of the M6 Extensions
plan): the extension intercepts user-supplied text after slash
expansion and rewrites it before the LLM sees it.

## Origin

Ported from
`packages/coding-agent/examples/extensions/input-transform.ts`.

## Diff vs upstream

- Drops the `ping` / `time` instant-response branches — those
  rely on `ctx.ui.notify`, which has no equivalent in M6 (UI
  primitives are out of scope until we have a host-side
  notification surface).
- Drops the `event.source === 'extension'` short-circuit because
  `pi.sendUserMessage` (extension-injected input) lands in Phase
  8; until then every `input` event is `source: 'user'` anyway.
- Tightens the transform text to make the e2e assertion stable
  ("QUICK:" sentinel — easier to grep than "1-2 sentences").

## What it demonstrates

- `input` fires per-turn after `#extractPromptText` and after
  vault slash expansion. The handler sees the final text the LLM
  would have received and can rewrite or refuse it.
- Returning `{ action: 'transform', text }` chains across
  extensions in load order — the next handler sees the rewritten
  string. Returning `{ action: 'handled' }` short-circuits the
  turn entirely (no `inline.prompt`). Returning `undefined` /
  `{ action: 'continue' }` passes through unchanged.
- Browser e2e (`extensions.spec.ts`) submits `?quick what is 2+2`
  and asserts the assistant reply is prefixed with "QUICK:" — the
  transform reached the LLM.
