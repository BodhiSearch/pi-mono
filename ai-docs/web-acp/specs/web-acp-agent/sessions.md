# Sessions — `SessionStore` interface + entry shapes

**Source of truth (agent package):** `packages/web-acp-agent/src/storage/session-store.ts`.

## Purpose

The agent package defines the **shape types** and **interface
contract** for ACP session persistence. Host runtimes ship the
concrete implementation:

- Browser host:
  `packages/web-acp/src/runtime/storage-dexie/session-store.ts:createStoreFromDb`
  (Dexie + IndexedDB, schema v3 — see
  [`../web-acp-client/storage-dexie.md`](../web-acp-client/storage-dexie.md)).
- Node TTY CLI:
  `packages/cli-acp-client/src/services/stores.ts` (in-memory
  `Map`; SQLite-backed swap-in is a future follow-up — see
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md)).

Session listing rides standard `Agent.listSessions` (handler
`acp/handlers/session-crud.ts:handleListSessions`); session
deletion rides `_bodhi/sessions/delete` and goes through the
runtime's unified `tearDownSession` path; per-session model
selection rides standard `Agent.unstable_setSessionModel` and
mutates `SessionState.currentModelId` only — `SessionRow.lastModelId`
is updated lazily by `recordTurn`.

The object of record is whatever `session/new` returned plus
the transcript of `session/update` events the engine layer
emits. Replay = re-execute every persisted notification +
reseed the inline agent's history from the last `'turn'`
entry.

> **TECHDEBT (M5 deferred — `bodhi/getSession` collapse).** The
> built-in transcript still requires a follow-up
> `_bodhi/session/get` round-trip after `loadSession` resolves
> because `walkEntries` in `handleLoadSession` replays
> notifications + turns only. The TODO at
> `acp/handlers/session-crud.ts:93–96` tracks the consolidation;
> see also `packages/web-acp/TECHDEBT.md` § "M5 deferred".

## `SessionStore` interface — `storage/session-store.ts:115`

```ts
// session-store.ts:115–131
interface SessionStore {
    createSession(id: string, at?: number): Promise<void>;
    recordNotification(
        id: string,
        notification: SessionNotification,
        at?: number,
    ): Promise<void>;
    recordTurn(
        id: string,
        userText: string,
        finalMessages: AgentMessage[],
        modelId: string,
        at?: number,
    ): Promise<void>;
    recordBuiltin(
        id: string,
        payload: BuiltinPayload,
        at?: number,
    ): Promise<void>;
    listSummaries(): Promise<SessionSummary[]>;
    readEntries(id: string): Promise<SessionEntry[]>;
    getSession(id: string): Promise<SessionRow | undefined>;
    setTitle(id: string, title: string): Promise<void>;
    deleteSession(id: string): Promise<void>;
}
```

