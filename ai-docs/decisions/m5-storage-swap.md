# M5 storage-swap decisions — Dexie supersedes ZenFS sessions mount

Date: 2026-04-20

Supersedes [D12](m5-session-persistence.md#d12-sessions-on-indexeddb-with-per-session-append-queue-not-opfs).

## D13. `SessionStore` interface makes session storage swappable

**Decision:** session persistence is defined by a `SessionStore` interface (`packages/web-agent/src/worker-agent/core/session/store.ts`). Production wires `DexieSessionStore` (Dexie on IndexedDB); tests and the jsdom in-process fallback wire `MemorySessionStore`. `WorkerAgentHost`, `SessionManager`, and the main-thread hooks take a store via constructor or module singleton; no component imports a concrete backend directly.

**Why.**

- M5's first cut hard-wired storage to `@zenfs/dom`'s IDB backend through the ZenFS mount layer. When that silently broke in the browser, there was no ergonomic swap point — every SessionManager method was tangled with `fs/promises` + path helpers + lazy-flush scheduling. Replacing the storage meant rewriting the manager.
- An interface seam lets future decisions (cloud sync, OPFS once cross-tab lands, a remote API) slot in without churning `WorkerAgentHost` or the React hooks. Each backend satisfies the same contract and the rest of the code is unchanged.
- The interface also gave us a free test double: `MemorySessionStore` covers every path Dexie does and runs without IDB. This powers the `session-manager.test.ts` and `worker-host.test.ts` rewrites in the same commit as the Dexie implementation, so parity is enforced by tests rather than trust.
- Matches principle "interface and implementation loosely coupled" from the user's storage-swap brief.

**Alternatives rejected:**

- *Hard-wire Dexie and skip the interface.* Simpler short-term; pays the same migration tax the next time we reconsider storage. The cost of the interface is one file (`store.ts`); the cost of the re-migration is re-touching every caller.
- *Abstract only the reads (keep writes Dexie-specific).* Half-measure — appends are where the complexity lives; reads would still know about Dexie types.
- *Expose Dexie's `Table` directly as the "interface."* Leaks backend concepts (transactions, indexes, compound keys) into every caller and defeats the swap-out goal.

## D14. Dexie on IndexedDB for session storage — supersedes D12

**Decision:** replace the `/sessions` ZenFS-mounted IDB store with a Dexie-backed database named `web-agent` (tables: `sessions` keyed on `id` + indexed on `modifiedAt`; `entries` compound-keyed on `[sessionId+id]` with `sessionId`, `[sessionId+timestamp]`, `[sessionId+type]` indexes). Session records + entries live as IDB rows — not JSONL inside a simulated filesystem.

This supersedes D12, which mandated the ZenFS `/sessions` mount + per-session `appendFile` write queue. D12's reasoning on cross-tab safety via IDB transactions still holds — it's the implementation path (ZenFS file abstraction over IDB) we're walking away from, not the underlying storage.

**Why.**

- **The M5 ZenFS path was silently broken.** After M5 shipped, `localStorage.activeSessionId` was being set but `indexedDB.databases()` showed `web-agent-sessions` with zero keys after sending a prompt + getting a reply. The layers involved (`SessionManager` → `fs.promises` → `vfs.mounts` → `StoreFS` → `IndexedDBTransaction` → IDB) made root-causing expensive. Sessions are records; simulating them as JSONL files over IDB added complexity without benefit.
- **Records are cheap.** Direct Dexie `entries.add(row)` per append is O(1) and transactional. ZenFS `appendFile` on a JSONL file is "read entire file → concatenate → writeFile," which is O(file size) per append — flagged as a risk in M5 post-scripts and confirmed worse in practice.
- **Free cross-context reactivity.** Dexie's `liveQuery` uses BroadcastChannel internally; main-thread `useLiveQuery` re-renders automatically when the Worker commits a write, and another tab sees changes through the same channel. The previous design needed an `onSessionLoaded` synthetic event + explicit `listSessions` RPC after every write to keep the picker fresh.
- **Debuggable.** DevTools → Application → IndexedDB → rows, instead of opaque bytes inside a StoreFS-shaped key/value.
- **Zero schema migration cost today** — first boot, legacy `web-agent-sessions` IDB DB is best-effort deleted. User's IDB was empty at decision time; we're greenfield.
- **Bundle cost is acceptable.** Dexie ships ~30 KB gzipped; the main bundle already sits around 815 KB gzipped and this work is not performance-bound.

**Alternatives rejected:**

- *Fix the ZenFS path.* Plausible, but the root cause was somewhere in a third-party chain we don't maintain, and the "records → filesystem → IDB" layering is wrong for session data regardless of whether this specific bug is fixed.
- *Raw IndexedDB without Dexie.* Dexie is 30 KB for transactional API, index helpers, and liveQuery. Raw IDB's lower-level primitives would mean reinventing that surface and losing BroadcastChannel for free. Not worth it at our scale.
- *OPFS.* Core value #2 still binds — concurrent-tab writes would corrupt state with no error surface. No new concurrency guarantee changed.

## D15. Worker owns writes, main reads directly via Dexie

**Decision:** `WorkerAgentHost` is the single authoritative writer for session state. It takes a `SessionStore` via constructor and persists agent `message_end` events + lifecycle mutations (new / load / delete / rename) into it. Main-thread React code opens its own `DexieSessionStore` instance (module-singleton in `src/hooks/useSessionsList.ts`) against the same `web-agent` IDB DB — **for reads only**. The picker list is driven entirely by `useLiveQuery(() => store.listSessions())`; no RPC command fires when sessions change.

`setSessionName` stays on the RPC side (it's not just a read — the Worker's active `SessionManager` needs to refresh its in-memory entry cache afterwards, and letting main write directly would require cross-context cache invalidation). Everything else that looked like a reactive-data problem is handled by liveQuery.

**Why.**

- **Eliminates a whole category of race.** In the M5 wiring, the picker's view of sessions was out of date whenever the main thread hadn't yet pulled a fresh `listSessions` RPC. The `onSessionLoaded` → `listSessions` chain papered over it but still left windows where a reload-then-open showed stale data.
- **Single writer = single source of truth.** The Worker's `SessionManager` holds the authoritative `leafId` + entry cache for the active session; letting main also write would split authority and force invalidation protocols. Reads are idempotent and safe to duplicate across contexts.
- **Multi-tab support falls out for free.** Two tabs at the same origin both see a live picker; each has its own Worker owning its own active session. Writes from tab A broadcast to tab B via IDB + BroadcastChannel. No per-tab coordination code.
- **RPC surface shrinks where it should.** `listSessions` stays on the RPC for boot-time diagnostic use + tests, but the picker doesn't depend on it anymore. Future read-heavy flows (entry browser, branch navigator) can do the same.

**Alternatives rejected:**

- *Main writes, Worker mirrors for agent use.* Reverses the dependency — UI becomes the authority, Worker has to import changes from main. Worse cache-coherency story; bad fit when the Worker is where session_end events originate.
- *All reads via RPC so Worker stays the single IDB client.* Matches the pre-Dexie architecture but gives up liveQuery's cross-context reactivity. Every picker update is an explicit round-trip.
- *Both write, "last one wins."* IDB transactions would serialise, so no corruption, but leafId/cache divergence would silently accumulate across contexts until a user reload.
