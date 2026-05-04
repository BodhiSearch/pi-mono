# Commands — picker UI, format helpers, host-side dispatch

**Source of truth:** `packages/web-acp/src/components/chat/CommandPicker.tsx`,
`packages/web-acp/src/lib/builtin-format.ts`,
`packages/web-acp/src/acp/builtin-dispatch.ts`,
`packages/web-acp/src/acp/streaming-reducer.ts`,
`packages/web-acp/src/acp/message-shape.ts:parseBuiltinActionParams`.

## Purpose

Host-side commands surface — what the user sees + what
happens locally when a built-in fires its optional client-side
action. The vault discovery, expansion, built-in handler
logic, and ACP wire emission all live in the agent package
([`../web-acp-agent/commands.md`](../web-acp-agent/commands.md));
the host's job is:

1. Display the merged command list (`available_commands_update`)
   in a picker.
2. Render built-in replies muted with a "not sent to LLM"
   badge.
3. Dispatch the per-kind client-side action (`/copy` writes
   to clipboard; `/mcp add` updates IDB + retriggers login)
   when the agent emits an
   `extNotification("_bodhi/builtin/action")`.
4. Detect a built-in invocation client-side at *send* time
   so the user message bubble also gets the muted treatment
   (the agent's persistence picks this up symmetrically via
   `recordBuiltin`).

## Picker UI — `components/chat/CommandPicker.tsx`

Headless palette. Renders above the chat input when the
input starts with `/`. Props (`:4-10`):

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

- `state = !open ? 'closed' : filtered.length === 0 ? 'empty'
  : 'open'` (`:31`) surfaces as `data-test-state` on the
  container so Playwright can wait deterministically.
- Each item carries `data-testid="command-picker-item-<name>"`
  (`:90`) and is clickable; activating an item fires
  `onSelect(cmd)` via `onMouseDown` (`:95-98`) — chosen
  over `onClick` so the input doesn't lose focus before the
  selection commits.
- Window-level keydown listener while open (`:33-61`):
  `Escape` → dismiss, `ArrowUp` / `ArrowDown` → move
  highlight, `Enter` → select highlighted. `Tab` is **not**
  wired (key falls through to default browser focus
  behaviour).

`filterCommands(commands, query)` (`:114`) does a
case-insensitive **prefix** match against `name` (`startsWith`).
Typing `/elp` will not match `/help`. The list is
**black-box** — the picker doesn't differentiate built-ins
from vault commands or prompt templates (no kind discriminator
on `AvailableCommand`).

The picker consumes `useAcp().availableCommands`, which is
populated by `panelsReducer` from
`available_commands_update` notifications (see
[`acp.md`](./acp.md) § panelsReducer).

## Built-in detection at send time — `acp/message-shape.ts:detectBuiltinTag` (`:71`)

When the user submits, `useAcpStreaming.sendMessage` (see
[`hooks.md`](./hooks.md)) calls `detectBuiltinTag(prompt)`
to figure out whether the input is a built-in invocation. If
yes, the user message is stamped with `_builtin: { command }`
via `withBuiltinTag` so the bubble renders muted before the
agent's reply lands. The detection mirrors the agent's
`findBuiltin` strict-prefix rule (`/<name>` followed by EOS or
whitespace) and reuses `isBuiltinName` re-exported from
`@bodhiapp/web-acp-agent` so the host's allowlist stays in
sync with the agent's registry without a duplicate constant.

## Built-in format helpers — `lib/builtin-format.ts`

Bridges between the AgentMessage in-memory shape (with
`_builtin` marker) and the wire `_meta.bodhi.builtin`
envelope. Pure functions; no React.

**Exported** helpers:

| Function | Purpose |
| --- | --- |
| `getBuiltinTag(msg)` (`:12`) | Reads `(msg as any)._builtin: BodhiBuiltinTag \| undefined`. |
| `withBuiltinTag(msg, tag)` (`:16`) | Spreads `msg` and sets `_builtin: tag`. The double `unknown` cast bridges TypeScript's discriminated-union spread typing — it is not narrowing anything. |
| `extractBuiltinMeta(meta)` (`:28`) | Reads `_meta.bodhi.builtin` from a `SessionNotification._meta` envelope. Validates only `command: string`; the `action` field is no longer carried on the chunk and is not read here. |
| `renderConversationMarkdown(messages)` (`:66`) | Renders the LLM-only conversation as markdown for `/copy`. Skips entries with `_builtin` set so the clipboard payload is the model conversation, not the built-in chrome. Also skips `toolResult` messages and tool-call-only assistant messages. |

`extractText(msg)` (`:39`, module-private) joins all `text`
content blocks of an `AgentMessage`. Used by
`renderConversationMarkdown`. `narrowBuiltinAction` was
removed when the action moved off the chunk — its
responsibilities are now split across
`acp/message-shape.ts:parseBuiltinActionParams` (validation
on the `extNotification` arrival path) and the static
`AnyBodhiBuiltinAction` discriminated-union types re-exported
from the agent package via `@/acp/index`.

