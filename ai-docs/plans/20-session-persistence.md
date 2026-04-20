# M5 — Session persistence (`/sessions` IndexedDB mount, list / load / save / delete)

## Context

**The problem.** Every reload starts a blank chat today. There's no way to continue an earlier conversation or even know one happened. M5 adds a persistent session layer so a user can:

- Reload the page and pick up where they left off.
- See past sessions in a list, switch between them, rename, delete.
- Have the agent loop resume tools + messages exactly as they were.

**The downstream constraint.** Per `ai-docs/00-vision.md`, our north star is *extensions written for `coding-agent` should plug into `web-agent`*. M8 will do the actual extension loader, but the SessionManager surface has to match coding-agent's *now* so M8 doesn't have to refactor the core. Specifically: extensions read `ExtensionContext.sessionManager` and write via `ExtensionAPI.appendEntry / setSessionName / setLabel`. The session entry shapes (`SessionMessageEntry`, `CustomEntry`, `BranchSummaryEntry`, etc.) are the contract.

**The browser constraint.** Coding-agent's SessionManager uses `node:fs`, `crypto.randomUUID`, lockless `appendFileSync`, and writes one JSONL file per session under `~/.pi/agent/sessions/...`. We need:

- ZenFS instead of node fs (already mounted Worker-side).
- IndexedDB backend at `/sessions/` (not OPFS — core value #2).
- Browser-portable UUID v7 (use `crypto.randomUUID()` + a tiny v7 helper, or `uuidv7`).
- Real concurrency safety, not lockless append. IndexedDB transactions give it for free.

**Out of scope (deferred to M6).** Fork from a mid-conversation entry, branch navigation, label management. M5 lands list/load/save/new/delete/rename and the persistence integration. M6 adds the tree operations.

---

## Coding-agent reference — what we port

Source-of-truth: `packages/coding-agent/src/core/session-manager.ts` (read-only during M5).

### Entry shapes (verbatim port)

```ts
export const CURRENT_SESSION_VERSION = 3;

export interface SessionHeader {
  type: 'session';
  version: number;
  id: string;            // full UUIDv7
  timestamp: string;     // ISO 8601
  cwd: string;           // '/vault' for web-agent
  parentSession?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;            // 8-char short ID for tree refs
  parentId: string | null;
  timestamp: string;
}

export type SessionEntry =
  | SessionMessageEntry        // { type: 'message', message: AgentMessage }
  | ThinkingLevelChangeEntry   // { type: 'thinking_level_change', thinkingLevel }
  | ModelChangeEntry           // { type: 'model_change', provider, modelId }
  | CompactionEntry            // (M7 will populate; we port the type now)
  | BranchSummaryEntry         // (M6 will populate; we port the type now)
  | CustomEntry                // extension opaque state
  | CustomMessageEntry         // extension message that participates in LLM context
  | LabelEntry                 // user bookmarks (M6)
  | SessionInfoEntry;          // { type: 'session_info', name? }

export type FileEntry = SessionHeader | SessionEntry;
```

We port **all** entry types into `src/web-agent/core/session/types.ts` even though M5 only writes `SessionMessageEntry` + `SessionInfoEntry` + `ModelChangeEntry`. The other types must exist so M6/M7/M8 don't have to break the file format later.

### File layout (verbatim port, ZenFS-backed)

- One file per session: `/sessions/<TIMESTAMP>_<UUIDv7>.jsonl`.
- First line: `SessionHeader`. Subsequent lines: `SessionEntry`.
- JSONL: one JSON object per line, parse-error skip on bad lines.
- **Lazy flush** (matches coding-agent): no file written until the first `assistant` message arrives. User-only "I started typing then closed the tab" sessions don't pollute the listing.

### Persistence triggers (matches coding-agent)

| Trigger | Action |
|---|---|
| `agent_start` (first turn of a fresh session) | No persistence yet (lazy). |
| `message_end` (user / assistant / toolResult) | `appendMessage(entry)` |
| Custom-message extension hook (M8) | `appendCustomMessageEntry(entry)` |
| Compaction settle (M7) | `appendCompaction(entry)` |
| Model switched | `appendModelChange(provider, modelId)` |
| User renames session | `appendSessionInfo({ name })` |

### Concurrency

Coding-agent has no locks. Multi-tab racing two writes to the same session interleaves lines; on reload "last leaf wins". Acceptable for node single-process; **not acceptable** for browser multi-tab.

**Web-agent decision:** rely on IndexedDB's per-store transactional writes plus a per-session `appendQueue` (in-Worker promise chain). Two tabs writing to the same session id is rare (we'd need to surface a "another tab is using this session" warning later) but if it happens, IndexedDB serialises, so we get coherent JSONL — no torn lines.

