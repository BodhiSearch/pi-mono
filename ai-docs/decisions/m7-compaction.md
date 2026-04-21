# M7 — compaction decisions

Date: 2026-04-20

Note on IDs: this is the first decision group to use the milestone-prefixed id
convention (`m<milestone>-d<serial>`). Earlier groups used plain `Dxx` ids; M8's
extension spike concurrently claimed the unprefixed `D20` and `D21` slots, so
M7's three decisions adopt the new prefixed form to keep the ledger unambiguous.

## m7-d20. Compaction pipeline is Worker-local; RPC exposes only the trigger + lifecycle events

**Decision:** both the auto trigger (runs inside `writeChain` after every
`message_end` → `appendMessage`) and the manual trigger (`compact_now` RPC
command) invoke the same `WorkerAgentHost.runCompaction` method. Sub-operations
(`prepareCompaction`, `compactSummarize`, `SessionManager.appendCompaction`,
`AgentSession.restoreMessages`, `emitSessionLoaded`) do not cross the RPC
boundary. The main thread observes only three surfaces: the `compact_now`
command, the `compaction_start` / `compaction_end` synthetic events
(drives the "compacting…" UI state), and the subsequent
`session_loaded` re-emission carrying the post-compaction `messages` +
`messageMeta` arrays.

**Why.**

- **Same reasoning as D10 (SessionManager Worker-side).** Keeping the hot path
  on one side of the boundary removes race conditions between prepare →
  summarise → append. A partial compaction (summary persisted but messages not
  restored, or vice versa) would be very hard to recover from.
- **`writeChain` already serialises `message_end` against other appends.**
  Auto-compaction slotted into the same chain gets serialisation for free — a
  second `message_end` landing during summarisation naturally waits.
  Exposing step-by-step RPC would force an explicit lock + versioning dance in
  the client.
- **No extra `AgentMessage` copies over the transport.** Summarisation reads
  messages directly from the in-memory `SessionManager`; only the final summary
  round-trip (LLM call) happens off-thread, and that's a pi-ai stream, not the
  agent RPC.
- **Cancellation story is local.** `WorkerAgentHost.compactionAbort`
  (an `AbortController`) is signalled by every session-swap path
  (`loadSession` / `newSession` / `forkSession` / `navigateToLeaf`) so an
  in-flight summary cannot land on a session the user has already left.
- **Extension hooks (M8) will live Worker-side anyway.** When M8 adds
  `session_before_compact`, the hook runs in-process with the pipeline — no
  RPC reshape required.

**Alternatives rejected:**

- *RPC-driven step-by-step compaction.* Main sends `prepare` → receives
  preparation → sends `summarize` → receives result → sends `append`.
  Each step would need structured-clone-safe intermediate types, a cross-
  boundary mutex, and a concurrency model for `message_end` interleavings.
  Much more code, no capability gained.
- *Run compaction on the main thread, read entries via RPC.* The summarisation
  LLM stream is already async-cloneable; the reason to pick main-side would be
  UI-facing progress. But a simple `compaction_start` / `compaction_end` pair
  plus the existing streaming indicator already covers the UX — no need to
  stream tokens.

## m7-d21. Cut on user-message turn boundaries only; turn-split summarisation deferred

**Decision:** `prepareCompaction` walks back from the leaf accumulating token
estimates until `keepRecentTokens` is reached, then snaps forward to the
**first user-message entry** at or after that index — that entry becomes
`firstKeptEntryId`. Coding-agent's `findCutPoint` additionally handles mid-
turn cuts by producing two summaries (a "history" summary + a "turn prefix"
summary merged into one result via `TURN_PREFIX_SUMMARIZATION_PROMPT`); M7
does not port that path. If the keep-recent budget falls inside a single long
turn, M7 keeps the whole turn (which may push context above the threshold for
one more turn until the next user message opens a cut point).

Manual `compactNow()` adds a `force: true` fallback that picks the last
user-message entry as the cut point when the normal backwards-walk fails to
find one (short conversations where nothing crosses `keepRecentTokens`). This
keeps the UI button functional on trivial sessions — required for the e2e
spec's two-turn scenario.

