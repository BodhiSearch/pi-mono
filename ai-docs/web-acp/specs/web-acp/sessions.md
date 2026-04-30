# sessions

**Source of truth:** `packages/web-acp/src/agent/session-store.ts`
(+ wiring in `src/acp/agent-adapter.ts`,
`src/acp/engine/session-runtime.ts`,
`src/acp/engine/prompt-driver.ts`,
`src/acp/engine/builtin-dispatch.ts`,
`src/acp/engine/ext-methods/*.ts`, and
`src/agent/agent-worker.ts`).

**Parent:** [`./index.md`](./index.md)

> **Note (post engine-split refactor).** Where this file
> references `AcpAgentAdapter.<member>` (e.g. `#emit`,
> `#sessions`, `#activeInlineSessionId`,
> `#tryHandleBuiltin`, `#refreshAvailableCommands`,
> `#rehydrateInlineFromStore`), those names now live on
> `AcpSessionRuntime` (`acp/engine/session-runtime.ts`),
> `PromptTurnDriver` (`acp/engine/prompt-driver.ts`), or
> `engine/builtin-dispatch.ts` and `engine/ext-methods/get-session.ts`.
> The adapter delegates; the wire surface is unchanged.
> Mapping: see [`./acp.md`](./acp.md) § "Engine layer".

## Functional scope

