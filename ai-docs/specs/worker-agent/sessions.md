# sessions

**Source of truth:** `packages/web-agent/src/worker-agent/core/session/`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

`core/session/` provides session persistence for the worker agent. A "session" is an append-only DAG of typed entries backed by a pluggable store. Two storage engines are in-tree:

- **`DexieSessionStore`** — IndexedDB via Dexie. Production default.
- **`MemorySessionStore`** — in-memory. jsdom tests and the in-process boot fallback.

On top of the store sits **`SessionManager`** — an in-memory cache + leaf pointer + append helpers for one active session. It implements `ReadonlySessionManager` (the shape coding-agent's extension host consumes, ported 1:1 for M8 forward-compat).

### Features

- Create, load, fork, delete, rename sessions.
- Append typed entries (messages, model changes, thinking-level changes, session info, labels, branch summaries, compaction, custom entries, custom messages).
- Walk the current leaf-to-root branch (`getBranch`) and assemble the full tree (`getTree`).
- Navigate to an alternate leaf (`navigateToLeaf`) — ephemeral; the next append grows a sibling branch.
- Build an `AgentMessage[]` + `UiMessageMeta[]` context for the agent from the current branch, including a synthetic user message that wraps the most recent compaction summary.
- Optional live observation of the session list and entry stream (Dexie backend only).

### Entry model

All entries share `SessionEntryBase = { type, id, parentId, timestamp }`. `id` is an 8-char short id; `parentId` links into the DAG (`null` for roots). `SessionEntry` is the union:

| Type | Carried fields |
| --- | --- |
| `message` | `message: AgentMessage` |
| `model_change` | `provider`, `modelId` |
| `thinking_level_change` | `thinkingLevel` |
| `session_info` | `name?` |
| `compaction` | `summary`, `firstKeptEntryId`, `tokensBefore`, `details?`, `fromHook?` |
| `branch_summary` | `fromId`, `summary`, `details?`, `fromHook?` |
| `label` | `targetId`, `label?` |
| `custom` | `customType`, `data?` |
| `custom_message` | `customType`, `content`, `display`, `details?` |

`SessionHeader = { type: 'session', version?, id, timestamp, cwd, parentSession? }`. `CURRENT_SESSION_VERSION = 3`.

## Technical reference

### Files

| File | Contents |
| --- | --- |
| `types.ts` | Entry unions, header, `SessionContext`, `UiMessageMeta`, `SessionSummary`, `SessionMeta`, `SessionTreeNode`, `ReadonlySessionManager` interface, `CURRENT_SESSION_VERSION`. |
| `ids.ts` | `generateSessionId` (UUIDv7), `generateEntryId` (8-char short id). |
| `tree.ts` | Shared tree-building helpers. |
| `store.ts` | `SessionStore` interface + `SessionRow`, `EntryRow`, `*Append` types, `CreateSessionOptions`, `ForkSessionOptions`. |
| `memory-store.ts` | `MemorySessionStore` (no live observation). |
| `dexie-store.ts` | `DexieSessionStore`, `WebAgentDB`, `DEFAULT_DB_NAME = 'web-agent'`. Uses Dexie `liveQuery` for observation. |
| `session-manager.ts` | `SessionManager implements ReadonlySessionManager`. |

### `SessionStore` interface

Storage-agnostic CRUD + append surface. Implementations must provide:

- **Lifecycle:** `createSession`, `forkSession`, `deleteSession`, `setSessionName`, `touchSession`.
- **Reads:** `listSessions`, `getSession`, `getEntries`, `getEntry`.
- **Appends** (all return the generated entry id): `appendMessage`, `appendModelChange`, `appendThinkingLevelChange`, `appendSessionInfo`, `appendCompaction`, `appendBranchSummary`, `appendLabel`, `appendCustomEntry`, `appendCustomMessageEntry`.
- **Optional observation:** `observeSessionList(cb)`, `observeEntries(sessionId, cb)` — implementations return an unsubscribe function.

`SessionRow` stores timestamps as epoch-ms (IDB indexes numerically). The mapping to ISO strings in `SessionSummary` happens at the store boundary so the RPC + picker wire format stays readable.

`ForkSessionOptions`: `{ sourceSessionId, upToEntryId, id? }`. Fork copies entries verbatim (id, parentId, timestamp) from root to `upToEntryId`, skipping `label` entries so the child starts with an empty label set.

### `DexieSessionStore`

Two Dexie tables:

- `sessions` — primary key `id`, indexed on `modifiedAt`, `createdAt`, `parentSession`.
- `entries` — compound primary key `[sessionId+id]`, indexed on `[sessionId+timestamp]` and `[sessionId+type]`.

Every append runs in an atomic transaction. `forkSession` copies the parent slice + writes the child row in a single transaction — partial forks are impossible.

`observeSessionList` / `observeEntries` use Dexie's `liveQuery` to emit on mutation. Callers are expected to unsubscribe.

### `SessionManager`

Factories:

- `SessionManager.create(store, options)` — creates a new session row, then a manager with an empty `fileEntries` array.
- `SessionManager.load(store, sessionId)` — reads the row + all entries, builds the in-memory index.

In-memory state:

- `fileEntries: SessionEntry[]` — chronological append log (mirrors store).
- `byId: Map<string, SessionEntry>` — entry lookup.
- `labelsById`, `labelTimestampsById` — label cache (last-writer-wins).
- `leafId: string | null` — current leaf pointer; starts at the last entry from the store (or `null` for new sessions).

### Append semantics

Every `append*` method:

1. Reads `parentId = this.leafId`.
2. Calls the matching `store.append*` with `(sessionId, payload, parentId)`.
3. Synthesises the typed `SessionEntry` locally.
4. Calls private `_cacheEntry(entry)` which `fileEntries.push`, `byId.set`, `leafId = entry.id`.
5. For `label` entries, updates the `labelsById` cache.

`appendSessionInfo(name)` also updates the denormalised `name` field.

### Read surface

All `ReadonlySessionManager` methods:

- `getCwd`, `getSessionDir` (returns `''` on store-backed sessions), `getSessionId`, `getSessionFile` (returns `undefined`), `getHeader`, `getEntries`, `getEntry`, `getLeafId`, `getLeafEntry`, `getLabel`, `getBranch(fromId?)`, `getTree`, `getSessionName`.

`getBranch` walks from `fromId ?? leafId` backwards through `parentId` links, returning the path root-first.

`getTree` builds a `SessionTreeNode[]` forest: every entry becomes a node; children attach to their `parentId`. Orphaned nodes (parent deleted) become roots.

### `buildSessionContext()`

The canonical "messages to feed the agent + meta for the UI" builder. Returns `{ messages, messageMeta, thinkingLevel, model }`.

Algorithm:

1. Walk `getBranch()`.
2. Find the last `compaction` entry (if any) and its `firstKeptEntryId` position.
3. If no compaction: replay every `message` entry; update `thinkingLevel` / `model` from side-effect entries in-order.
4. If a compaction exists:
   - Replay only `model_change` / `thinking_level_change` from the discarded prefix (keeps the most recent state).
   - Emit one synthetic user message wrapping the summary with `COMPACTION_SUMMARY_PREFIX` / `_SUFFIX` (from `core/compaction/prompts.ts`), with a `UiMessageMeta{ entryId, kind: 'compaction-summary', tokensBefore, firstKeptEntryId }`.
   - Replay from `firstKeptEntryId` (or the compaction entry itself if `firstKeptEntryId` can't be resolved) onward.

### Session tree ops

- `fork(fromEntryId)` — delegates to `store.forkSession`, returns a freshly-loaded `SessionManager` for the child. The parent is untouched.
- `navigateToLeaf(entryId)` — assigns `this.leafId = entryId`. No store append. On reload, the leaf is re-derived as the chronologically-latest entry; navigation is an in-memory preference only.

### `SessionSummary` and picker

Produced by `SessionStore.listSessions`. Fields: `id`, `path`, `name?`, `cwd`, `created` (ISO), `modified` (ISO), `messageCount`, `firstMessage`, `parentSessionPath?`. Used by the main-thread session picker.

`SessionMeta` is the RPC shape for the currently active session: `{ id, path: null, name?, cwd, parentSession? }`.

## Integration points

- **`WorkerAgentHost`** (see [`worker-host.md`](./worker-host.md)) — owns the active `SessionManager`, serialises appends through `writeChain`, emits `session_loaded` on every switch.
- **Compaction** (see [`compaction.md`](./compaction.md)) — reads the branch via `getBranch`, appends a `CompactionEntry` via `SessionManager.appendCompaction`, then rebuilds the agent context via `buildSessionContext` + `AgentSession.restoreMessages`.
- **RPC** (see [`rpc.md`](./rpc.md)) — `list_sessions`, `load_session`, `new_session`, `fork_session`, `navigate_to_leaf`, `delete_session`, `set_session_name`, `get_session_meta`, `session_loaded` event.

## Guarantees

1. **Atomic forks.** `forkSession` is one transaction (Dexie) or one synchronous op (memory); no partial children.
2. **Stable entry ids across forks.** A forked session's root-to-`upToEntryId` slice preserves the parent's ids/parent-links/timestamps; the compound `[sessionId+id]` primary key keeps shared ids from colliding across sessions.
3. **Versioned schema.** `CURRENT_SESSION_VERSION` lives on the header; readers can fall back on older schemas (`version` absent ⇒ v1).
4. **No JSONL coupling.** The legacy M5 ZenFS/JSONL layout is gone; `getSessionDir` / `getSessionFile` stubs exist only to satisfy `ReadonlySessionManager` for extensions that haven't migrated away from file-path assumptions.

## Tests

- `core/session/session-manager.test.ts` — context building, append ordering, tree ops.
- `core/session/dexie-store.test.ts` — atomic appends, forks, observation.
- `core/session/memory-store.test.ts` — parity baseline.
- `core/session/tree.test.ts` — tree-builder edge cases.

## Change procedure

Any plan that edits `core/session/` must update this file in the same PR. Schema changes (new entry types, new header fields) must:

1. Bump `CURRENT_SESSION_VERSION`.
2. Update `types.ts`, `store.ts` (interface + both implementations), `session-manager.ts`.
3. Update `buildSessionContext` if the new entry participates in the agent context.
4. Reflect new entry types in the table above.

See [`./index.md` § Change procedure](./index.md#change-procedure).