**Why.**

- **Complexity/cost ratio is unfavourable at web-agent scales.** Turn-split
  doubles the LLM round-trips (`history` + `turn-prefix` run in parallel via
  `Promise.all`, but still two calls, two prompts, two token budgets). Browser
  sessions are typically shorter than the coding-agent tui sessions that
  motivated turn-split. The worst-case "turn so long it doesn't fit" is rare
  in practice.
- **Simpler prompts are easier to reason about.** Single `SUMMARIZATION_PROMPT`
  or `UPDATE_SUMMARIZATION_PROMPT` — no need to merge two distinct summaries
  into a single coherent `CompactionEntry.summary` string.
- **Turn atomicity is a desirable invariant.** Cutting inside a turn means the
  suffix starts with an assistant message whose tool calls reference tool
  results that were summarised rather than kept — the LLM then has to infer
  "what did `read('/vault/x.md')` return?" from the prose summary. Turn-aligned
  cuts keep `user → assistant(toolCalls) → toolResult`-style slices intact.
- **Forced compaction is a pragmatic e2e concession.** Without `force: true`
  the manual button is a no-op for any short conversation, and the playwright
  spec can't exercise the full pipeline. Adding the fallback to a pure
  function is low-risk (covered by a dedicated unit test).

**Alternatives rejected:**

- *Port turn-split verbatim.* Ruled out on complexity/value grounds (above).
  Revisit if real sessions produce pathological token distributions.
- *Cut at any assistant message (not just user boundaries).* Requires carrying
  the tool-call / tool-result coupling through the cut — coding-agent does this
  but only when splitting a turn. Without turn-split we don't need this path.
- *Refuse manual compaction on short sessions (error out).* User-hostile —
  the button just silently fails and the e2e spec can't verify the pipeline.
  `force: true` adds four lines of fallback code and makes the UX predictable.

## m7-d22. `CompactionSettings.contextWindow` override isolates M7 from the hardcoded 128000

**Decision:** `CompactionSettings` carries an optional `contextWindow?: number`.
`WorkerAgentHost.maybeCompact` resolves the window via
`settings.contextWindow ?? model.contextWindow ?? 128_000`. Production code
never sets the override — it flows `model.contextWindow` from `buildModel`,
which today hardcodes `128000` for all models (see
`packages/web-agent/src/lib/agent-model.ts`). Tests pass small values
(e.g. `contextWindow: 1000`) to exercise the auto path deterministically.
Fixing the underlying hardcode is out of M7's scope; it is tracked
separately and will land when Bodhi API exposes per-model metadata.

**Why.**

- **Unblock M7 without changing `buildModel` + Bodhi API semantics.** The
  compaction threshold is the only M7 consumer of `contextWindow`, so isolating
  the override at the settings boundary means the fix becomes a one-file change
  (`buildModel`) later — no compaction-code churn.
- **Tests need deterministic thresholds.** `shouldCompact` over a 128000-token
  window can't be triggered from a unit test without fabricating a huge
  assistant `usage.totalTokens`. The override lets tests drive the same code
  path against a 1000-token window with a ~950-token `usage`.
- **Principle #10 — write it down.** The hardcoded 128000 is a silent
  correctness risk for any model with a smaller window (Claude Haiku 200k is
  fine; a 32k-window model would compact way too late). This decision record
  exists partly so the next session doesn't accidentally assume the
  `contextWindow` override is the real fix rather than a stopgap.

**Alternatives rejected:**

- *Fix `buildModel` as part of M7.* Requires either a Bodhi API extension to
  return model metadata per id, or a local `modelId → contextWindow` registry.
  Both scopes are larger than the compaction work itself. Deferred.
- *Pass the window directly to `shouldCompact` at every call site.* Duplicates
  the fallback logic (`settings ?? model ?? 128_000`) across call sites. The
  settings-held override is the single source of truth.
- *Drop the override; always read from `model.contextWindow`.* Breaks the
  deterministic test story.
