# M1 — ACP Sessions

Status: **shipped** (phases A/B/C complete; see
[`../plans/m1-sessions.md`](../plans/m1-sessions.md) for the
phased delivery record).

## What this milestone delivered

A user's chat survives a page reload. They can leave a session,
come back later, and pick up where they left off. They can list
past sessions and switch between them. When switching, the model
they had selected for that session is restored automatically and
follow-up prompts use the persisted conversation context.

Sessions are ACP sessions — the object of record is whatever
`session/new` returned, plus the transcript of `session/update`
events. Persistence is in the browser via Dexie / IndexedDB,
owned by the Web Worker (not the main thread), so the agent is
the authoritative owner of session state.

## ACP surface touched

### Stable schema

- `initialize` — `agentCapabilities.loadSession = true` when a
  store is wired in (always, in production).
- `session/new` — adapter now also calls `SessionStore.createSession`
  and resets the `InlineAgent` so "+ New chat" starts with an
  empty history.
- `session/prompt` + `session/update` — transcripts are persisted
  via the adapter's `#emit` helper, and the end-of-turn finalised
  `AgentMessage[]` + `modelId` are stored as a `turn` entry.
- `session/cancel` — unchanged from M0.b.
- `session/load` — stable request, newly implemented. Replays
  stored notifications verbatim and seeds `InlineAgent` via
  `restoreMessages`.

### Bodhi extension methods

- `bodhi/listSessions` — picker feed ordered by `updatedAt DESC`.
  Used in preference to the upstream `session/list`, which lives
  under the SDK's `schema.unstable.json` surface.
- `bodhi/getSession` — collapsed snapshot (`messages`,
  `lastModelId`, `title`) for the UI to rehydrate the React state
  tree after `session/load`. `session/load`'s stable response
  shape has no first-class place for "last selected model" yet,
  so this companion call is what lets the picker restore the
  model selector.

## Decisions (with rationale)

- **Use `session/load` (stable ACP) instead of app-level replay.**
  The stable schema already defines loadSession + a
  `LoadSessionRequest`/`LoadSessionResponse` pair; reinventing a
  bespoke replay would violate "ACP is the only internal
  protocol" (see [`../steering/`](../steering/)).

- **Worker-owned store.** `SessionStore` lives inside the Web
  Worker. The main thread only ever sees session data through
  ACP calls. Preserves the "agent is authoritative" invariant
  and makes future remote-agent transports (same store, new
  transport) a trivial swap.

- **Snapshot companion (`bodhi/getSession`) instead of aggregating
  replay deltas.** `session/load` streams `agent_message_chunk`
  notifications back at the client per ACP; the client could in
  principle rebuild the transcript by catching them through the
  live handler. In practice that's fragile (tool-call rounds,
  message ids, whitespace collapsing) and buys us nothing — we
  have the collapsed `finalMessages` in the store already.
  `bodhi/getSession` returns that directly, the hook swaps it in
  with a single `setMessages`, and an `isReplayingRef` silences
  the live handler during replay so it doesn't double-write.

- **No `schemaVersion` column.** ACP does not define one at
  store granularity. Inventing one now would only pretend to
  solve forward-compat; when the on-disk shape actually drifts
  (not an M1 concern) we'll add version gating in the milestone
  that needs it.

- **Per-session `InlineAgent` reset.** pi-agent-core holds one
  message history at a time. The adapter now tracks
  `#activeInlineSessionId` and clears / restores on every
  session boundary (`newSession`, `loadSession`, and a guard in
  `prompt` for crossed-session prompts). This fixes the bug
  where "+ New chat" → prompt would persist the previous
  session's messages into the new session's `finalMessages`.

## Out of scope (still)

- Fork / branch / navigate — M3.
- Compaction of long transcripts — M4.
- Multi-user / multi-device session sync — post-v1.
- Encrypting sessions on disk — post-v1.
- Cross-tab live updates of the picker — post-v1.
- Session rename / delete UI — M1.x / M5.

## Tests

- `packages/web-acp/src/agent/session-store.test.ts` — vitest
  coverage of the Dexie store (create, notifications, turns,
  title derivation, delete, ordering).
- `packages/web-acp/e2e/chat.spec.ts` — unchanged; still the
  smoke test for the M0 surface.
- `packages/web-acp/e2e/sessions-persist.spec.ts` — DOM witness
  that a prompt creates a session row surviving reload.
- `packages/web-acp/e2e/sessions-resume.spec.ts` — DOM witness
  that `session/load` restores transcript + model per session
  across two models (OpenAI + Anthropic) with a follow-up
  prompt to prove the inline history was seeded.