---

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | SessionManager lives in the Worker. Main accesses via RPC. | The session state (in-memory tree + leaf pointer) is part of the agent loop. Keeping it Worker-side means events fire on the same thread that persists them; main thread stays UI-only. |
| 2 | `/sessions` mounted on the Worker via `@zenfs/dom`'s `IndexedDB` backend. | Already a dep. Multi-tab safe via IDB transactions. No new package. |
| 3 | Port the full `SessionEntry` union now, write only `SessionMessageEntry` + `SessionInfoEntry` + `ModelChangeEntry` in M5. | M6/M7/M8 plug into the same file format without breaking changes. |
| 4 | JSONL format identical to coding-agent. UTF-8, `\n` line breaks. | Extensions written for coding-agent that read session entries (e.g. an analytics extension) work as-is. |
| 5 | Lazy flush — no file written until first assistant `message_end`. | Matches coding-agent. Avoids cluttering the session list with abandoned drafts. |
| 6 | UUIDv7 via a tiny inline helper (15 lines), not a new dep. | Browser has `crypto.randomUUID()` (v4) but no v7. Inline helper using `crypto.getRandomValues` is straightforward and keeps deps small. |
| 7 | 8-char short IDs for entries, generated via `crypto.getRandomValues` + base36. | Same shape as coding-agent's `randomUUID().slice(0, 8)`. |
| 8 | Active session ID stored in `localStorage` on main, key `web-agent.activeSessionId`. | Simple cross-reload state. Main loads it on `WebAgentProvider` boot, calls `rpcClient.loadSession(id)`. |
| 9 | Auto-save on every `message_end`. No explicit `save_session` command. | Matches coding-agent. The only explicit RPC commands are `list`, `load`, `new`, `delete`, `set_name`, `get_meta`. |
| 10 | When loading a session, the Worker emits a synthetic `session_loaded` event over the existing event channel; main's `useAgent` updates `messages` from the event payload. | Reuses the existing event-envelope path. No new transport surface. |
| 11 | `useAgent` exposes `sessions: { list, load, newSession, delete, setName, current }` so the UI can build a session picker. | Mirrors how `selectedModel` / `setSelectedModel` are surfaced today — same shape. |
| 12 | A `ReadonlySessionManager` interface is exported from `src/web-agent/core/session/` matching the shape coding-agent's extensions read via `ExtensionContext.sessionManager`. | M8 forward-compat — extensions read sessions through this contract; M5 ships it ready. |
| 13 | Defer fork / branch / label / switchSession-mid-turn to M6. | One milestone, one deliverable. Switching to a different session at boot (load) is M5; switching mid-conversation is M6. |
| 14 | Defer compaction-as-entry to M7. The `CompactionEntry` type is ported but no `appendCompaction` call site yet. | Same as #13 — M5 stays minimal. |

---

## Architecture

### Mount layout after M5

```
Worker process
├─ /vault     — WebAccess wrapping the FSA handle (M2)  — also Port-served to main
└─ /sessions  — IndexedDB-backed StoreFS  (NEW in M5)   — Worker-only, RPC surface

Main process
└─ /vault (Port-backed) — proxies to Worker fs
    /sessions is NOT mounted on main — accessed via RPC commands
```

### Component diagram