The session store is the **worker-owned persistence layer** for
ACP sessions. It is the M1 answer to the M0 deferred item
_"persisted sessions"_ in [`./index.md § Scope out`](./index.md#scope-out-deferred).

Two tenets:

1. **Agent-authoritative.** `AcpAgentAdapter` owns the store;
   the main thread never touches IndexedDB directly. Lists and
   replays travel over ACP (`bodhi/listSessions` ext method,
   `session/load` request) — the same path a remote agent would
   use. This preserves the "ACP is the only internal protocol"
   invariant in [`./index.md`](./index.md).
2. **ACP-native shape.** What we persist is exactly what was
   emitted: stored `SessionNotification` rows replay verbatim
   over `session/load`. We do **not** invent a bespoke message
   schema on top of pi-agent-core.

## Storage schema

Backed by **Dexie** (IndexedDB) under DB name `web-acp` (distinct
from web-agent's `web-agent`).

### Table `sessions` (primary key `id`)

| column        | type              | notes                                               |
| ------------- | ----------------- | --------------------------------------------------- |
| `id`          | `string` (pk)     | `bodhi-${crypto.randomUUID()}`; returned by `session/new`. |
| `createdAt`   | `number`          | ms since epoch.                                     |
| `updatedAt`   | `number`          | ms since epoch. Picker orders on this, descending.  |
| `title`       | `string \| null`  | Derived from the first user prompt (see below), or set explicitly via `setTitle`. |
| `turnCount`   | `number`          | Count of `recordTurn` calls — bumped on `end_turn`. |
| `lastModelId` | `string \| null`  | ID of the last model used by any turn in this session. Drives "restore selected model on load". |

Indexed on `updatedAt` for picker queries.

### Table `entries` (compound primary key `[sessionId+seq]`)

| column      | type                                                       | notes                                              |
| ----------- | ---------------------------------------------------------- | -------------------------------------------------- |
| `sessionId` | `string` (part of pk)                                      | Foreign-key to `sessions.id`.                      |
| `seq`       | `number` (part of pk)                                      | Monotonic per session; allocated inside the rw transaction as `entries.where('sessionId').equals(id).count()`. |
| `at`        | `number`                                                   | ms since epoch.                                    |
| `kind`      | `'notification' \| 'turn' \| 'builtin'`                    | See below.                                         |
| `payload`   | `SessionNotification \| TurnPayload \| BuiltinPayload`     | Raw ACP notification for `notification`; synthetic summary for `turn`; agent-handled built-in record for `builtin`. |

Indexed on `sessionId` for range scans. The `payload` column is
polymorphic by design — adding a new entry kind (M4 phase B added
`'builtin'`) does **not** require a Dexie version bump because the
on-disk shape only needs a new discriminator value.

### Table `features` (primary key `sessionId`) — M2

The M2 `features` table was added by a Dexie version-2 migration in
the same database. It carries per-session feature-toggle overrides:

| column      | type                     | notes |
| ----------- | ------------------------ | ----- |
| `sessionId` | `string` (pk)            | Foreign-key to `sessions.id`. |
| `flags`     | `Record<string,boolean>` | Sparse override map; unset keys fall back to `FEATURE_DEFAULTS`. |
| `updatedAt` | `number`                 | ms since epoch; last toggle change. |

`createSessionStore` is split into `openSessionDb()` +
`createStoreFromDb()` so the worker can share a single Dexie handle
with `createFeatureStore(db)` without double-opening the database
(Dexie enforces one instance per tab). See
[`./features.md`](./features.md) for the full API.

**No `schemaVersion` column on the row level.** Dexie manages the
store-level version (`1` for M1, `2` for M2). When pi-agent-core's
message shape drifts we'll either bump the Dexie version again or
add per-row gating in the milestone that needs it.

### Entry kinds

- **`notification`** — the raw `SessionNotification` object as
  emitted by `AcpAgentAdapter.#emit`. Replay re-emits these
  verbatim over `session/load`.
- **`turn`** — synthetic summary written at `end_turn`:
  ```ts
  interface TurnPayload {
    userText: string;          // the text we passed to inline.prompt
    finalMessages: AgentMessage[]; // inline.getMessages() after resolve
    modelId: string;           // the model that ran this turn
  }
  ```
  `finalMessages` lets `session/load` call
  `InlineAgent.restoreMessages(...)` so follow-up prompts on a
  restored session use the persisted context.
  `modelId` is the hook that lets the UI re-select the model
  that was in use when the user last spoke with this session.
- **`builtin`** (M4 phase B) — record of an agent-handled
  built-in slash command (`/help`, `/version`, `/session`,
  `/copy`):
  ```ts
  interface BuiltinPayload {
    command: string;          // 'help' | 'version' | 'session' | 'copy'
    userText: string;         // raw `/cmd args` text the user sent
    replyText: string;        // agent-produced reply rendered to the user
    action?: { kind: string };// e.g. { kind: 'copy' } for /copy
  }
  ```
  Built-ins bypass the LLM entirely — they are matched in
  `AcpAgentAdapter.prompt()` before model resolution and never
  enter `inline.state.messages`. Persistence keeps `'builtin'`
  rows separate from `'turn'` rows so `inline.restoreMessages()`
  on `session/load` consumes only `'turn'` entries; the LLM stays
  blind to built-in exchanges across reloads. See
  [`./commands.md`](./commands.md) for the full surface (wire,
  picker, render distinction, client-side action dispatch).

## Public interface (`SessionStore`)

Defined in `packages/web-acp/src/agent/session-store.ts`.

```ts
export interface SessionStore {
  createSession(id: string, at?: number): Promise<void>;
  recordNotification(id: string, notification: SessionNotification, at?: number): Promise<void>;
  recordTurn(
    id: string,
    userText: string,
    finalMessages: AgentMessage[],
    modelId: string,
    at?: number
  ): Promise<void>;
  recordBuiltin(id: string, payload: BuiltinPayload, at?: number): Promise<void>;
  listSummaries(): Promise<SessionSummary[]>;
  readEntries(id: string): Promise<SessionEntry[]>;
  getSession(id: string): Promise<SessionRow | undefined>;
  setTitle(id: string, title: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}
```

- **`createSession`** — inserts a row with `title = null`,
  `turnCount = 0`, `lastModelId = null`. Called from
  `AcpAgentAdapter.newSession` after the id is generated.
- **`recordNotification`** — appends a `notification` entry;
  updates `sessions.updatedAt`. Never derives anything from the
  payload. Called on every `#emit(...)` in the adapter.
- **`recordTurn`** — appends a `turn` entry; bumps `turnCount`;
  sets `lastModelId`; on the **first** turn of a session with no
  explicit title, derives one via
  `deriveTitle(userText)`. Called once per `end_turn` in
  `AcpAgentAdapter.prompt`.
- **`recordBuiltin`** (M4 phase B) — appends a `builtin` entry;
  bumps `sessions.updatedAt`. Does **not** bump `turnCount` (a
  built-in is not a model turn) and does **not** claim the
  session title slot (the first real prompt still wins). Called
  from `AcpAgentAdapter.#tryHandleBuiltin` after the agent emits
  the built-in's reply chunk.
- **`listSummaries`** — picker feed. Orders by `updatedAt DESC`.
  Drops `payload` (entries) — returns only the denormalised
  fields the picker needs.
- **`readEntries`** — full session log in `seq` order. Consumed
  by `AcpAgentAdapter.loadSession` (Phase C) for replay.
- **`getSession`** — single-row lookup; used for admin paths.
- **`setTitle`** — overrides the derived title; bumps
  `updatedAt`.
- **`deleteSession`** — deletes the session row and all its
  entries in a single Dexie transaction.

### Title derivation (`deriveTitle`)

```ts
export function deriveTitle(userText: string): string;
```

- Collapses whitespace runs to single spaces; trims.
- Truncates to 60 characters with a trailing `…`.
- Runs in worker context; no LLM call.

The picker's title is "first user prompt, one line" by default.
Users can override via `setTitle` (exposed behind a future
`bodhi/renameSession` ext method; Phase D stretch).

## Integration points

### `AcpAgentAdapter` (worker side)

The adapter owns a **single** `SessionStore` reference passed in
from `agent-worker.ts`. All persistence calls are best-effort on
failures of `recordNotification` — a log, no throw — because the
wire emission already happened and we don't want to break the
in-flight turn. `recordTurn` and `createSession` do throw on
failure because they're the session-creation / turn-finalisation
barrier.

Call sites (Phase A):

- `newSession` → `store.createSession(sessionId)`.
- Every `#emit(notification)` → `store.recordNotification(sessionId, notification)`.
- `prompt` on clean `end_turn` → `store.recordTurn(sessionId, text, inline.getMessages(), model.id)`.

Call sites (Phase B/C):

- `extMethod('bodhi/listSessions')` → `store.listSummaries()`.
- `extMethod('bodhi/getSession')` → `store.readEntries(sessionId)`,
  walks entries in `seq` order to build the rendered transcript:
  each `'turn'` entry's `finalMessages` snapshot is diffed against
  the previous turn to extract the new user + assistant pair; each
  `'builtin'` entry inserts a synthetic user + assistant pair tagged
  with a `_builtin` field carrying `{ command, action? }`. Returns
  the interleaved list together with `lastModelId` + `title` so
  the main thread can rehydrate the transcript and model selector
  in one call, without aggregating stream chunks.
- `loadSession(sessionId)` → `store.readEntries(sessionId)` →
  replay each `'notification'` entry as `conn.sessionUpdate(...)`;
  then `inline.restoreMessages(lastTurn.finalMessages)` and set
  `#activeInlineSessionId = sessionId`. `'builtin'` entries are
  silently skipped during this loop — built-in exchanges are
  rebuilt from the `bodhi/getSession` snapshot on the client side
  and never re-enter `inline.state.messages`.
- `prompt` on a session whose state isn't loaded into the inline
  runtime (e.g. client raced before `session/load`) →
  `#rehydrateInlineFromStore(sessionId)` first. Prevents splicing
  another session's context into the current turn's `finalMessages`.
- `newSession` additionally calls `inline.clearMessages()` and sets
  `#activeInlineSessionId = sessionId`, so a "New chat" immediately
  after a previous session does not inherit the old messages.
- `prompt` on a recognised built-in (M4 phase B) →
  `#tryHandleBuiltin(...)` runs the handler, emits the reply chunk
  with `_meta.bodhi.builtin`, and calls `store.recordBuiltin(...)`.
  Returns `{ stopReason: 'end_turn' }` without any `inline.prompt`
  invocation — the LLM never sees the exchange.

### `InlineAgent` (worker side)

`InlineAgent.restoreMessages(messages)` is the hook Phase C uses
to seed `agent.state.messages` without firing `AgentEvent`s.
Defined in [`./agent.md`](./agent.md#inline-agentts).

### `agent-worker.ts`

Instantiates `createSessionStore()` at boot and hands it to the
adapter. The store is worker-only — the main-thread bundle never
imports `session-store.ts`.

### `useAcp` (main thread, Phase B/C)

Listens to picker state, calls
`AcpClient.listSessions()` / `AcpClient.loadSession(id)` which
translate to ext-method / `session/load` calls over the ACP
wire. Full hook state shape in [`./hook.md`](./hook.md).

## Invariants

1. **Worker-only.** The store is instantiated inside the Web
   Worker. No code in `src/hooks/`, `src/components/`, or
   `src/App.tsx` may import `session-store.ts` directly.
2. **Exactly-once persistence per emission.** Every
   `SessionNotification` that leaves `AcpAgentAdapter.#emit`
   lands as exactly one row in `entries`. The emit + persist
   pair is **not** transactional on the wire — if the browser
   crashes between `#conn.sessionUpdate` and
   `recordNotification`, a sent-but-unstored delta is lost.
   Acceptable because replay is "best available history", not
   byte-for-byte reconstruction of a crash.
3. **`seq` is monotonic per session.** Allocated inside the
   Dexie rw transaction as a count of existing entries. Safe
   because entries are append-only until the whole session is
   deleted.
4. **IndexedDB is multi-tab safe.** Dexie serialises writes
   across tabs on the same origin. A second tab sees appends
   from the first on its next `listSummaries()` call. No
   cross-tab live updates for M1 (see out-of-scope note in the
   M1 plan).
5. **No `_meta` extensions for sessions.** All session-related
   data travels through first-class ACP methods or the
   `bodhi/listSessions` ext method. We don't piggy-back on
   `_meta` for session identity or restore state. (M4 phase B's
   `_meta.bodhi.builtin` rides on `session/update` notifications
   and is a render/dispatch hint, not a session-identity claim.)
6. **LLM blindness for built-ins** (M4 phase B). `'builtin'`
   entries never feed `inline.restoreMessages()` — only `'turn'`
   entries do. A built-in exchange therefore cannot leak into
   the LLM's view on any subsequent prompt, even after a
   `session/load` round trip.

## Tests

- **`packages/web-acp/src/agent/session-store.test.ts`** (vitest
  + `fake-indexeddb`). Covers:
  - create → list ordering (`updatedAt DESC`).
  - `recordNotification` monotonicity + order preservation.
  - `recordTurn` first-turn title derivation, subsequent-turn
    `turnCount` / `lastModelId` updates with title unchanged.
  - Interleaved notifications + turns keep `seq` monotonic.
  - `recordNotification` / `recordTurn` reject unknown sessions.
  - `deleteSession` atomically removes row + entries.
  - `setTitle` overrides derived title.
  - `deriveTitle` whitespace collapsing + 60-char truncation.
  - `recordBuiltin` round-trip — payload integrity, `turnCount`
    unchanged, `title` unclaimed, action descriptor preserved,
    rejection on unknown sessions, interleaving with `recordTurn`
    by `seq`.
- **`packages/web-acp/e2e/sessions-persist.spec.ts`** (Phase B):
  DOM-witness that a prompt creates a session row surviving
  reload.
- **`packages/web-acp/e2e/sessions-resume.spec.ts`** (Phase C):
  DOM-witness that `session/load` replays the transcript and
  restores the last-used model in the UI.

## Non-goals (M1)

- Fork / branch / navigate — M3 (`SessionTree`).
- Context compaction rows — M4.
- Encryption at rest — post-v1.
- LLM-generated titles — M5 (skills).
- Cross-tab live updates for the picker — post-v1.
- Second-transport parity for the store — the store is
  worker-local, not transport-adjacent; no double-writer
  scenarios.

## Change procedure

Any plan that edits `packages/web-acp/src/agent/session-store.ts`
or the adapter's call sites into the store must update this file
in the same commit. When a new entry kind lands (e.g.
`compaction` at M4), add it to the table above and document the
payload shape. When the ACP wire surface changes
(`bodhi/listSessions` → upstream `session/list`, for instance),
update both this file and [`./acp.md`](./acp.md).

See [`./index.md` § Change procedure](./index.md#change-procedure).
