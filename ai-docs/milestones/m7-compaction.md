# M7 — Compaction

**Status:** planned. Test seam: vitest + Playwright step.

**Scope preview.**
- Auto-compaction threshold: when context token estimate crosses a configurable percentage of the model's context window, compact.
- Manual compaction: explicit RPC command.
- Compaction uses the same model the session is on (so user doesn't pay to switch).
- Result persisted as a `CompactionEntry` in the session's `entries.jsonl`.
- Extension hook `session_before_compact` can block, replace, or mutate the compaction payload — depends on M8 landing first, *or* implemented as internal-only with the extension hook wired up when M8 lands.

**Coding-agent references.** `packages/coding-agent/src/core/compaction/compaction.ts`, `compaction/branch-summarization.ts`, `compaction/utils.ts`.

**Gate.** vitest asserting threshold triggers + entry persisted correctly. Playwright step confirming UI reflects compacted state (the chat view still renders coherently post-compaction).
