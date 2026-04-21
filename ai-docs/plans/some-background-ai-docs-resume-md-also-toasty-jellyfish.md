# M7 — Compaction (plan → outcome)

## Context

M5 (persistence) and M6 (session tree) are done. As sessions grow, the message window eventually approaches the active model's context window and the next `prompt` turn will either truncate silently (provider-dependent) or error. M7 adds **compaction**: summarize a prefix of the transcript into a single `CompactionEntry`, then rebuild the agent message window so the conversation continues with a summary in place of the discarded prefix.

The `CompactionEntry` type, `SessionManager.appendCompaction`, and `buildSessionContext`'s handling of compaction entries were already scaffolded in M5 (D11 — port the full entry union). So storage, tree, and message-window rebuild are in place. M7 adds the **trigger logic, the summarization pipeline, and the RPC surface** — no schema churn.

User decisions locked going into this plan:
- **Scope:** auto + manual trigger paths both in MVP.
- **Context-window source:** keep 128000 hardcoded for now; expose threshold via `CompactionSettings` so the fix is isolated later.
- **Implementation:** heavy influence from `packages/coding-agent/src/core/compaction/`, but reproduced web-agent-native (browser/Worker, pi-ai streamFn, vault-tool file tracking) — not a verbatim copy. Principle #1 (no coding-agent imports) stands.

## Design

### Data flow

```
[Worker] message_end → writeChain.then(appendMessage → maybeCompact)
                                                         │
                                                         ▼
                                        shouldCompact(messages, settings)?
                                         │ no → done
                                         │ yes
                                         ▼
                              prepareCompaction(entries, leafId, settings)
                                ─ pick cutEntryId (earliest entry whose
                                  suffix fits keepRecentTokens)
                                ─ collect discarded messages + file ops
                                ─ find prior CompactionEntry for "update"
                                  prompt variant
                                         │
                                         ▼
                              compactSummarize(payload, model, streamFn)
                                ─ one pi-ai call with SUMMARIZATION_PROMPT
                                  or UPDATE_SUMMARIZATION_PROMPT
                                ─ abortable via AbortSignal
                                         │
                                         ▼
                              sm.appendCompaction(summary, firstKeptEntryId,
                                                  tokensBefore, { readFiles,
                                                  modifiedFiles })
                                         │
                                         ▼
                              emitSessionLoaded() — main updates UI
```

Manual path is the same pipeline invoked via RPC `{ type: 'compact_now' }`. Manual bypasses the threshold check; it always runs.

### New files (planned → implemented)

| Planned | Implemented | Notes |
|---|---|---|
| `compaction/types.ts` | ✅ `CompactionSettings`, `CompactionPreparation`, `CompactionResult`, `CompactionDetails`, defaults | As planned |
| `compaction/token-estimate.ts` | ✅ `estimateTokens`, `estimateContextTokens`, `shouldCompact` | Uses char/4 heuristic; prefers LLM-reported `usage` when available |
| `compaction/prompts.ts` | ✅ `SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`, summary prefix/suffix | Adapted from coding-agent; vault-tool vocabulary only |
| `compaction/prepare.ts` | ✅ `prepareCompaction(path, settings, opts)` | Added `force: true` option for manual compaction on short conversations |
| `compaction/summarize.ts` | ✅ `compactSummarize(prep, model, options)` | Uses `completeSimple` (non-streaming); Bearer auth injected on model |
| `compaction/file-ops.ts` | ✅ `extractFileOpsFromMessage`, `computeFileLists`, `formatFileOperations` | Was part of plan's serialize; split into own module |
| `compaction/serialize.ts` | ✅ `serializeConversation(messages)` | Plain-text transcript for summarization LLM |
| `compaction/index.ts` | ✅ barrel export | As planned |
| `compaction/*.test.ts` | ✅ `token-estimate.test.ts`, `prepare.test.ts`, `serialize.test.ts`, `file-ops.test.ts` | More coverage than originally planned |

### Files modified (planned → implemented)

| Planned | Implemented | Notes |
|---|---|---|
| `rpc-types.ts` — `compact_now` + compaction events | ✅ `compact_now` command, `compaction_start`/`compaction_end` events | Added `messageMeta: UiMessageMeta[]` to `RpcSessionLoadedEvent` (replaces `messageEntryIds`) |
| `rpc-server.ts` — dispatch `compact_now` | ✅ | As planned |
| `rpc-client.ts` — `compactNow()` + `onCompactionEvent` | ✅ | As planned |
| `worker-host.ts` — `maybeCompact`, `compactNow`, `runCompaction` | ✅ Plus `compactionInFlight` guard, `compactionAbort` for cancellation on session swaps | As planned |
| `agent-session.ts` — `getModel()` getter | ✅ Also `getAuthToken()` getter | As planned |
| `useAgent.ts` — `compactNow`, `isCompacting` | ✅ Plus `messageMeta` state (replaced `messageEntryIds`), derived `messageEntryIds` via `useMemo` | `compactionError` deferred — error logged to console |
| `ChatInput.tsx` — compact button | ✅ Compact button next to New Chat (Plus) button in left column | Originally in toolbar row; moved to top for cleaner layout |
| **Not planned** — `UiMessageMeta` type | ✅ `session/types.ts` + `SessionContext` extended | New: parallel metadata array for e2e observability |
| **Not planned** — `MessageBubble.tsx` compaction rendering | ✅ Visual compaction summary bubble with `data-test-*` attributes | New: distinct rendering for compaction summaries |
| **Not planned** — `ChatMessages.tsx` + `ChatDemo.tsx` | ✅ Prop-drill `messageMeta` | Supporting the new metadata flow |

### Key architectural deviation from plan