```
┌──────────────────────────────────────────────────────────────────┐
│ Main thread                                                       │
│  ├─ <WebAgentProvider>                                            │
│  │   └─ on boot: read localStorage activeSessionId,               │
│  │              call rpcClient.loadSession(id) or newSession()    │
│  ├─ useAgent(...) — exposes sessions API                          │
│  └─ <SessionPicker> — dropdown listing sessions, switch / new /   │
│      rename / delete                                               │
├──────────────────────────────────────────────────────────────────┤
│ Agent RPC channel (existing)                                      │
│  + new commands: list_sessions, load_session, new_session,        │
│                   delete_session, set_session_name, get_session_meta│
│  + new event:    session_loaded (envelope carries messages, name) │
├──────────────────────────────────────────────────────────────────┤
│ Worker                                                            │
│  ├─ WorkerAgentHost (existing)                                    │
│  │   └─ subscribes session.subscribe(event => …):                 │
│  │       on message_end → sessionManager.appendMessage(...)       │
│  │       on session_loaded (synthetic) → no-op (we emitted it)    │
│  ├─ SessionManager (NEW)                                          │
│  │   ├─ list() / load(id) / new() / delete(id) / setName()        │
│  │   ├─ appendMessage(entry) / appendModelChange(...)             │
│  │   ├─ getEntries() / getHeader() / getLeafEntry()               │
│  │   └─ getSessionContext() — { messages, modelInfo, name }       │
│  └─ ZenFS /sessions IndexedDB mount                               │
└──────────────────────────────────────────────────────────────────┘
```

### Boot sequence (post-M5)

1. WebAgentProvider mounts, spawns Worker via existing M4 path.
2. WebAgentProvider reads `localStorage.activeSessionId`.
3. If present: `rpcClient.loadSession(id)` → Worker reads JSONL, restores `agent.state.messages`, emits `session_loaded` event with the rebuilt message list.
4. If absent: `rpcClient.newSession()` → Worker creates a new SessionManager state (in-memory until first message). No file yet.
5. UI shows the chat. User types → `prompt(...)` → Worker handles turn → on `message_end`, SessionManager auto-appends to `/sessions/<id>.jsonl`. First write creates the file.
6. User picks a different session via `<SessionPicker>` → `rpcClient.loadSession(otherId)` → Worker swaps state → main updates `localStorage.activeSessionId`.

### Compatibility-layer preview (M8 forward-compat)

The `ReadonlySessionManager` interface (`src/web-agent/core/session/types.ts`) is shaped *exactly* like coding-agent's:

```ts
export interface ReadonlySessionManager {
  getHeader(): SessionHeader;
  getEntries(): SessionEntry[];
  getEntry(id: string): SessionEntry | undefined;
  getLeafId(): string | null;
  getLeafEntry(): SessionEntry | undefined;
  getSessionName(): string | undefined;
  // M6 additions: getChildren, getBranch, getTree, getLabel
}
```

When M8 builds `ExtensionContext`, it'll pass the SessionManager as `sessionManager: ReadonlySessionManager` — same field name, same shape. An extension that does `pi.context.sessionManager.getEntries().filter(e => e.type === 'message')` works in both coding-agent and web-agent without modification. M5 just has to ship the interface; M8 wires it into the extension API.

The same applies to `ExtensionAPI.appendEntry(customType, data)` — that's a thin wrapper around `sessionManager.appendCustomEntry(...)`, which we'll add in M5 even though no caller exists yet.

---

## Phase breakdown

Each phase has its own gate. Phases land in one commit total; checkpoint commits OK if any phase takes more than a day.

### Phase 0 — IndexedDB mount + entry types (~half day)

**Goal.** Worker can mount `/sessions` on IndexedDB; entry types compile.

- Add `src/web-agent/core/session/types.ts` — port all entry shapes from coding-agent (read-only; just types).
- Add `src/web-agent/core/session/ids.ts` — `generateSessionId()` (UUIDv7) + `generateEntryId()` (8-char base36).
- Update `src/web-agent/worker/worker-host.ts` to also mount `/sessions` IndexedDB store on init (separate from the per-vault mount). Idempotent.
- Update `src/web-agent/index.ts` to export the new types + IDs.
- Vitest: `ids.test.ts` — UUIDv7 monotonicity, 8-char ID uniqueness across N=10000.

**Gate.** `npm run check` + `npm test` green; no functional change visible.

### Phase 1 — SessionManager core (~1 day)

**Goal.** SessionManager class with full read + minimal write surface.