| Method | Called by | Effect |
| --- | --- | --- |
| `createSession(id)` | `acp/handlers/session-crud.ts:handleNewSession` (`:44`) | Inserts a fresh `SessionRow` (`createdAt`, `updatedAt`, `title: null`, `turnCount: 0`, `lastModelId: null`). |
| `recordNotification(id, notif)` | `acp/engine/session-runtime.ts:emit` (`:326`) | Appends a `'notification'` entry. Persists the wire bytes verbatim so `loadSession` replay re-emits them through `runtime.sendRawNotification` without translation. |
| `recordTurn(id, userText, finalMessages, modelId)` | `acp/engine/prompt-driver.ts:#runTurn` | Appends a `'turn'` entry, bumps `turnCount`, sets `title` from `deriveTitle(userText)` if not set, sets `lastModelId`. The single source of inline-agent history for `loadSession`. |
| `recordBuiltin(id, payload)` | `acp/engine/builtin-dispatch.ts:tryHandleBuiltin` | Appends a `'builtin'` entry. The host's `_bodhi/session/get` rebuild interleaves these alongside `'turn'` entries via `walkEntries(turn + builtin)`. |
| `listSummaries()` | `acp/handlers/session-crud.ts:handleListSessions` (`:144`) | Returns every session row in some host-defined order (browser sorts by `updatedAt desc`). Unpaginated — `sessionCapabilities.list = {}` does not advertise cursor support. |
| `readEntries(id)` | `acp/handlers/session-crud.ts:handleLoadSession` (`:91`), `acp/engine/session-runtime.ts:rehydrateInlineFromStore` (`:223`), `acp/engine/ext-methods/get-session.ts:getSession` | Returns entries in insertion order (`seq`-ordered). |
| `getSession(id)` | `handleLoadSession` (`:71`), `get-session.ts`, `sessions-delete.ts`, `acp/engine/session-runtime.ts:sessionStatsFor` (`:302`) | Returns the row or `undefined`. |
| `setTitle(id, title)` | Reserved — no caller. The host UI can drive a future `_bodhi/sessions/setTitle` extension method. |
| `deleteSession(id)` | `acp/engine/session-runtime.ts:tearDownSession` (`:122`, only when `persistRow: false`) | Drops the row + every entry + per-session features + per-session mcpToggles. The host impl runs this transactionally. The runtime guarantees teardown order (abort matching prompt → release MCP refs → drop in-memory state → delete persisted row). |

## Entry shapes

### `SessionEntryKind` — `:18`

`'notification' | 'turn' | 'builtin'`. Adding a new kind is
on-disk-compatible: the entries table stores `payload` as a
polymorphic blob keyed only by `[sessionId+seq]`, so the
`'builtin'` addition didn't require a Dexie version bump.

### `SessionEntry` — `:44`

```ts
interface SessionEntry {
    sessionId: string;
    seq: number;          // monotonic per session
    at: number;           // epoch ms
    kind: SessionEntryKind;
    payload: SessionNotification | TurnPayload | BuiltinPayload;
}
```

### `TurnPayload` — `:20`

```ts
interface TurnPayload {
    userText: string;
    finalMessages: AgentMessage[];   // pi-agent-core inline history
    modelId: string;
}
```

`finalMessages` is the entire conversation as the
`InlineAgent` saw it after the turn. `loadSession` replay (and
`rehydrateInlineFromStore`) feeds the **last** turn's
`finalMessages` into `services.inline.restoreMessages`.

### `BuiltinPayload` — `:37`

```ts
interface BuiltinPayload {
    command: string;                    // e.g. 'help', 'copy', 'mcp'
    userText: string;                   // raw '/help' invocation
    replyText: string;                  // markdown rendered server-side
    action?: AnyBodhiBuiltinAction;     // discriminated union
}
```

Built-ins are intentionally invisible to the LLM: because
they're not `'turn'` entries, they don't show up in
`finalMessages`, so `restoreMessages` can't see them. The
host's `_bodhi/session/get` rebuild (handled by the agent in
`acp/engine/ext-methods/get-session.ts`) interleaves them by
seq order using the shared `walkEntries(turn + builtin)`
walker so the picker displays the muted-builtin badge alongside
live turns.

### `SessionRow` — `:52`

```ts
interface SessionRow {
    id: string;
    createdAt: number;
    updatedAt: number;
    title: string | null;
    turnCount: number;
    lastModelId: string | null;
}
```

`turnCount` increments on `recordTurn` only — built-ins bump
`updatedAt` for picker freshness but never count as turns.

`title` is set from `deriveTitle(userText)` on the *first*
`recordTurn`; subsequent turns don't overwrite. This means a
session whose first interaction is a built-in (e.g. `/help`)
keeps `title: null` until the first real prompt — by design.

### `SessionSummary` — `:61`

The picker's view shape. Mirrors `SessionRow` field-for-field
today; kept independent so internal row evolution doesn't force
a wire bump.

## Adjacent rows owned by the host impl

`storage/session-store.ts` also defines two row shapes the
host's persistence layer is expected to manage alongside the
sessions table:

