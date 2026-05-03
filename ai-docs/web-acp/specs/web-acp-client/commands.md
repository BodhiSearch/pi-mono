# Commands — picker UI, format helpers, host-side dispatch

**Source of truth:** `packages/web-acp/src/components/chat/CommandPicker.tsx`,
`packages/web-acp/src/lib/builtin-format.ts`,
`packages/web-acp/src/acp/builtin-dispatch.ts`,
`packages/web-acp/src/acp/streaming-reducer.ts`.

## Purpose

Host-side commands surface — what the user sees + what
happens locally when a built-in's reply carries an
`action`. The vault discovery, expansion, built-in handler
logic, and ACP wire emission all live in the agent package
([`../web-acp-agent/commands.md`](../web-acp-agent/commands.md));
the host's job is:

1. Display the merged command list (`available_commands_update`)
   in a picker.
2. Render built-in replies muted with a "not sent to LLM"
   badge.
3. Dispatch the per-kind client-side action (`/copy` writes
   to clipboard; `/mcp add` updates IDB + retriggers login).
4. Detect a built-in invocation client-side at *send* time
   so the user message bubble also gets the muted treatment
   (the agent's persistence picks this up symmetrically via
   `recordBuiltin`).

## Picker UI — `components/chat/CommandPicker.tsx`

Headless palette. Renders above the chat input when the
input starts with `/`. Props:

```tsx
interface CommandPickerProps {
    open: boolean;
    query: string;                          // text after the leading '/'
    commands: readonly AvailableCommand[];  // from useAcp().availableCommands
    onSelect: (command: AvailableCommand) => void;
    onDismiss: () => void;
}
```

Internal state: `rawHighlight: number` for keyboard nav.
Behaviour:

- `state = !open ? 'closed' : filtered.length === 0 ? 'empty' : 'open'`
  surfaces as `data-test-state` on the container so
  Playwright can wait deterministically.
- Each item carries `data-testid="command-picker-item-<name>"`
  and is clickable; activating an item fires `onSelect(cmd)`.
- Window-level keydown listener while open — `Escape` =
  dismiss, `ArrowUp` / `ArrowDown` = move highlight,
  `Enter` = select highlighted. `Tab` is **not** wired
  (key falls through to default browser focus behaviour).

`filterCommands(commands, query)` does a case-insensitive
**prefix** match against `name` (`startsWith`). Typing `/elp`
will not match `/help`. The list is **black-box** — the
picker doesn't differentiate built-ins from vault commands or
prompt templates (no kind discriminator on
`AvailableCommand`).

The picker consumes `useAcp().availableCommands`, which is
populated by the streaming reducer from
`available_commands_update` notifications (see
[`acp.md`](./acp.md) § streaming-reducer).

## Built-in detection at send time — `acp/message-shape.ts:detectBuiltinTag`

When the user submits, `useAcpStreaming.sendMessage` (see
[`hooks.md`](./hooks.md)) calls
`detectBuiltinTag(prompt, availableCommands)` to figure out
whether the input is a built-in invocation. If yes, the
user message is stamped with `_builtin: { command }` so the
bubble renders muted before the agent's reply lands. The
detection mirrors the agent's `findBuiltin` strict-prefix
rule (`/<name>` followed by EOS or whitespace).

The detection is **best-effort** — vault commands sharing a
prefix would also match. The agent's `findBuiltin` is
authoritative; the host detection is a UX optimisation so
the muted styling appears synchronously.

## Built-in format helpers — `lib/builtin-format.ts`

Bridges between the AgentMessage in-memory shape (with
`_builtin` marker) and the wire `_meta.bodhi.builtin`
envelope. Pure functions; no React.

**Exported** helpers:

| Function | Purpose |
| --- | --- |
| `getBuiltinTag(msg)` (`:12`) | Reads `(msg as any)._builtin: BodhiBuiltinTag \| undefined`. |
| `withBuiltinTag(msg, tag)` (`:16`) | Spreads `msg` and sets `_builtin: tag`. Body is `{ ...(msg as unknown as Record<string, unknown>), _builtin: tag } as unknown as T`. The double `unknown` cast exists because `AgentMessage` is a discriminated union and TypeScript's spread-on-union typing requires an explicit any-cast bridge — the cast is not about narrowing. |
| `extractBuiltinMeta(meta)` (`:27`) | Reads `_meta.bodhi.builtin` from a `SessionNotification` and validates the shape. Returns `BodhiBuiltinTag` or `undefined`. |
| `renderConversationMarkdown(messages)` | Renders the LLM-only conversation as markdown for `/copy`. Skips entries with `_builtin` set so the clipboard payload is the model conversation, not the built-in chrome. |

