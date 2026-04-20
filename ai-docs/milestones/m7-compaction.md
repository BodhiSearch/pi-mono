# M7 — Compaction

**Status:** ✅ done. Test seam: +25 vitests (234 total), +1 Playwright spec (5 total).

**Scope preview (historical).**
- Auto-compaction threshold: when context token estimate crosses a configurable percentage of the model's context window, compact.
- Manual compaction: explicit RPC command (`compact_now`).
- Compaction uses the same model the session is on (so user doesn't pay to switch).
- Result persisted as a `CompactionEntry` in the session's entries (Dexie IDB).
- Extension hook `session_before_compact` deferred to M8.

**Coding-agent references.** `packages/coding-agent/src/core/compaction/compaction.ts`, `compaction/branch-summarization.ts`, `compaction/utils.ts`. Studied, not imported (Principle #1).

**Gate.** `npm run check` clean, vitest all pass, Playwright compaction spec passes, no new `any`/`@ts-ignore`/skipped tests.

## Outcome

What landed:

- **`core/compaction/` module** (7 files) — Types (`CompactionSettings`, `CompactionPreparation`, `CompactionResult`), token estimation (char/4 heuristic, prefers LLM-reported `usage`), preparation (`prepareCompaction` with `force` option for manual path), LLM summarization (`compactSummarize` via `completeSimple`), structured prompts (`SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`), file-operation tracking, message serialization.
- **Worker-side pipeline** — `WorkerAgentHost` gained `maybeCompact()` (auto, inside `writeChain` after every append), `compactNow()` (manual, force bypass), `runCompaction()` (prepare → summarize → appendCompaction → restoreMessages → emitSessionLoaded). Re-entrancy guard (`compactionInFlight`) prevents concurrent pipelines. `AbortController` cancels in-flight summarization on session swaps.
- **RPC surface** — `compact_now` command, `compaction_start`/`compaction_end` synthetic events (drives UI indicator). `RpcSessionLoadedEvent` now carries `messageMeta: UiMessageMeta[]` (replaces prior `messageEntryIds`).
- **`UiMessageMeta` parallel array** — New type in `session/types.ts`. `SessionContext` extended with `messageMeta: UiMessageMeta[]` aligned 1:1 with `messages`. Each slot carries `entryId`; compaction-summary slots also carry `kind`, `tokensBefore`, `firstKeptEntryId`. This metadata flows Worker → RPC → useAgent → ChatMessages → MessageBubble without mutating the shared `AgentMessage` type.
- **`AgentSession` accessors** — `getModel()` and `getAuthToken()` getters so the compaction pipeline can read the active model and auth state.
- **UI** — Compact button in `ChatInput.tsx` (left column, next to New Chat Plus button). `MessageBubble.tsx` renders compaction summaries as a visually distinct bubble (`Layers` icon, dashed border, gray background) with `data-testid="chat-compaction-summary"` and `data-kind`, `data-tokens-before`, `data-first-kept-entry-id` attributes.
- **`useAgent` hook** — `sessions.compactNow()`, `isCompacting: boolean`, `messageMeta: UiMessageMeta[]` state (with backward-compatible derived `messageEntryIds` via `useMemo`).
- **E2E** — `compaction.spec.ts`: login → 2-turn conversation → manual compact → assert summary bubble visible with correct attributes → send another prompt → assert session works post-compaction. Turn-agnostic helpers (`waitForStreamingDone`, `lastAssistantText`) in `ChatPage.ts`.
- **25 new unit tests** across `token-estimate.test.ts` (6), `prepare.test.ts` (7), `serialize.test.ts` (4), `file-ops.test.ts` (5), `session-manager.test.ts` (+3). 234 total.

Surprises worth remembering:

- **Turn numbering shifts after compaction.** The compaction summary is a `user`-role message in the LLM context. After compaction, `ChatMessages.tsx`'s turn counter sees it as a new user turn, shifting all subsequent turn numbers. E2e tests that assert on turn-specific selectors (`chat-message-turn-N`) break post-compaction. Solution: turn-agnostic helpers (`waitForStreamingDone`, `lastAssistantText`) for post-compaction assertions.
- **Forced compaction on short conversations needs a fallback cut point.** The normal `findCutIndex` token walk returns -1 (or `cutIdx <= boundaryStart`) on short conversations because `keepRecentTokens` (20000) is never reached. For the manual "Compact now" button to work in e2e tests (which use short 2-turn conversations), `prepareCompaction` gained a `force: true` path that falls back to the last user-message entry as the cut point.
- **`UiMessageMeta` fixed an alignment bug.** The prior `messageEntryIds` derivation in the Worker used `branch.filter(e => e.type === 'message').map(e => e.id)`, which didn't account for the synthetic compaction summary message injected by `buildSessionContext`. The new `messageMeta` array is built inside `buildSessionContext` in lockstep with `messages`, guaranteeing 1:1 alignment.
- **`completeSimple` (non-streaming) for summarization was the right call.** The summarization LLM response doesn't need streaming to the UI — only the final result matters. Using `completeSimple` instead of `streamText` avoids the complexity of managing a streaming buffer alongside the main conversation's streaming state.
- **Compact button placement matters.** Initially placed in the bottom toolbar row alongside model selector and MCP popover, the button was pushed far right and hard to find. Moving it to the left column next to the New Chat (Plus) button made it consistently accessible regardless of toolbar width.
