# M6 — session tree decisions

Date: 2026-04-20

## D18. Fork storage = full entry copy with `parentSession` pointer; ids/parentIds/timestamps preserved verbatim; labels skipped

**Decision:** `SessionStore.forkSession({ sourceSessionId, upToEntryId })` creates a new session whose entries are the root-to-`upToEntryId` path of the source, copied verbatim. Each copied `EntryRow` keeps the source entry's `id`, `parentId`, and `timestamp`. The new `SessionRow` carries `parentSession = sourceSessionId`. `LabelEntry` rows are skipped during the copy so the child starts with an empty label set. The whole operation runs in a single Dexie `rw` transaction over `[sessions, entries]` so partial copies never land. `DexieSessionStore.forkSession` writes copied rows via direct `db.entries.add(row)`, bypassing `_writeEntry`'s monotonic-timestamp bump — that's what keeps the source timestamps intact.

**Why.**

- **Coding-agent JSONL parity.** Coding-agent's `createBranchedSession` produces sessions whose JSONL files start with the same entries as the parent up to the fork point. Preserving ids + parentIds means the child's DAG slice is structurally identical to the parent's; analytics or tools that consume both files see consistent identifiers.
- **The compound `[sessionId+id]` primary key already protects shared ids.** Two rows with the same `id` but different `sessionId` coexist trivially; no special-casing needed in IDB.
- **Atomicity matters.** A half-applied fork (some entries copied, others not, or session row created with no entries) would leave a corrupt state that the next read couldn't reason about. Wrapping the copy in a single Dexie transaction makes it all-or-nothing.
- **Labels are ephemeral user bookmarks, not part of the conversation DAG.** Carrying them across forks would surprise users (a label they set on the parent suddenly appearing on the child); explicit skip is the cheapest safe default. M6.1 can revisit if a use case emerges.
- **Storage cost is acceptable at our scale.** ~5–20 KB per entry × typical 50-entry session = 250 KB – 1 MB per fork. IDB origin quotas are hundreds of MB. COW / parent-pointer / dedup were considered and rejected (D-side: complicates deletes + reads, no telemetry showing storage pressure). Revisit only on real numbers.

**Alternatives rejected:**

- *Copy-on-write entries (child references parent rows until divergence).* Smaller storage but every read needs a join, and deletes have to walk the dependency graph. Net complexity loss.
- *Parent-pointer / lazy join.* Same trade-offs as COW.
- *Generate fresh ids on copy.* Breaks JSONL interop and prevents extensions from correlating entries across parent and child sessions.
- *Carry labels across the fork.* Surprising user behaviour; deferred.

## D19. Ephemeral leaf navigation — `navigateToLeaf` mutates in-memory `leafId` only

**Decision:** `SessionManager.navigateToLeaf(entryId)` is a synchronous in-memory pointer move with no persistence. The next append uses the new leaf as its `parentId`, so the DAG grows a sibling branch from the navigated point. `WorkerAgentHost.navigateToLeaf` rebuilds the agent's message window from the new branch (so subsequent prompts continue from the chosen entry) and emits a `session_loaded` event so main UI sees the truncated message list. On reload, `SessionManager.load` re-derives the leaf as the chronologically-latest entry — the navigation is forgotten.

**Why.**

- **Matches coding-agent's `branch(fromId)`** — the same in-memory leaf move with no persisted marker. Coding-agent's optional `branchWithSummary(fromId, summary)` writes a `BranchSummaryEntry` to make the navigation persistent, but that variant is **out of scope for M6 MVP** (the user explicitly rejected the LLM-summary scope option).
- **No new schema commitments.** A persisted "last-navigated leaf" pointer would be a new concept the store has to version + reason about. Punting it keeps M6 minimal and lets us see whether real users actually want navigation to survive reload before paying for the feature.
- **The forgetting-on-reload behaviour is documented as known limitation.** Acceptable for an MVP that's primarily about enabling forks; M6.1 can add a `BranchSummaryEntry`-based persistence path if user feedback says it's worth it.
- **`session_loaded` re-emission keeps the UI honest.** Main thread's `messages` + `messageEntryIds` arrays update from the new branch, so the chat view truncates and the per-message Fork/Branch buttons re-bind to the right entry ids without any client-side bookkeeping.

**Alternatives rejected:**

- *Persist the navigated leaf in `SessionRow.leafId` (or a similar field).* Adds a field that's only meaningful when navigation has happened; reload semantics get fiddly (does the leaf still exist? what if the user pruned the entry it pointed at?). Defer until we know the persistence semantics matter.
- *Persist via a `BranchSummaryEntry`.* Coding-agent's mature path, but writing one MVP-style would be a no-summary entry that exists just to mark a leaf — that's the LLM-summary scope option the user rejected. Revisit when M7's compaction surface lands hooks for cheap summaries.