- `FeatureRow` (`:86`) — per-session feature flags. One row per
  `sessionId`; `flags: Record<string, boolean>`. Owned at the
  wire by `FeatureStore` — see [`features.md`](./features.md).
- `McpTogglesRow` (`:108`) — per-session MCP server / tool
  on-off flags. Absent keys mean "default on"; see semantics
  comment in source. Owned at the wire by `McpToggleStore` —
  see [`mcp.md`](./mcp.md).

The browser host bundles all four (`sessions`, `entries`,
`features`, `mcpToggles`) into a single Dexie database
(`SessionStoreDb` v3). Different host impls can split the
storage as needed — the agent only knows the four interfaces.

## `deriveTitle(userText)` — `:76`

Helper exported alongside the interface. Whitespace-collapses
the input, trims, truncates to 60 chars (with an `…` marker
that fits inside the limit). Re-used by host-side UI rendering
of session summaries (e.g.
`packages/web-acp/src/components/chat/SessionPicker.tsx`).

## Replay walker — `acp/engine/replay.ts`

`acp/engine/replay.ts:walkEntries(entries, walkers)` (`:13`)
is the shared session-entry walker — three optional callbacks
(`notification`, `turn`, `builtin`); absent callbacks skip
that kind silently. Sequential dispatch preserves persisted
`seq` order, which `loadSession` relies on for replay
determinism. Three call sites:

- `acp/handlers/session-crud.ts:handleLoadSession` —
  notifications + turns (re-emit + capture last-turn
  messages).
- `acp/engine/session-runtime.ts:rehydrateInlineFromStore` —
  turns only.
- `acp/engine/ext-methods/get-session.ts:getSession` — turns
  + built-ins (interleave by seq order).

## Replay contract

The agent's `loadSession` handler
(`acp/handlers/session-crud.ts:handleLoadSession`, `:63`) is
the canonical consumer. It:

1. Calls `store.getSession(id)` — throws if unknown.
2. Releases prior MCP connections under the **previous**
   config (so the pool can re-key under new headers without
   dropping servers the caller wants to keep).
3. Re-installs `requestedMcpUrls` + `mcpInstances` from
   `_meta.bodhi`, seeds `SessionState.currentModelId` from
   `row.lastModelId`.
4. Calls `store.readEntries(id)`.
5. Iterates via `walkEntries`: `'notification'` →
   `runtime.sendRawNotification` (no double-persist);
   `'turn'` → captures the latest `finalMessages`. `'builtin'`
   entries are intentionally *not* re-emitted here — the host
   rebuilds the built-in bubbles via a follow-up
   `_bodhi/session/get` round trip after `loadSession`
   resolves (this keeps replay bytes-faithful for the live
   `session/update` stream while letting the host stamp the
   muted-builtin metadata).
6. Calls `services.inline.restoreMessages(lastTurnMessages)`
   if found, else `services.inline.clearMessages()`.
7. Marks the inline session active, acquires MCP connections
   under the new request, refreshes the available-commands
   cache.
8. Lazy-loads the model catalog
   (`adapter-context.ts:tryEnsureModels`) and seeds the
   session's current model via
   `adapter-context.ts:resolveSeededModelId(models,
   row.lastModelId)`.
9. Returns `LoadSessionResponse` with `models?` (when the
   catalog is non-empty), `configOptions` (built from the
   persisted feature row), and `_meta.bodhi.{ title,
   mcpToggles }` so the host UI can rebuild the picker label
   + toggle state in the same round trip.

## Cross-references

- Engine that emits + persists:
  [`acp.md`](./acp.md) (especially
  `AcpSessionRuntime.emit`, `emitConfigOptionUpdate`, and
  `PromptTurnDriver.#runTurn`).
- Host-side concrete impl:
  [`../web-acp-client/storage-dexie.md`](../web-acp-client/storage-dexie.md).
- CLI host's in-memory impl:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
- Built-in payload shape + action discriminator:
  [`commands.md`](./commands.md).