**Module-private** helpers (used inside `lib/builtin-format.ts`
only — not exported, do not import):

- `narrowBuiltinAction(input)` (`:46`) — per-kind validator
  for the `action` payload. `'copy'` is parameterless;
  `'mcp-add' | 'mcp-remove'` require `params: { url: string }`.
  Unknown kinds / malformed payloads return `undefined` so
  only fully-narrowed values reach the dispatcher.
- `extractText(msg)` (`:62`) — joins all `text` content
  blocks of an `AgentMessage`. Used by
  `renderConversationMarkdown`.

The streaming reducer carries the `_builtin` tag through the
chunk-accumulation path:

```ts
const carriedTag = builtinMeta ?? getBuiltinTag(current);
if (carriedTag) next = withBuiltinTag(next, carriedTag);
```

That means a built-in's reply, even if it streams across
multiple chunks, lands on `state.streamingMessage` with the
tag stamped — the bubble renderer sees `_builtin` and
renders the muted style + "not sent to LLM" badge.

## Host-side action dispatch — `acp/builtin-dispatch.ts:dispatchBuiltinAction`

Canonical reference: [`acp.md`](./acp.md) § builtin-dispatch
(documents the full `(action, messages, triggerLogin)`
signature, the per-kind switch, the `addRequestedMcp` /
`removeRequestedMcp` IDB writes, the `triggerLogin` closure
shape, and the toast paths). This file does not duplicate the
table — read `acp.md` when you need the dispatch detail.

Action is pulled off the streaming-message's `_builtin.action`
slot in `useAcpStreaming.sendMessage` after the prompt
resolves:

```ts
const replyTag = getBuiltinTag(finalMsg);
if (replyTag?.action) {
    void dispatchAction(replyTag.action, messagesRef.current);
}
```

`messagesRef.current` is snapshotted *before* the appended
built-in pair, giving `/copy` the LLM-only conversation.

## Bubble rendering

`components/chat/MessageBubble.tsx` (the renderer) checks
`getBuiltinTag(msg)` and applies:

- Muted styling — `bg-blue-100` for user built-in bubbles,
  `bg-gray-100` for assistant built-in bubbles.
- "not sent to LLM" badge.
- A different `data-test-state` so e2e tests can target
  builtin bubbles specifically.

The renderer is the single place the in-memory `_builtin`
marker affects visual output; everything else (storage,
wire) flows through cleanly without touching the bubble.

## Tool-call bubbles — `components/chat/BashToolCall.tsx`

Sister component to `MessageBubble` for `tool_call` /
`tool_call_update` notifications. Reads from
`state.toolCalls: Map<string, ToolCallView>` (populated by
the streaming reducer). Renders:

- The `tool_call.title` (e.g. `bash: echo hello`).
- Status chip via `data-test-state="running | completed |
  failed"`.
- Stdout / stderr panes parsed from
  `tool_call_update.rawOutput` (which carries the `BashToolDetails`
  JSON the agent produced — see
  [`../web-acp-agent/tools.md`](../web-acp-agent/tools.md)).
- Truncation warning when `details.truncated === true`.
- An `expanded` / `collapsed` state for verbose output;
  defaults to expanded for `failed` runs.

## Wire shape consumed

The host's view of the agent's wire output:

- `available_commands_update` (`session/update`) → reducer
  routes into `state.availableCommands` (replay-guard
  bypassed; latest list always wins).
- `agent_message_chunk` with `_meta.bodhi.builtin` →
  reducer's accumulation path stamps `_builtin` onto the
  streaming message.
- `tool_call` / `tool_call_update` → reducer keys
  `state.toolCalls` by `toolCallId`.

Detail of each route in [`acp.md`](./acp.md) § streaming-reducer.

## Cross-references

- Vault command + built-in handler definitions:
  [`../web-acp-agent/commands.md`](../web-acp-agent/commands.md).
- Streaming reducer accumulation path:
  [`acp.md`](./acp.md).
- Hook layer that drives the picker + dispatch:
  [`hooks.md`](./hooks.md).
- Sessions persistence (`'builtin'` `SessionEntry` kind):
  [`../web-acp-agent/sessions.md`](../web-acp-agent/sessions.md).
