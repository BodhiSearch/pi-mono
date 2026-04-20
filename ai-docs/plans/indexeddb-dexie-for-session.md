# Replace ZenFS/JSONL session storage with Dexie on IndexedDB

## Context

M5 shipped session persistence by mounting `@zenfs/dom`'s IndexedDB backend at `/sessions` in the Worker and writing JSONL files via `fs.promises.writeFile` / `appendFile`. During live testing we found persistence silently broken — the IndexedDB store exists and is opened, but `write-ops` against a ZenFS-mounted `/sessions/<uuid>.jsonl` never landed rows. The exact path is opaque to debug (layers: SessionManager → `fs.promises` → `vfs.mounts` → `StoreFS` → `IndexedDBTransaction` → IDB) and the filesystem abstraction is doing real work to simulate a shape we don't actually need. Sessions are records, not files.

Direct IndexedDB via [Dexie](https://dexie.org) removes the abstraction tax:

- **Record-shaped:** sessions and entries as IDB rows, indexed on the fields we actually query.
- **Cheap appends:** `entries.put(row)` instead of "read JSONL, append line, rewrite whole file".
- **Queryable:** `db.sessions.orderBy('modifiedAt').reverse()`, `db.entries.where({ sessionId, type })`.
- **Cross-context reactivity:** Dexie's `liveQuery` uses BroadcastChannel internally; a `useLiveQuery` hook on main auto-rerenders the picker when the Worker writes a new entry. No `session_loaded` refresh hack.
- **Debuggable:** DevTools → Application → IndexedDB → rows, instead of opaque bytes in an inode-shaped store.
- **Simpler boot:** no `/sessions` mount, no `initSessions()`, no ZenFS mount lifecycle coupling.

Tab coordination comes free with Dexie's observers (confirmed with user). Coding-agent JSONL interop stays possible via an export utility; scope-deferred to [PENDING.md](../PENDING.md) per user instruction.

## Goals

1. Drop the `/sessions` ZenFS mount entirely; replace with a Dexie-backed IndexedDB database `web-agent` with `sessions` + `entries` tables.
2. Introduce a `SessionStore` interface so storage is swappable (Dexie today, potentially Cloud / OPFS / other later). Tests use an in-memory impl; production uses Dexie.
3. Preserve the public extension-facing surface: `ReadonlySessionManager` + the `SessionEntry` union. M8 extension compat holds.
4. Worker writes, main reads directly via `useLiveQuery`. The only RPC commands that remain are the ones that mutate Worker-side agent state (active session id, in-memory messages buffer).
5. Multi-tab live sync of the picker list.

## Non-goals

- Migration of legacy JSONL files. User's IDB is empty (verified); greenfield.
- JSONL export utility (deferred to PENDING.md).
- OPFS or any other backend — core value #2 still binds; Dexie is the one concrete implementation now.

## Design

### Storage interface

Single interface that both implementations satisfy. Append methods take a session id so the interface is stateless — state (active session + leaf pointer + in-memory entries cache) lives in `SessionManager`.

```ts
// src/web-agent/core/session/store.ts
export interface SessionStore {
  // Lifecycle
  createSession(opts: {
    id?: string;
    cwd: string;
    parentSession?: string;
  }): Promise<SessionRow>;
  deleteSession(sessionId: string): Promise<void>;
  setSessionName(sessionId: string, name: string): Promise<void>;
  touchSession(sessionId: string): Promise<void>; // bumps modifiedAt

  // Reads
  listSessions(): Promise<SessionSummary[]>;
  getSession(sessionId: string): Promise<SessionRow | null>;
  getEntries(sessionId: string): Promise<SessionEntry[]>;
  getEntry(sessionId: string, entryId: string): Promise<SessionEntry | null>;

  // Appends — full SessionEntry union coverage so M7/M8 land without
  // touching the interface.
  appendMessage(sessionId: string, message: AgentMessage, parentId: string | null): Promise<string>;
  appendModelChange(sessionId: string, provider: string, modelId: string, parentId: string | null): Promise<string>;
  appendThinkingLevelChange(sessionId: string, level: string, parentId: string | null): Promise<string>;
  appendSessionInfo(sessionId: string, name: string, parentId: string | null): Promise<string>;
  appendCompaction(sessionId: string, payload: Omit<CompactionEntry, 'id' | 'parentId' | 'timestamp' | 'type'>, parentId: string | null): Promise<string>;
  appendBranchSummary(sessionId: string, payload: Omit<BranchSummaryEntry, 'id' | 'parentId' | 'timestamp' | 'type'>, parentId: string | null): Promise<string>;
  appendLabel(sessionId: string, targetId: string, label: string | undefined, parentId: string | null): Promise<string>;
  appendCustomEntry(sessionId: string, customType: string, data: unknown, parentId: string | null): Promise<string>;
  appendCustomMessageEntry(sessionId: string, entry: Omit<CustomMessageEntry, 'id' | 'parentId' | 'timestamp' | 'type'>, parentId: string | null): Promise<string>;

  // Live observation — may be optional (memory store won't bother). Dexie
  // store implements via `liveQuery`; returns unsubscribe.
  observeSessionList?(cb: (summaries: SessionSummary[]) => void): () => void;
  observeEntries?(sessionId: string, cb: (entries: SessionEntry[]) => void): () => void;
}
```

### DexieSessionStore

```ts
// src/web-agent/core/session/dexie-store.ts
class WebAgentDB extends Dexie {
  sessions!: Table<SessionRow, string>;
  entries!: Table<EntryRow, [string, string]>;

  constructor(name = 'web-agent') {
    super(name);
    this.version(1).stores({
      sessions: 'id, modifiedAt',
      entries: '[sessionId+id], sessionId, [sessionId+timestamp], [sessionId+type]',
    });
  }
}

interface SessionRow {
  id: string;                // UUIDv7
  name: string | null;
  cwd: string;
  parentSession: string | null;
  createdAt: number;         // epoch ms
  modifiedAt: number;
  entryVersion: number;      // payload schema version (= CURRENT_SESSION_VERSION today)
}

interface EntryRow {
  sessionId: string;
  id: string;                // 8-char hex
  parentId: string | null;
  timestamp: number;
  type: SessionEntry['type'];
  data: SessionEntry;        // full typed entry — IDB structured-clones it
}
```

- Same DB instance is used in both Worker and Main (same origin, same DB name). Each context opens its own handle; IDB transactions serialise across them.
- Appends use `db.transaction('rw', [sessions, entries], async () => { ... })` so the entry insert and `sessions.modifiedAt` bump land atomically.
- `observeSessionList` wraps `liveQuery(() => db.sessions.orderBy('modifiedAt').reverse().toArray())`. Dexie emits to every subscribed context via BroadcastChannel — this is what gives us multi-tab + Worker-writes → Main-reads reactivity.

### MemorySessionStore

Plain maps. No persistence. Used by `session-manager.test.ts`, by the `rpc.test.ts` fake host, and as the jsdom fallback where IDB is absent. Satisfies `SessionStore` without `observeSessionList` / `observeEntries`.

### SessionManager — refactor, not replace

- Keeps the `ReadonlySessionManager` public surface verbatim (getHeader / getEntries / getLeafId / getBranch / getTree / getSessionName / ...). Extensions written against coding-agent keep working.
- Drops the static factories (`create`, `open`, `list`, `delete`). Instead: `SessionManager.load(store, sessionId)` — reads the session + entries once, caches them, exposes reads locally.
- Appends delegate to the store, then update the in-memory entries cache + leaf pointer. Store writes are awaited so callers can `await manager.appendMessage(...)` when they care (tests, loadSession flush).
- Lazy-flush logic disappears — each append is its own IDB transaction. A "draft" session is simply a `SessionRow` with zero entries; the picker can filter those out if we want to hide them.

### WorkerAgentHost changes

- Drop `initSessions()`, `SESSIONS_MOUNT`, `SESSIONS_STORE_NAME`, the module-level `sessionsMounted` flag.
- Constructor takes a `SessionStore` (plus the existing `AgentSession` + `vfsPort`). In production the Worker builds `new DexieSessionStore()`; tests inject `new MemorySessionStore()`.
- `newSession`, `loadSession`, `deleteSession`, `setSessionName`, `getSessionMeta` all route through `this.store` + `this.sessionManager`.
- `message_end` subscriber awaits the store write (fire-and-await, logged on error), instead of fire-and-forget into a promise chain.
- `emitSessionLoaded` still fires over the host event sink so the main-thread agent-state (messages buffer) syncs on load.

### Main-thread read path

- New `useSessionsList()` hook wraps `useLiveQuery(() => store.listSessions(), [], [])`. Returns `SessionSummary[]` and auto-re-renders on cross-context changes.
- `useAgent.sessions` shrinks: `list` comes from `useSessionsList`, not from local state populated after RPC. `refresh` goes away (the query is live).
- `SessionPicker` consumes `useLiveQuery` output directly via `useAgent.sessions.list`.
- Boot-time session restore in `useAgent` still uses RPC (`loadSession` is state on the Worker, not just a read).

### Placement — decision

**Worker owns writes. Main reads directly.**

- Worker-side `WorkerAgentHost` is the only writer to `sessions` and `entries` tables. All mutations (append, rename, delete) go through it.
- Main-side code opens its own `DexieSessionStore` instance for **reads only** — the picker list, and (future) browsing session entries outside an active agent turn.
- No read-side RPC for list / get-entries. Dexie's BroadcastChannel-backed `liveQuery` keeps main in sync.
- `setSessionName` stays an RPC because the Worker's `SessionManager` needs to refresh its local entry cache afterwards; it's easier to keep the Worker as the authoritative renamer than to invalidate its cache on BroadcastChannel events.

## Files

### Add

- `packages/web-agent/src/web-agent/core/session/store.ts` — `SessionStore` interface + row/summary types.
- `packages/web-agent/src/web-agent/core/session/dexie-store.ts` — Dexie impl.
- `packages/web-agent/src/web-agent/core/session/dexie-store.test.ts` — vitest against `fake-indexeddb/auto`.
- `packages/web-agent/src/web-agent/core/session/memory-store.ts` — in-memory impl.
- `packages/web-agent/src/web-agent/core/session/memory-store.test.ts` — parity tests covering the same contract.
- `packages/web-agent/src/hooks/useSessionsList.ts` — `useLiveQuery`-backed picker data.
- `ai-docs/PENDING.md` — add a "coding-agent JSONL export" entry.

### Modify

- `packages/web-agent/src/web-agent/core/session/session-manager.ts` — drop static `create`/`open`/`list`/`delete`, drop `parseSessionFile` / `parseJsonl` / `buildSummary` helpers, add `load(store, sessionId)` factory. File shrinks substantially.
- `packages/web-agent/src/web-agent/core/session/session-manager.test.ts` — rewrite against `MemorySessionStore` (drop `vfs.mount` / InMemory ZenFS ceremony).
- `packages/web-agent/src/web-agent/worker/worker-host.ts` — remove `initSessions`, `SESSIONS_MOUNT`, `IndexedDB` import, the mount guard; take a `SessionStore` in constructor; rewire session RPC methods through `store` + `SessionManager`.
- `packages/web-agent/src/web-agent/worker/worker-host.test.ts` — inject `MemorySessionStore` into the host fixture; drop `vfs.mount('/sessions', InMemory...)`.
- `packages/web-agent/src/web-agent/worker/agent-worker.ts` — build a `DexieSessionStore` and pass to `WorkerAgentHost`; delete `await host.initSessions()`.
- `packages/web-agent/src/web-agent/rpc/rpc.test.ts` — the fake host's `/sessions` references are just string literals for path assembly; drop them.
- `packages/web-agent/src/web-agent/index.ts` — drop `SESSIONS_MOUNT` export; add `SessionStore`, `DexieSessionStore`, `MemorySessionStore`, `SessionRow`, `EntryRow` exports.
- `packages/web-agent/src/hooks/useAgent.ts` — replace local `sessionSummaries` state + `refreshSessions` with `useSessionsList()` output; drop `onSessionLoaded` → `listSessions` chain.
- `packages/web-agent/src/components/sessions/SessionPicker.tsx` — drop `onRefresh` prop (liveQuery replaces it).
- `packages/web-agent/src/components/chat/ChatDemo.tsx` — drop `onRefresh` wire-up.
- `packages/web-agent/package.json` — add `"dexie": "^4.x"` and `"dexie-react-hooks": "^1.x"` dependencies.

### Delete

- `parseSessionFile`, `parseJsonl`, `buildSummary`, `extractText`, `joinPath`, `isEnoent` helpers inside `session-manager.ts` — all replaced by Dexie queries.
- `SessionManager.list` static — replaced by `store.listSessions()` at call-sites.

## Phase breakdown

Each phase has a self-contained gate (`npm run check` + `npm test` both green). Single commit at end; checkpoint commits OK per-phase.

### Phase 0 — deps + interface (~½ day)

- Add `dexie` + `dexie-react-hooks` to `packages/web-agent/package.json`. Run `npm install`.
- Write `store.ts` with `SessionStore` interface, `SessionRow`, `EntryRow`, `SessionSummary` (the existing one in `types.ts` shifts slightly — add `modifiedAt` as number epoch-ms alongside the existing ISO string, or replace; decide during implementation).
- Write `MemorySessionStore` + test. ~15 unit tests covering the full contract: create / delete / setName / list sort / append each entry type / get / observe no-op.

**Gate.** Unit tests pass; no other code paths changed.

### Phase 1 — Dexie store (~½ day)

- Write `DexieSessionStore` backed by `WebAgentDB`.
- Transactional `appendX` methods (entry insert + `sessions.modifiedAt` bump).
- `observeSessionList` + `observeEntries` via Dexie's `liveQuery`.
- `dexie-store.test.ts` using `fake-indexeddb/auto` (already in setup.ts). Tests match the MemoryStore contract; add a couple of Dexie-specific tests (transactional atomicity on delete, schema version assertion).

**Gate.** DexieSessionStore parity with MemoryStore.

### Phase 2 — SessionManager refactor (~½ day)

- SessionManager accepts a `SessionStore` + `SessionRow` + initial `SessionEntry[]` via `SessionManager.load(store, sessionId)` static.
- Append methods delegate to `store.appendX`, then mutate the local cache.
- Drop the write-chain, the lazy-flush dance, and the file-path helpers.
- Rewrite `session-manager.test.ts` against `MemorySessionStore`. Drop `vfs.mount('/sessions', InMemory...)` ceremony; the tests become simpler.

**Gate.** All existing SessionManager behavioural assertions still pass (just against the new backing).

### Phase 3 — WorkerAgentHost + agent-worker rewire (~½ day)

- WorkerAgentHost takes `SessionStore` in its constructor.
- `agent-worker.ts` constructs `new DexieSessionStore()` and passes it in.
- Remove `initSessions` from host + agent-worker; remove `SESSIONS_MOUNT` from the index barrel.
- `worker-host.test.ts` uses `MemorySessionStore`; drop `/sessions` ZenFS ceremony.
- `rpc.test.ts` fake sessioned host: inline the 5-line MemoryStore-backed fake, drop `/sessions` literals.

**Gate.** All 103 existing vitests stay green under the new wiring.

### Phase 4 — main-thread live reads + hook (~½ day)

- Write `useSessionsList()` hook: opens a main-side `DexieSessionStore` singleton (module-scoped, same pattern as the Worker boot), wraps `useLiveQuery`.
- `useAgent.sessions.list` becomes `const list = useSessionsList()`; drop the local `sessionSummaries` state + `refreshSessions` + the list-refresh side-effect inside `onSessionLoaded`.
- `SessionPicker` drops `onRefresh`; popover opens show live data.
- **Manual verify**: run dev server, Claude-in-Chrome script — send a message in tab A, open tab B, confirm picker in B shows A's session without reload.

**Gate.** `npm run check` + `npm test` green; dev server manual smoke passes.

### Phase 5 — e2e + docs + commit (~½ day)

- Existing `e2e/session-persistence.spec.ts` should still pass unchanged (black-box, reloads + asserts message returns). If it reveals any regression, fix in this phase.
- Append entry to `ai-docs/PENDING.md` (create the file if missing): "Coding-agent JSONL export / import — round-trip sessions between web-agent and coding-agent. Needs a serializer in `SessionStore` callers; deferred until a user asks."
- Update `ai-docs/milestones.md` M5 outcome paragraph with a post-script noting the switch.
- Update `ai-docs/05-decisions.md`:
  - **D13** — SessionStore interface for storage swap-out.
  - **D14** — Dexie on IndexedDB for session storage; supersedes D12 (ZenFS-mounted IDB).
  - **D15** — Worker owns writes, main reads directly via `liveQuery`.
- Single commit covering phases 0–5 (checkpoint commits fine if any phase takes longer).

**Gate.** Repo-level `npm run check` clean for web-agent (pre-existing `packages/ai` model-regen issue stays separate). `cd packages/web-agent && npm run test:e2e` green (assumes bodhi server; document skip if blocked).

## Verification

1. **Unit.** `cd packages/web-agent && npm test` — 103 existing + ~20 new tests; aim for zero regressions.
2. **Type/lint.** `cd packages/web-agent && npm run check`.
3. **Build.** `npm run build` produces both chunks; main bundle grows by ~30 KB gz (Dexie).
4. **Browser smoke via Claude in Chrome.**
   - Hard-reload tab → verify `localStorage.getItem('web-agent.activeSessionId')` is set after boot.
   - Verify `indexedDB.databases()` shows `web-agent` with version 1.
   - Send a prompt → verify `db.sessions` has one row and `db.entries` has ≥2 rows (user + assistant).
   - Reload → verify the message comes back in the chat pane.
   - Open a second tab at the same URL → verify the picker shows the same session list without a manual refresh. Rename the session in tab A; tab B's picker updates within 500 ms (BroadcastChannel round-trip).
5. **e2e.** `cd packages/web-agent && npm run test:e2e` — `session-persistence.spec.ts` passes end-to-end.

## Risks / open decisions

- **Dexie version.** Target `^4.x` (latest stable). Dexie v4 deprecates some v3 APIs but `liveQuery` + `useLiveQuery` are stable.
- **Worker + main both instantiating the same DB.** Fine: IDB allows multiple connections. Dexie's BroadcastChannel messaging handles cross-context invalidation.
- **`liveQuery` SSR / jsdom.** `fake-indexeddb` covers jsdom; BroadcastChannel is polyfilled by the fake. If any test flakes, fall back to a direct-read path in the Memory store.
- **Concurrent deletes.** If the main-thread picker deletes a session while the Worker is mid-`appendMessage`, the IDB transaction on the entry insert might land against a now-deleted session id. Mitigation: the append transaction re-reads the session row and bails if it's gone. Easy to add.
- **Clearing old ZenFS IDB on first boot.** The old `web-agent-sessions` IDB database becomes dead weight. One-time cleanup: `indexedDB.deleteDatabase('web-agent-sessions')` guarded behind a localStorage flag so it runs once. Tiny overhead, user-invisible.

## Critical files (quick reference)

- Worker wiring: `packages/web-agent/src/web-agent/worker/{agent-worker.ts,worker-host.ts}`
- Session core: `packages/web-agent/src/web-agent/core/session/{types.ts,ids.ts,session-manager.ts,store.ts (new),dexie-store.ts (new),memory-store.ts (new)}`
- RPC surface (unchanged): `packages/web-agent/src/web-agent/rpc/{rpc-types.ts,rpc-server.ts,rpc-client.ts}`
- Main-thread hooks: `packages/web-agent/src/hooks/{useAgent.ts,useSessionsList.ts (new)}`
- Picker UI: `packages/web-agent/src/components/sessions/SessionPicker.tsx`, `packages/web-agent/src/components/chat/ChatDemo.tsx`
- Docs: `ai-docs/plans/indexeddb-dexie-for-session.md` (this file), `ai-docs/{milestones.md,05-decisions.md,PENDING.md (new)}`
