# web-acp — chronological tool-message rendering

## Context

In `packages/web-acp/`, tool-call bubbles always render at the
bottom of the transcript regardless of which conversation turn
they belong to. The renderer in
`packages/web-acp/src/components/chat/ChatMessages.tsx:103-114`
runs two consecutive `.map()` passes — first over `messages`, then
over `toolCalls` — so a multi-turn session looks like
`[u1, a1, u2, a2, …, tc-from-turn-1, tc-from-turn-2]`. The user
expectation is the natural chat order: each turn's tool calls
appear between that turn's user prompt and the assistant's reply.

The data needed to fix this already exists. `ToolCallView` carries
a `turn` field (`packages/web-acp/src/hooks/useAcp.ts:53-62`)
populated from `turnIndexRef.current` at the moment the
`tool_call` notification arrives. The change is purely a render-
time grouping plus a small bookkeeping fix so the turn indices on
messages and tool calls actually agree.

## Approach

Render a single chronologically-ordered list. After each user
message, emit the tool-call bubbles whose `turn` matches that
user's turn, then continue with the next message. Drop the
trailing `tool-calls-container` block.

We do **not** split the assistant bubble around tool calls within
a single turn. That would require streaming-level changes (the
current code concatenates all `agent_message_chunk` text into one
bubble). Inside a turn, the order is `user → all tool calls (in
arrival order) → assistant`. This matches typical chat-UX
conventions and keeps the change scoped.

### Turn-index alignment

Today `turnIndexRef.current` is pre-incremented in `sendMessage`
(`useAcp.ts:820`), so the first turn's tool calls carry `turn: 1`
while the user/assistant pair derived in `turnByIndex`
(`ChatMessages.tsx:66-74`) is `0`. Fix by initialising the ref to
`-1` and pre-incrementing (so the first turn becomes `0`), or by
moving the increment to the end of `sendMessage` (so the ref
holds the *current* turn index while the turn is in flight). The
latter reads more naturally and is what the plan assumes; either
works.

`MessageBubble`'s `data-testid="chat-message-turn-${turn}"`
already starts from 0, so no test-selector changes are needed
once the alignment lands.

## Files to modify

1. **`packages/web-acp/src/components/chat/ChatMessages.tsx`**
   - Remove the trailing `toolCalls.map()` block at lines 108-114.
   - In the existing `renderList.map((msg, index) => …)` body,
     after rendering a `MessageBubble` whose `msg.role === 'user'`,
     emit the tool-call bubbles for that turn:
     `toolCalls.filter(c => c.turn === turn).map(c => <BashToolCall key={c.toolCallId} call={c} />)`.
   - Wrap the per-turn group in a `div` carrying
     `data-testid={\`tool-calls-turn-${turn}\`}` so e2e can assert
     placement per turn (the previous global
     `data-testid="tool-calls-container"` no longer applies).
   - Keep the `showPending` indicator and `messagesEndRef` exactly
     where they are — they sit after the last message bubble
     (which may be a streaming assistant). The streaming
     assistant's tool calls will already have rendered between
     the user msg and the assistant bubble in the same turn, so
     this remains visually correct.

2. **`packages/web-acp/src/hooks/useAcp.ts`**
   - Move `turnIndexRef.current += 1;` (line 820) out of the
     pre-send block. Either:
     - place it in the `finally` of `sendMessage` so the ref
       advances *after* the turn completes, **or**
     - change the initial value (line 332) to `-1` and keep the
       pre-increment.
   - Reset semantics in `clearMessages` (line 883) and
     `loadSession` (line 777) need to match whichever choice you
     pick (current `= 0` reset is correct for the second option,
     wrong for the first).
   - No public-API changes; `toolCalls` and `messages` continue
     to be returned exactly as they are.

3. *(no other files change)* — `MessageBubble.tsx`,
   `BashToolCall.tsx`, `useAcp.ts` exports, ACP wire types are
   untouched.

## Out of scope (call out, do not fix here)

- **Tool calls disappear on session reload.** `loadSession` clears
  `toolCallsRef` (line 776) because the worker's `getSession`
  snapshot returns only `messages` — it doesn't hydrate tool
  calls. Restoring tool calls across reload requires
  persisting them server-side and replaying through the snapshot
  (or letting the live `session/load` replay seed them with
  `isReplayingRef` allowing tool-call kinds through). Track as a
  follow-up.
- **Splitting assistant text around tool calls within one turn.**
  Pre-tool-call narration vs post-tool-call summary currently
  smoosh into one bubble. Splitting requires per-chunk message
  IDs feeding multiple bubbles. Track as a follow-up.

## Verification

1. **Type + lint.** From `packages/web-acp/`:
   - `npm run check` — biome + tsc -b clean.
   - `npm test` — vitest unit suite green.
2. **Manual smoke (DEV).**
   - `npm run dev` in `packages/web-acp/`, log in, mount a
     volume.
   - Toggle the DEV-only `forceToolCall` feature so a benign
     prompt deterministically calls `bash`.
   - Send "hi" → observe order: user bubble, then bash tool-call
     bubble, then assistant final message — all in one
     contiguous block.
   - Send a second "hi" → second turn's tool-call bubble appears
     between the second user msg and the second assistant msg,
     **not** at the bottom.
3. **DOM-witness (Playwright, optional in this change).** If we
   want regression coverage, add a step to the existing M2 bash
   spec asserting the document order:
   `chat-message-turn-0[messagetype=user]` →
   `tool-calls-turn-0` → `chat-message-turn-0[messagetype=assistant]`,
   using `locator.evaluateAll` on a common ancestor's children.
   Black-box, no `page.evaluate` into transport internals — fits
   principle 7 in `04-principles.md`.