- `src/web-agent/core/session/session-manager.ts`:
  - Constructor takes `{ fs, sessionsRoot: '/sessions', id?: string }`.
  - Static factories: `list(fs, root)` (returns `Array<{ id, name?, lastModified, messageCount }>`), `open(fs, root, id)`, `create(fs, root, id?, parentSession?)`, `inMemory()`.
  - Append methods: `appendMessage(message)`, `appendModelChange(provider, modelId)`, `appendThinkingLevelChange(level)`, `appendSessionInfo(name)`, `appendCustomEntry(type, data)`, `appendCustomMessageEntry(entry)`. Each builds the entry, appends to JSONL via ZenFS `fs.promises.appendFile`, updates in-memory state.
  - Read methods: `getHeader()`, `getEntries()`, `getEntry(id)`, `getLeafId()`, `getLeafEntry()`, `getSessionName()`, `buildSessionContext()` — returns `{ messages, modelInfo, name, thinkingLevel }`.
  - **Lazy flush.** First append buffers entries; on first `assistant` message_end, flush header + buffered entries + this entry as one write.
  - Per-session promise chain so concurrent appends serialise correctly.
- `ReadonlySessionManager` interface exported from `types.ts`.
- Vitest: `session-manager.test.ts` against InMemory ZenFS — round-trip a 5-message session, list, load, append, delete, lazy-flush behaviour, name change, multi-write serialisation.

**Gate.** `npm test` green; ~10 new vitests.

### Phase 2 — Wire SessionManager into WorkerAgentHost (~half day)

**Goal.** Worker auto-saves on `message_end`; can load on demand.

- `worker-host.ts`:
  - On boot: instantiate SessionManager (in-memory) but defer file open until `loadSession` or first append.
  - Subscribe to session events. On `message_end`, call `sessionManager.appendMessage(event.message)`. On model changes (no event today; defer to set_model handler), call `appendModelChange`.
  - Add methods to AgentSessionHost interface (`AgentSessionHost`):
    - `listSessions(): Promise<SessionSummary[]>`
    - `loadSession(id: string): Promise<void>` — opens session, restores messages into AgentSession, emits `session_loaded` event.
    - `newSession(parentSession?: string): Promise<{ id: string }>`
    - `deleteSession(id: string): Promise<void>`
    - `setSessionName(name: string): Promise<void>`
    - `getSessionMeta(): Promise<SessionMeta | null>` — current id, name, parentSession, file path.
  - When `loadSession` is called: persist the previous session (flush buffered entries if any), construct a new SessionManager from the target file, replay `buildSessionContext()` into `agent.state.messages`, emit a synthetic `session_loaded` event over the existing subscriber surface so main updates UI.
- AgentSession needs a `restoreMessages(messages: AgentMessage[])` method (assigns to `agent.state.messages` and emits a snapshot event).

**Gate.** Worker can save + restore in-process (no UI changes yet).

### Phase 3 — RPC commands + `useAgent` surface (~half day)

**Goal.** Main can drive sessions via RPC.

- `rpc-types.ts`:
  - Add commands: `list_sessions`, `load_session { id }`, `new_session { parentSession? }`, `delete_session { id }`, `set_session_name { name }`, `get_session_meta`.
  - Add response shapes for each.
  - Add new event variant `session_loaded` to `RpcEventEnvelope` (carries `messages`, `header`, `name`).
- `rpc-server.ts` + `rpc-client.ts`: dispatch the new commands; surface client methods.
- `useAgent.ts`:
  - Subscribe-side handles `session_loaded` envelope by replacing local `messages`.
  - Expose `sessions: { list(), load(id), newSession(), delete(id), setName(n), current }`.
  - On hook mount: if `localStorage.activeSessionId` set, call `load(id)`; else call `newSession()`. Persist `current.id` back to localStorage on every change.
- Vitest: `rpc.test.ts` extended with fake SessionManager + 3-4 round-trip tests for the new commands.

**Gate.** Unit tests green; the RPC surface end-to-end works through `createInProcessTransportPair`.

### Phase 4 — UI: session picker + e2e (~half day)

**Goal.** A user can switch sessions in the browser; e2e proves persistence across reload.

- `src/components/sessions/SessionPicker.tsx` — minimal dropdown in the chat header:
  - Lists sessions (id, name, lastModified, messageCount).
  - "New session" button. Click on item → switch.
  - Inline rename. Trash icon → delete (with confirm).
  - `data-testid="session-picker"`, `data-testid="session-list-item"` per row, `data-path={sessionId}`.
