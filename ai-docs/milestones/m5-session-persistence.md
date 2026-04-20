# M5 — Session persistence

**Status:** ✅ done (`3ddd01b2` + `5cd569c0` Dexie swap + `af2b7086` cleanup). Test seam: +1 Playwright spec (`session-persistence.spec.ts`), +26 vitests.

**Scope preview (historical).**
- ZenFS IndexedDB mount at `/sessions`.
- Layout: `/sessions/<id>/meta.json`, `/sessions/<id>/entries.jsonl` (append-only entry log).
- Entry types mirror coding-agent: user message, assistant message, tool call, tool result, model change, compaction entry, custom entry.
- RPC commands: `list_sessions`, `load_session`, `save_session`, `delete_session`, `set_session_name`.
- On app boot: auto-load most-recent session if present.

**Coding-agent references.** `packages/coding-agent/src/core/session-manager.ts` (file layout + entry types), `agent-session.ts` (persistence hooks on turn_end).

**Adaptations.** No file locks (IndexedDB transactions give us atomicity). No lockfile path. Concurrent-tab writes tolerated via IndexedDB serialisation.

**Gate.** Playwright spec: chat → reload page → session restored; list shows the session; rename, delete, re-chat.

## Outcome (initial, ZenFS-backed)

What landed:

- **`/sessions` IndexedDB mount.** `WorkerAgentHost.initSessions()` calls `@zenfs/dom`'s `IndexedDB.create({ storeName: 'web-agent-sessions' })` and `vfs.mount('/sessions', ...)`. Guarded by a module-level flag so StrictMode / fast-refresh re-invocations are no-ops. Called from `agent-worker.ts` boot before any session RPC flows.
- **Entry-type surface ported 1:1 from coding-agent** in `src/web-agent/core/session/types.ts`: `SessionHeader`, full 9-variant `SessionEntry` union, `SessionTreeNode`, `SessionContext`, `SessionSummary`, `SessionMeta`, and a `ReadonlySessionManager` interface shaped exactly like coding-agent's `ExtensionContext.sessionManager` Pick type. Writing M5 only exercises `SessionMessageEntry` + `SessionInfoEntry` + `ModelChangeEntry`; the other variants are scaffolded so M6/M7/M8 plug into the same wire format without breaking changes.
- **Browser-native id helpers** in `src/web-agent/core/session/ids.ts`: `generateSessionId()` (UUIDv7 inline — 48-bit timestamp + 80 random bits, with a monotonic-counter bump for same-ms generations) and `generateEntryId()` (8-char hex with collision-check loop). No new dependency.
- **`SessionManager` class** (`src/web-agent/core/session/session-manager.ts`) — static factories (`create` / `open` / `list` / `delete` / `inMemory`), the full append surface (message / model_change / thinking_level_change / session_info / custom / custom_message / compaction / branch_summary / label_change), the full `ReadonlySessionManager` reads, plus `buildSessionContext()` and a `flush()` helper for tests + host-side shutdown. **Lazy flush** matches coding-agent: no file is written until the first assistant `message_end`; at that point header + buffered entries go out in one `writeFile`, subsequent entries `appendFile` a single JSONL line. Overlapping appends serialise through a per-session promise chain so JSONL line order stays stable under concurrent writers.
- **`WorkerAgentHost` session surface.** Constructor subscribes to the agent's `message_end` event and appends `user`/`assistant`/`toolResult` messages to the active `SessionManager`. New methods `listSessions`, `loadSession`, `newSession`, `deleteSession`, `setSessionName`, `getSessionMeta`, `setHostEventSink` — each wired through the RPC dispatch. `loadSession` flushes the previous manager, opens the target file, resets the agent, calls `AgentSession.restoreMessages(ctx.messages)`, then emits a synthetic `session_loaded` event through the host-event sink.
- **`AgentSession.restoreMessages(msgs)`** — simple reassignment of `agent.state.messages`. If pi-agent-core later adds derived caches we'd need to invalidate them explicitly; M5 doesn't need that.
- **RPC extensions** in `rpc-types.ts` / `rpc-server.ts` / `rpc-client.ts`: 6 new commands (`list_sessions`, `load_session`, `new_session`, `delete_session`, `set_session_name`, `get_session_meta`), each with its typed response. New event variant `RpcSessionLoadedEvent` (`sessionId` + `header` + `name` + `messages`) routed through a new `HostEventSink` seam — `RpcServer` calls `host.setHostEventSink?.(sink)` on construction and the sink forwards synthetic events through `transport.send`. `RpcClient.onSessionLoaded(listener)` is a separate stream from the existing `subscribe(envelope)` so agent-event consumers don't need to filter.
- **`useAgent` sessions API**: `sessions: { current, list, refresh, load, newSession, delete, rename }`. On mount (StrictMode-safe via a `sessionBootRef`) the hook reads `localStorage.activeSessionId`, calls `rpcClient.loadSession(storedId)`, and falls back to `newSession()` if the id is stale. `onSessionLoaded` updates messages + activeSession + localStorage in one handler, then kicks a `listSessions` refresh so the picker stays current. `clearMessages` now starts a fresh persisted session (old one stays accessible) instead of wiping the agent in place.
- **`SessionPicker.tsx`** mounted above `ChatMessages` in `ChatDemo`: popover dropdown with per-session summary (title / message-count / relative-time), a "New" button, per-row delete, and an inline rename form on the current session. All flows carry `data-testid` + `data-path` so e2e can drive the UI black-box.
- **Tests.** 26 new vitests total — 7 in `ids.test.ts` (UUIDv7 shape + monotonicity + 8-char entry id collision rate), 13 in `session-manager.test.ts` against InMemory ZenFS (create / lazy-flush / open round-trip / list / delete / setName / concurrency / malformed JSONL), 6 in `worker-host.test.ts` (full session lifecycle including session_loaded event emission), 5 in `rpc.test.ts` (round-trip list / new / load / setName / delete via `createInProcessTransportPair`). 103/103 vitests pass overall. New `e2e/session-persistence.spec.ts` (with `SessionPage` page object): send → reload → messages restored from localStorage id; new session → messages clear; switch back → messages return; delete other session via picker. Existing 70 vitests + 3 e2e specs unchanged.