**`UiMessageMeta` parallel array**: The plan assumed `messageEntryIds` would remain the entry-id correlation mechanism. Implementation introduced `UiMessageMeta[]` — a richer parallel array carrying `entryId`, `kind`, `tokensBefore`, and `firstKeptEntryId` per message. This enables:
1. Black-box e2e testing via `data-test-*` attributes on the compaction summary bubble.
2. Visual differentiation of compaction summaries from regular messages.
3. No mutation of the shared `AgentMessage` type (Principle #1 compliant).

**Forced compaction**: `prepareCompaction` gained a `force: true` path that falls back to the last user-message entry as a cut point when the normal token walk finds nothing worth cutting. This makes the manual "Compact now" button work on short conversations (essential for e2e testing).

### Locked defaults (CompactionSettings) — as implemented

```
enabled: true
reserveTokens: 16384       // headroom from contextWindow
keepRecentTokens: 20000    // tail we never summarise
minEntriesToCompact: 4     // don't bother for tiny sessions
contextWindow?: number     // optional override; else model.contextWindow ?? 128000
```

`shouldCompact` = `estimateContextTokens(messages) > (contextWindow - reserveTokens)`.

### Not in scope for M7 MVP (unchanged)

- Extension hook `session_before_compact` — deferred to M8.
- Fixing the hardcoded 128000 in `agent-model.ts` — tracked separately; `CompactionSettings.contextWindow` override lets M7 land without blocking on it.
- Turn-split two-prompt summarization — M7 cuts on turn boundaries only.
- Context-usage % indicator in the UI — deferred.
- `compactionError` state surfaced to UI — errors logged to console for now.

## Verification

### vitest (unit) — implemented

| Test file | Tests | Coverage |
|---|---|---|
| `token-estimate.test.ts` | 6 | char/4 estimates, usage-based estimates, shouldCompact threshold |
| `prepare.test.ts` | 7 | null returns (small/ends-in-compaction), cut boundary, prior-compaction boundary, force fallback |
| `serialize.test.ts` | 4 | user/assistant formatting, array content, truncation, empty input |
| `file-ops.test.ts` | 5 | read/write/edit extraction, skip non-assistant, compute lists, format operations |
| `session-manager.test.ts` | +3 | `buildSessionContext().messageMeta` alignment, compaction-summary kind, entryId matching |

### Playwright e2e — implemented

Separate spec `e2e/compaction.spec.ts`:
1. Login, load models, select model.
2. Build 2-turn conversation.
3. Click `[data-testid=chat-compact-button]`, wait for `data-test-state=idle`.
4. Assert `[data-testid=chat-compaction-summary]` visible with `data-kind`, `data-tokens-before` attributes.
5. Send another prompt; assert reply arrives (session functional post-compaction).

Uses turn-agnostic helpers (`waitForStreamingDone`, `lastAssistantText`) since turn numbers shift after compaction.

### Gate

- `npm run check` root — ✅
- `web-agent` vitest — ✅ (234 tests, +25 from compaction)
- `web-agent` playwright — ✅ (5 specs, +1 compaction)
- `web-agent` build — ✅
- No new `any` / `@ts-ignore` / skipped tests — ✅

## Decisions appended to `ai-docs/decisions/m7-compaction.md`

IDs use the new milestone-prefixed form since M8's spike concurrently took the
unprefixed `D20` and `D21` slots. See the convention note at the top of the
decisions file.

- **m7-d20** — Compaction pipeline is Worker-local; auto trigger runs inside `writeChain` after `message_end`. Manual trigger is `compact_now` RPC. Sub-operations never cross the RPC boundary — main observes only the command, `compaction_start` / `compaction_end` events, and the subsequent `session_loaded` refresh.
- **m7-d21** — M7 cuts on user-message turn boundaries only; turn-split summarization deferred. Manual `compactNow` adds a `force: true` fallback that picks the last user-message entry when the normal token walk finds nothing (keeps the button functional on short conversations, e.g. e2e).
- **m7-d22** — `CompactionSettings.contextWindow` override isolates M7 from the hardcoded 128000 in `agent-model.ts`. Tests use small windows; production reads `model.contextWindow ?? 128_000`. The underlying hardcode fix is tracked separately.

## Critical files (quick index)

| File | Why it matters |
|---|---|
| `packages/web-agent/src/web-agent/worker/worker-host.ts` | `maybeCompact`, `compactNow`, `runCompaction`, `compactionInFlight` guard, abort on session swap |
| `packages/web-agent/src/web-agent/core/agent-session.ts` | `getModel()` + `getAuthToken()` accessors |
| `packages/web-agent/src/web-agent/core/session/session-manager.ts` | `appendCompaction` + `buildSessionContext` with `messageMeta` |
| `packages/web-agent/src/web-agent/core/session/types.ts` | `UiMessageMeta`, `SessionContext` with `messageMeta` |
| `packages/web-agent/src/web-agent/rpc/rpc-types.ts`, `rpc-server.ts`, `rpc-client.ts` | `compact_now` command + `compaction_start`/`compaction_end` events + `messageMeta` on `session_loaded` |
| `packages/web-agent/src/web-agent/core/compaction/**` | New module — types, token estimate, prepare, summarize, prompts, file-ops, serialize |
| `packages/web-agent/src/hooks/useAgent.ts` | `sessions.compactNow`, `isCompacting`, `messageMeta` + derived `messageEntryIds` |
| `packages/web-agent/src/components/chat/ChatInput.tsx` | Compact button (left column, next to Plus) |
| `packages/web-agent/src/components/chat/MessageBubble.tsx` | Compaction summary rendering with `data-test-*` attributes |
| `packages/web-agent/e2e/compaction.spec.ts` | E2E test for manual compaction + post-compaction functionality |
