# M5 — session persistence decisions

Date: 2026-04-20

See also [m5-storage-swap.md](m5-storage-swap.md) for the Dexie swap that supersedes D12.

## D10. SessionManager lives Worker-side; main drives it through RPC

**Decision:** the `SessionManager` singleton lives inside the agent Worker, owned by `WorkerAgentHost`. The main thread doesn't import `SessionManager`. Listing / loading / creating / deleting / renaming sessions goes through six new RPC commands (`list_sessions`, `load_session`, `new_session`, `delete_session`, `set_session_name`, `get_session_meta`); the Worker fires a synthetic `session_loaded` event back over the existing transport so the main-thread `useAgent` can update messages + active-session state from one envelope.

**Why:**
- The Worker already owns the pi-agent-core loop and the ZenFS backend for `/sessions`. Co-locating the SessionManager means `message_end → appendMessage` is a local call on the same thread; no RPC hop per turn.
- Main thread stays UI-only. The React layer never touches IndexedDB, never imports ZenFS, and can't accidentally serialise a SessionManager instance into a React context.
- Extension forward-compat. M8 plans to pass SessionManager as `ExtensionContext.sessionManager`; extensions run Worker-side in their own sandboxes and need the manager reachable locally, not across a boundary.
- `loadSession` needs to reset the agent and replay messages atomically. Doing that from main via RPC would require a multi-step dance (abort → clear → restore) each of which crosses the boundary; a single Worker-side method handles it in one pass.

**Alternatives rejected:**
- *SessionManager on main, ZenFS-proxy the Worker writes*: puts the hot message_end persistence path across the Worker boundary. Every turn pays an RPC hop per message + an `fs.promises.appendFile` hop (each of those itself being an RPC call through the ZenFS Port backend). Worse latency + double the ceremony.
- *Both sides get a SessionManager shadowing each other*: two sources of truth, two buffers, divergent `leafId` pointers. Worst-of-both: the bug surface of distribution without any of the upside.

## D11. Port the full `SessionEntry` union + `ReadonlySessionManager` interface in M5, even though only three variants are written

**Decision:** `src/web-agent/core/session/types.ts` defines all nine entry variants from coding-agent (`SessionMessageEntry`, `ThinkingLevelChangeEntry`, `ModelChangeEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, `CustomMessageEntry`, `LabelEntry`, `SessionInfoEntry`) plus `SessionHeader`, `SessionTreeNode`, `SessionContext`. The exported `ReadonlySessionManager` interface matches the shape of coding-agent's `ExtensionContext.sessionManager` Pick (getCwd / getSessionDir / getSessionId / getSessionFile / getHeader / getEntries / getEntry / getLeafId / getLeafEntry / getLabel / getBranch / getTree / getSessionName).

M5 only writes `SessionMessageEntry` + `ModelChangeEntry` + `SessionInfoEntry` to disk. The remaining variants are scaffolded but not emitted yet.

**Why:**
- **Wire-format stability.** An extension author who writes an analytics extension against coding-agent should read a web-agent JSONL file without modification. If M5 shipped only three types and M6 added `BranchSummaryEntry`, any extension that reads the file would have to case-switch on a possibly-missing variant. Ship the full union now so the file format is versioned at `CURRENT_SESSION_VERSION = 3` from day one and M6/M7/M8 only change the *set of writers*, never the *set of readers*.
- **Interface stability.** M8 wires `ExtensionContext.sessionManager = workerHost.sessionManager` and expects extensions to call `.getBranch()` / `.getTree()` / `.getLabel()` as-is. If M5 only shipped a subset of the reads, M8 would have to widen the interface and every M5 extension call-site would need updating.
- The marginal cost of porting types + reads is small (the reads are pure in-memory traversals) compared to the cost of breaking extensions written against coding-agent.

**Alternatives rejected:**
- *Ship only the variants M5 writes*: bakes an incompatibility between coding-agent and web-agent session files that M8 extensions would hit immediately.
- *Make `ReadonlySessionManager` extension-specific and keep a narrower M5 interface internally*: two interfaces drift; eventually someone calls an M5-only method from an extension path and the type compiles but fails at runtime.

## D12. `/sessions` on IndexedDB with per-session append queue (not OPFS)

> **Status:** superseded by [D14](m5-storage-swap.md#d14-dexie-on-indexeddb-for-session-storage--supersedes-d12). The IndexedDB-as-storage principle still holds; the ZenFS-filesystem-over-IDB *implementation path* is what was dropped.

**Decision:** `/sessions` is mounted on `@zenfs/dom`'s `IndexedDB` backend (`storeName: 'web-agent-sessions'`). Multi-tab correctness relies on IndexedDB's per-store transactional writes serialising concurrent `appendFile` calls; per-session append order within a single tab is enforced by a `writeChain: Promise<void>` inside `SessionManager` that every `_enqueueWrite` chains onto.

**Why:**
- **Repository core value #2 forbids OPFS.** OPFS doesn't coordinate cross-tab writes — two tabs appending to the same file produce torn bytes with no error surface, and IndexedDB transactions are the existing solution we've already paid for (via `@zenfs/dom` being a dep already).
- **No new dep.** `@zenfs/dom` already ships with the IndexedDB backend we use for `WebAccess` lifecycle glue; mounting `/sessions` costs zero dependency budget.
- **Per-session queue is cheap and solves the within-tab case.** ZenFS `appendFile` on IDB internally does `readFile → concatenate → writeFile`. Without the queue, two rapid `appendFile` calls could race on the read step and the second write would clobber the first. With the queue, the second append sees the post-first-write state.
- **Worst-case for cross-tab (both tabs writing the same session) is a torn leaf pointer, not torn bytes.** IDB serialises the writes, so each tab's in-memory `leafId` pointer becomes stale from the other tab's additions but the JSONL file remains coherent (last-writer-wins on the in-memory index; next `open()` rebuilds the index correctly from the file). M5 ships as-is; M6 may add a "another tab is editing" affordance if it becomes a real problem.

**Alternatives rejected:**
- *OPFS*: rejected by [core value #2](../../CLAUDE.md).
- *Global write queue across all sessions*: heavier contention under zero benefit — one session's append can't torn-byte another session's file. Per-session queue keeps parallelism where it's safe.
- *Explicit IDB transactions for each entry*: `@zenfs/dom` already wraps each `appendFile` in an IDB transaction internally. Adding an outer transaction layer would require rewriting the backend, not the manager.