Surprises worth remembering:

- **Parameter-property syntax is still disallowed** under `erasableSyntaxOnly` (repeated M4 finding). SessionManager's private constructor takes a single args object and assigns fields in the body.
- **`react-hooks/set-state-in-effect` fires on transitive setState.** An effect that awaits `refreshSessions()` still trips the rule because `refreshSessions` ends in `setSessionSummaries`. Fire the list-refresh inline from the `onSessionLoaded` subscriber (not an effect) — matches the M4 guidance about keeping state transitions out of effect lifecycles.
- **`AgentSession.state.messages` is writable but `errorMessage` / `streamingMessage` are readonly** in pi-agent-core's typing. `restoreMessages` only reassigns `messages`; a first version that also cleared the derived fields failed typecheck.
- **IndexedDB `appendFile` under ZenFS is O(file size)** — flagged in the plan, confirmed in practice. Sessions under ~100KB are fine; if long turns push a session past several MB, M7 will want to rework the storage layout (e.g., chunk files).
- **Lazy flush interacts with concurrent writes.** The per-session promise chain captures `[...fileEntries]` at enqueue time so the `hasAssistant` check inside the write body sees the state that was present when that entry was appended, not whatever the chain drains to. Without the snapshot, two rapid appends could both "see" no assistant and both skip writing even though an assistant did land in between.
- **`vfs.mount` throws if the path is already mounted.** SessionManager tests `try { vfs.umount } catch {}` before `vfs.mount` in `beforeEach` to keep each test isolated; the worker-host mount uses a module-level guard instead since it's a one-shot per Worker lifetime.

## Post-script — Dexie storage swap (2026-04-20)

The original M5 storage path — `/sessions` mounted on `@zenfs/dom`'s IndexedDB backend with JSONL files per session — shipped but turned out to persist nothing in the browser. The ZenFS → `StoreFS` → `IndexedDBTransaction` write chain failed silently for reasons we did not pin down; IDB's `web-agent-sessions` store was empty after assistant replies despite the active session id being set in `localStorage`.

Rather than chase the failure mode inside ZenFS, M5's storage layer was replaced without touching the public interface. Sessions are now records in a Dexie-backed `web-agent` IDB DB behind a `SessionStore` interface (`src/web-agent/core/session/store.ts`). Writes live in the Worker, main-thread reads go through `useLiveQuery` — no RPC for the picker list, BroadcastChannel-backed cross-context reactivity for free. The full swap is documented at `../plans/indexeddb-dexie-for-session.md` and captured as decisions D13/D14/D15 in `../05-decisions.md`. See also `../PENDING.md` for the coding-agent JSONL interop that was scope-deferred.

The extension-facing contract (`ReadonlySessionManager`, full `SessionEntry` union, `CURRENT_SESSION_VERSION = 3`) is unchanged, so M8 plans that assumed coding-agent-compatible session shape still hold.

The legacy `web-agent-sessions` IDB database is best-effort-deleted on Worker boot — no migration path, `localStorage` active-session id stays meaningful across the swap because both implementations use UUIDv7 ids.