The streaming reducer carries the `_builtin` tag through the
chunk-accumulation path
(`acp/streaming-reducer.ts:139–155`):

```ts
const builtinMeta = extractBuiltinMeta(notification._meta);
// ...
const carriedTag = builtinMeta ?? getBuiltinTag(current);
if (carriedTag) next = withBuiltinTag(next, carriedTag);
```

That means a built-in's reply, even if it streams across
multiple chunks, lands on `state.streamingMessage` with the
tag stamped — the bubble renderer sees `_builtin` and
renders the muted style + "not sent to LLM" badge.

## Action arrival path — `extNotification("_bodhi/builtin/action")`

Built-ins that need a client-side side-effect (`/copy`,
`/mcp add`, `/mcp remove`) split their reply across two
wire surfaces:

1. **Reply text** rides `agent_message_chunk` with
   `_meta.bodhi.builtin = { command }` so the bubble
   renders muted (handled above by the streaming reducer).
2. **Action payload** rides
   `extNotification("_bodhi/builtin/action", { sessionId,
   command, action })` so it doesn't pollute the chunk
   stream.

The host wires the second leg in `useAcpStreaming`'s
unified subscribe block (`hooks/useAcpStreaming.ts:65–87`):

```ts
const unsubExt = runtime.client.onExtNotification((method, params) => {
  // ...
  if (method === BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD) {
    const action = parseBuiltinActionParams(params);
    if (action) void dispatchActionRef.current(action, messagesRef.current);
    return;
  }
  // ...
});
```

`parseBuiltinActionParams` (`acp/message-shape.ts:111`) is
the validation gate: it checks `action.kind` is one of
`'copy' | 'mcp-add' | 'mcp-remove'` and that `mcp-add` /
`mcp-remove` carry a string `params.url`. Malformed payloads
return `undefined` so a non-Bodhi agent (or a bad build)
can't crash `dispatchAction`.

The action is then forwarded to the dispatcher via
`dispatchActionRef.current` — a ref-mirror of the latest
`dispatchAction` callback, so the listener doesn't have to
re-subscribe on every dispatch identity churn (the underlying
`dispatchAction` closure changes when `triggerLogin` changes).
`messagesRef.current` is also a ref-mirror so the dispatcher
sees the live `state.messages` array.

## Host-side action dispatch — `acp/builtin-dispatch.ts:dispatchBuiltinAction` (`:43`)

Canonical reference: [`acp.md`](./acp.md) § builtin-dispatch
(documents the full `(action, messages, triggerLogin)`
signature, the per-kind switch, the `addRequestedMcp` /
`removeRequestedMcp` IDB writes, the `triggerLogin` closure
shape, and the toast paths). This file does not duplicate the
table — read `acp.md` when you need the dispatch detail.

The dispatcher is invoked exactly once per built-in turn, on
the `extNotification` arrival above. It is **not** called
from `sendMessage` / `turn-end` — the legacy
`replyTag.action` plumbing (which read the action off the
streaming message's `_builtin.action` slot) is gone.

## Bubble rendering

`components/chat/MessageBubble.tsx` (the renderer) checks
`getBuiltinTag(msg)` and applies:

- Muted styling — `bg-blue-100` for user built-in bubbles,
  `bg-gray-100` for assistant built-in bubbles.
- "not sent to LLM" badge.
- A different `data-test-state` so e2e tests can target
  built-in bubbles specifically.

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
  `tool_call_update.rawOutput` (which carries the
  `BashToolDetails` JSON the agent produced — see
  [`../web-acp-agent/tools.md`](../web-acp-agent/tools.md)).
- Truncation warning when `details.truncated === true`.
- An `expanded` / `collapsed` state for verbose output;
  defaults to expanded for `failed` runs.

## Wire shape consumed

The host's view of the agent's wire output:

- `available_commands_update` (`session/update`) →
  `panelsReducer` arm routes into `panelsState.availableCommands`
  (replay-guard bypassed; latest list always wins).
- `agent_message_chunk` with `_meta.bodhi.builtin` →
  `streamingReducer` accumulation path stamps `_builtin`
  onto the streaming message.
- `extNotification("_bodhi/builtin/action")` →
  `parseBuiltinActionParams` →
  `dispatchActionRef.current(action, messagesRef.current)`
  → toast / clipboard / `triggerLogin`.
- `tool_call` / `tool_call_update` → `streamingReducer`
  keys `state.toolCalls` by `toolCallId`.

Detail of each route in [`acp.md`](./acp.md) § streamingReducer
and § panelsReducer.

## Cross-references

- Vault command + built-in handler definitions + the
  agent-side wire emission of both legs:
  [`../web-acp-agent/commands.md`](../web-acp-agent/commands.md).
- Streaming reducer accumulation path + panels reducer
  `available_commands_update` arm:
  [`acp.md`](./acp.md).
- Hook layer that drives the picker + dispatch:
  [`hooks.md`](./hooks.md).
- Sessions persistence (`'builtin'` `SessionEntry` kind):
  [`../web-acp-agent/sessions.md`](../web-acp-agent/sessions.md).
