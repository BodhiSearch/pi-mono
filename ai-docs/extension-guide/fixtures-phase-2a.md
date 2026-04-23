# Phase 2a fixtures

Five extensions that live under
`packages/web-agent/e2e/data/sample-with-extensions/.pi/extensions/`.
They exercise the Phase 2a hook surface (`on('context')`,
`on('tool_call')`, `on('turn_start')`, `on('message_end')`,
`on('session_loaded')`) and the modal-only `pi.ui.*` channel
(`notify`, `setStatus`, `select`, `confirm`, `input`).

- [`context-injector`](#context-injector)
- [`tool-gate`](#tool-gate)
- [`notifier`](#notifier)
- [`asker`](#asker)
- [`reload-observer`](#reload-observer)

---

## `context-injector`

Path: `context-injector/index.js`

**Capability demonstrated:** the `on('context')` reducer can rewrite the
message list the agent sends to the LLM. The hook sees
`event.messages` and returns `{ messages: newList }`; the runner uses
the returned list for the next stream call.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/ctx-show` | Toast reporting the last observed incoming and returned message counts. |

**Hooks**

- `pi.on('context', event => { … })` — prepends a synthetic user
  preamble (`[pi-ext] injected preamble from context-injector`) to
  every outgoing LLM payload and captures the before/after lengths.

**How to try it**

1. Send any chat message. The LLM call silently receives an extra
   leading user message.
2. Run `/ctx-show` — a toast appears like
   `context hook: in=3 out=4` confirming one message was injected.

**What to look for**

- The injected message is invisible in the transcript; only the
  count changes.
- Running this extension with a small model can make tool-use prompts
  unreliable, which is why the Phase 1 `extensions.spec.ts` uses the
  dedicated `sample-phase-1-extensions/` vault.

---

## `tool-gate`

Path: `tool-gate/index.js`

**Capability demonstrated:** the `on('tool_call')` reducer can
*mutate* tool input in place before the executor sees it, or
short-circuit execution by returning `{ block: true, reason }`. The
fixture also registers its own tool (`gated`) so the extension can
drive the hook from a command handler without relying on the LLM.

**Tools registered**

| Tool | Parameters | Behaviour |
|------|-----------|-----------|
| `gated` | `{ payload: string, block?: boolean, tag?: string }` | Returns `gated:<payload>:<tag>`. |

**Slash commands**

| Command | Effect |
|---------|--------|
| `/gate-run <payload>` | Invoke `gated` with `payload` directly; `tool_call` hook tags it as `mutated`. Surfaces result via a toast. |
| `/gate-run block` | Invoke with `block:true` so the hook short-circuits. Surfaces a warning toast with the block reason. |

**Hooks**

- `pi.on('tool_call', event => { … })` — mutates `event.input.tag =
  'mutated'` for `gated`; returns `{ block: true, reason: '…' }` when
  the caller sets `input.block = true`.

**How to try it**

1. `/gate-run hi` — toast `gated tool ran: gated:hi:mutated`.
2. `/gate-run block` — toast `gated tool blocked: tool-gate: blocked by
   policy`.

**What to look for**

- The hook runs for any tool with name `gated`; unrelated tools
  short-circuit immediately.
- In-place mutation is the intended pattern — the reducer can also
  return `{ input: newInput }` if the caller wants to replace the
  argument object entirely.

---

## `notifier`

Path: `notifier/index.js`

**Capability demonstrated:** the observer-only hooks `turn_start` and
`message_end` fire for every turn. Good smoke test for wiring + a demo
of `pi.ui.notify` and the toast channel.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/notify-test [info|warning|error]` | Emit a toast through `pi.ui.notify`. |
| `/notify-stats` | Toast reporting total `turn_start` / `message_end` counts. |

**Hooks**

- `pi.on('turn_start', () => turnStarts += 1)`.
- `pi.on('message_end', () => messageEnds += 1)`.

**How to try it**

1. `/notify-test warning` — a yellow toast appears in the bottom-right
   corner.
2. Send a chat message. After the response lands, run `/notify-stats`
   to see both counters non-zero.

**What to look for**

- Toasts are queued; dismiss with the close button on each or let them
  auto-expire.
- `message_end` fires once per message (user, assistant, tool-result),
  not once per turn.

---

## `asker`

Path: `asker/index.js`

**Capability demonstrated:** the modal UI channel.
`ctx.ui.select`, `ctx.ui.confirm`, and `ctx.ui.input` each surface as a
dialog via the FIFO modal queue; the handler awaits the user's
response, and `pi.ui.setStatus` drives a persistent status chip.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/ask-select` | Open a select dialog offering red/green/blue; toast the chosen value. |
| `/ask-confirm` | Open a confirm dialog ("Proceed?"); toast `true`/`false`. |
| `/ask-input` | Open an input dialog; toast the echoed value. |
| `/ask-status <text>` | Set the status chip. Passing `clear` (or an empty string) removes it. |

**Hooks**

None — exclusively driven from command handlers.

**How to try it**

1. `/ask-select` — pick a colour, see a toast `asker: select returned
   green`.
2. `/ask-confirm` — press Cancel and see `asker: confirm returned
   false`.
3. `/ask-input` — type something, press Enter, see the echo toast.
4. `/ask-status awaiting review` then `/ask-status clear`.

**What to look for**

- Only one dialog at a time; others queue. If you `/ask-select` then
  immediately `/ask-confirm`, the confirm waits until the select
  resolves.
- Status chip renders in the chat header with
  `data-testid="extension-status-chip"`.
- If the session is reset while a dialog is open, the promise resolves
  with `undefined` (select/input) or `false` (confirm) and the dialog
  closes. This is the deliberate cancel-on-reset behaviour.

---

## `reload-observer`

Path: `reload-observer/index.js`

**Capability demonstrated:** `on('session_loaded')` — fires on every
session transition. In Phase 2a this was only driven from `/reload`;
Phase 2b widened the `event.reason` union to include `'mount' |
'reload' | 'switch' | 'fork' | 'new' | 'navigate'`.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/reload-count` | Toast reporting the number of `reload` events observed. |

**Hooks**

- `pi.on('session_loaded', event => { if (event.reason === 'reload')
  reloadCount += 1; })` — only counts the `reload` reason; ignores the
  other five transitions.

**How to try it**

1. Run `/reload-count` — initial toast `reload-observer: count=0`.
2. Run the `/reload` slash command (reloads the current session).
3. Run `/reload-count` again — count is now `1`.

**What to look for**

- The counter increments only on `/reload`; using the "New chat"
  button (which emits `session_loaded.reason = 'new'`) does *not*
  bump it.
- For a fixture that responds to the full reason union, see
  [`title-marker`](./fixtures-phase-2b.md#title-marker).