- Wire into `ChatDemo.tsx` next to the model selector.
- e2e: `e2e/session-persistence.spec.ts` (new file), one spec, multiple `test.step`s:
  1. Install seed vault; load app; login + select model.
  2. Send a message; wait for assistant turn.
  3. Reload page (full `page.reload()`).
  4. Assert: same messages still rendered after reload (active session restored from localStorage).
  5. Click "New session" → assert messages cleared.
  6. Switch back to first session via picker → assert original messages restored.
- e2e helper page object: `e2e/tests/pages/SessionPage.ts` with `picker()`, `selectSession(id)`, `newSession()`, `currentSessionTitle()`.

**Gate.** All e2e specs green (existing 3 + new 1 = 4). All unit tests green.

### Phase 5 — Docs + commit (~1 hour)

- Update `ai-docs/milestones.md` M5 row → ✅ done with this commit's SHA. Add outcome paragraph.
- Append decisions to `ai-docs/05-decisions.md`:
  - **D10** — SessionManager lives in the Worker; main accesses via RPC.
  - **D11** — Port full SessionEntry union + ReadonlySessionManager interface in M5 even though M6/M7/M8 will populate the unused branches.
  - **D12** — IndexedDB backend at `/sessions` (not OPFS). Multi-tab safety via IDB transactions; per-session promise chain inside the worker.
- Single commit covering all phases.

---

## Files

### Add

```
packages/web-agent/src/web-agent/core/session/
  types.ts              # SessionHeader, SessionEntry union, ReadonlySessionManager
  ids.ts                # generateSessionId (UUIDv7), generateEntryId (8-char base36)
  session-manager.ts    # SessionManager class
  session-manager.test.ts
  ids.test.ts

packages/web-agent/src/components/sessions/
  SessionPicker.tsx

packages/web-agent/e2e/
  session-persistence.spec.ts
  tests/pages/SessionPage.ts
```

### Modify

```
packages/web-agent/src/web-agent/core/agent-session.ts
  # add restoreMessages(messages[])

packages/web-agent/src/web-agent/worker/worker-host.ts
  # mount /sessions IndexedDB store; wire session.subscribe → SessionManager.appendMessage
  # implement listSessions, loadSession, newSession, deleteSession, setSessionName, getSessionMeta

packages/web-agent/src/web-agent/rpc/rpc-types.ts
  # 6 new commands + 6 new responses + 1 new event variant (session_loaded)

packages/web-agent/src/web-agent/rpc/rpc-server.ts
  # dispatch new commands

packages/web-agent/src/web-agent/rpc/rpc-client.ts
  # add list/load/new/delete/setName/getMeta methods + handle session_loaded

packages/web-agent/src/hooks/useAgent.ts
  # expose sessions API; auto-load on boot; persist activeSessionId to localStorage

packages/web-agent/src/components/chat/ChatDemo.tsx
  # mount SessionPicker

packages/web-agent/src/web-agent/index.ts
  # re-export session types + SessionManager + ReadonlySessionManager
```

### Reference (read-only)

- `packages/coding-agent/src/core/session-manager.ts` — full implementation we're porting.
- `packages/coding-agent/src/core/agent-session.ts` (lines 517–557) — persistence trigger pattern.
- `packages/coding-agent/src/core/extensions/types.ts` (lines 305–325) — `ExtensionContext.sessionManager` shape (M8 forward-compat target).

---

## Test strategy

### Existing tests — must stay green unchanged

- All 70 vitests.
- All 3 e2e specs (chat, vault-fs M2, vault-fs M3).

### New unit tests

- `ids.test.ts` — UUIDv7 monotonicity (N pairs, time-ordered), 8-char ID collision rate (10k samples).
- `session-manager.test.ts` against InMemory ZenFS:
  - new() creates header + first message produces flush
  - list() returns sessions in `lastModified` order
  - open() round-trips header + entries
  - appendMessage updates leafId + persists JSONL line
  - lazy flush: nothing on disk until first assistant message_end
  - delete removes file
  - setName appends SessionInfoEntry; getSessionName returns latest
  - per-session append serialisation (two parallel appendMessage promises produce ordered lines)
  - corrupted JSONL line is skipped silently
- `rpc.test.ts` extension: fake SessionManager-backed host; round-trip list/load/new/delete/set_name + verify session_loaded event delivers.

### New e2e

- `e2e/session-persistence.spec.ts` (described in Phase 4).

---

## Gate checks (per `ai-docs/milestones.md#milestone-gate`)

1. `cd packages/web-agent && npm run lint:fix` — auto-format.
2. `cd packages/web-agent && npm run check` — lint + tsc -b, zero warnings.
3. `cd packages/web-agent && npm test` — vitest including new session + ids + RPC tests.
4. `cd packages/web-agent && npm run build` — production bundle, agent-worker chunk still present.
5. `cd packages/web-agent && npm run test:e2e` — 4 specs green (assumes bodhi binary available; document if blocked).
6. `npm run check` at repo root — biome + tsgo + browser-smoke + web-ui + web-agent. (Will fail on the documented `packages/ai/test/*.test.ts` model-regen issue; M5 doesn't introduce that.)
7. No new `any`, no `// @ts-ignore`, no skipped tests.

---

## Out of scope — explicit

- **Fork from a mid-conversation entry.** M6.
- **Branch navigation, switchSession mid-turn, labels.** M6.
- **Compaction-as-entry write path.** M7. The type ships in M5; the writer does not.
- **Extension session events** (`session_start`, `session_before_switch`, etc.). M8.
- **Custom message renderers.** M8.
- **Session export / import.** Not on the roadmap.
- **Compaction trigger logic.** M7.
- **Per-session permissions.** Not on the roadmap.
- **Sync to a remote backend.** Not on the roadmap.

---

## Risks worth flagging upfront

- **`fs.promises.appendFile` on ZenFS IndexedDB backend.** The IndexedDB-backed StoreFS implements append via read+write under the hood. Means each append is O(file size) — fine for our scale (sessions are small text). If sessions grow into MBs (hundreds of long turns) we'd want to switch to chunked storage; flag for M7.
- **localStorage capacity.** We only store `activeSessionId` (a UUID). 36 bytes. Negligible.
- **IndexedDB quota.** Browsers grant generous quotas (50%+ of disk by default in Chrome). One typical session is <100KB. Hundreds fit.
- **Two tabs, same session.** IndexedDB transactions serialise so no torn writes, but the leaf pointers in the in-Worker cache will diverge per tab. Last writer's leaf wins on reload. M5 ships as-is; M6 may add a "another tab is editing" warning if it's a real problem.
- **Deleting the active session.** UI must guard: deleting the current session should immediately call `newSession()`. Capture in Phase 4.
- **`agent.state.messages` direct assignment.** `pi-agent-core`'s `Agent` exposes `state.messages` mutably. We'll assign via a setter pattern in `AgentSession.restoreMessages()`. If pi-agent-core later adds derived state cached separately, we may need to call an explicit `agent.reset()` first then re-emit each message. Flag for unit-test verification.
- **Replay vs synthetic event.** When loadSession runs, we don't replay every individual `message_end` (would re-trigger persistence!). Instead we set the array atomically and emit one `session_loaded` envelope. The persistence subscriber must distinguish: only persist on real `message_end` from a turn, not when we restored. Implementation: SessionManager owns a "loading" flag that suppresses appends during restore.

---

## Verification (end-of-milestone checklist)

- [ ] `chat.spec.ts`, `vault-fs.spec.ts` M2 + M3 unchanged and pass.
- [ ] `session-persistence.spec.ts` passes — chat → reload → messages restored; new session → empty; switch back → restored.
- [ ] All vitests pass; new ones cover ids, session-manager, RPC round-trips.
- [ ] DevTools → Application → IndexedDB shows `/sessions/...` entries after a turn.
- [ ] Manual: open two tabs to same `localhost:15173`. Send a message in tab A. Reload tab B with the same active session id in localStorage; messages appear after a moment.
- [ ] `npm run build` produces both worker + main chunks; main bundle size ~unchanged.
- [ ] `ai-docs/milestones.md` M5 → ✅ done; outcome paragraph added.
- [ ] `ai-docs/05-decisions.md` D10 + D11 + D12 appended.
- [ ] Single commit summarising the milestone.
