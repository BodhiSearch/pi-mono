# Sessions — `SessionStore` interface + entry shapes

**Source of truth (agent package):** `packages/web-acp-agent/src/storage/session-store.ts`.

> **ACP 0.21 migration delta (M1, M2, M5-deferred).**
> - `Agent.listSessions` (M2) returns `SessionInfo[]` with
>   Bodhi-extras (`turnCount`, `lastModelId`, `createdAt`) on
>   `_meta.bodhi`. The legacy `bodhi/listSessions` ext-method has
>   been deleted.
> - `Agent.closeSession` (M1) does in-memory cleanup only;
>   `_bodhi/sessions/delete` retained for the user-visible delete
>   gesture, internally calling close path → `store.deleteSession`.
> - `LoadSessionResponse._meta.bodhi.{title, mcpToggles}` (M1)
>   carry the snapshot the host needs to rebuild picker label +
>   toggle UI in a single round-trip.
> - **`bodhi/getSession` collapse (M5) deferred.** Still live; the
>   pre-load snapshot fetch remains for now. See
>   `packages/web-acp/TECHDEBT.md` § "M5 deferred".

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
  Map; SQLite-backed swap-in is a future follow-up — see
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md)).

The object of record is whatever `session/new` returned plus
the transcript of `session/update` events the engine layer
emits. Replay = re-execute every persisted notification +
reseed the inline agent's history from the last `'turn'`
entry.

## `SessionStore` interface — `storage/session-store.ts:123`

```ts
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
| `createSession(id)` | `acp/agent-adapter.ts:newSession` (`:128`) | Inserts a fresh `SessionRow` (`createdAt`, `updatedAt`, `title: null`, `turnCount: 0`, `lastModelId: null`). |
| `recordNotification(id, notif)` | `acp/engine/session-runtime.ts:emit` (`:362`) | Appends a `'notification'` entry. Persists the wire bytes verbatim so `loadSession` replay re-emits them through `runtime.sendRawNotification` without translation. |
| `recordTurn(id, userText, finalMessages, modelId)` | `acp/engine/prompt-driver.ts:run` (`:163`) | Appends a `'turn'` entry, bumps `turnCount`, sets `title` from `deriveTitle(userText)` if not set, sets `lastModelId`. The single source of inline-agent history for `loadSession`. |
| `recordBuiltin(id, payload)` | `acp/engine/builtin-dispatch.ts:tryHandleBuiltin` (`:80`) | Appends a `'builtin'` entry. M4 phase B — built-ins are the *only* exchange persisted as a non-notification, non-turn entry. The host's `bodhi/getSession` rebuild interleaves these alongside `'turn'` entries. |
| `listSummaries()` | `acp/engine/ext-methods/list-sessions.ts:listSessions` | Returns every session row in some host-defined order (browser sorts by `updatedAt desc`). |
| `readEntries(id)` | `loadSession` (`:176`), `rehydrateInlineFromStore` (`:234`), `bodhi/getSession` (`acp/engine/ext-methods/get-session.ts`) | Returns entries in insertion order (`seq`-ordered). |
| `getSession(id)` | `loadSession` (`:155`), `bodhi/getSession`, `acp/engine/ext-methods/sessions-delete.ts:sessionsDelete`, `acp/engine/session-runtime.ts:sessionStatsFor` | Returns the row or `undefined`. |
| `setTitle(id, title)` | Reserved — no caller in M4. The host UI can drive a future `_bodhi/sessions/setTitle` extension method. |
| `deleteSession(id)` | `acp/engine/ext-methods/sessions-delete.ts:sessionsDelete` | Drops the row + every entry + per-session features + per-session mcpToggles. The host impl runs this transactionally. |

## Entry shapes

### `SessionEntryKind` — `:20`

`'notification' | 'turn' | 'builtin'`. Adding a new kind is
on-disk-compatible: the entries table stores `payload` as a
polymorphic blob keyed only by `[sessionId+seq]`, so the
M4-phase-B `'builtin'` addition didn't require a Dexie version
bump.

### `SessionEntry` — `:48`

```ts
interface SessionEntry {
    sessionId: string;
    seq: number;          // monotonic per session
    at: number;           // epoch ms
    kind: SessionEntryKind;
    payload: SessionNotification | TurnPayload | BuiltinPayload;
}
```

### `TurnPayload` — `:22`

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

### `BuiltinPayload` — `:41`

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
host's `bodhi/getSession` rebuild (handled by the agent in
`get-session.ts`) interleaves them by timestamp so the picker
displays the muted-builtin badge alongside live turns.

### `SessionRow` — `:56`

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

### `SessionSummary` — `:65`

The picker's view shape. Currently mirrors `SessionRow`
field-for-field; kept independent so internal row evolution
doesn't force a wire bump.

## Adjacent rows owned by the host impl

`storage/session-store.ts` also defines two row shapes the
host's persistence layer is expected to manage alongside the
sessions table:

- `FeatureRow` (`:91`) — per-session feature flags (M2 phase
  B). One row per `sessionId`; `flags: Record<string, boolean>`.
  Owned at the wire by `FeatureStore` —
  [`features.md`](./features.md).
- `McpTogglesRow` (`:116`) — per-session MCP server / tool
  on-off flags (M3 phase B). Absent keys mean "default on";
  see semantics comment in source. Owned at the wire by
  `McpToggleStore` — [`mcp.md`](./mcp.md).

The browser host bundles all four (`sessions`, `entries`,
`features`, `mcpToggles`) into a single Dexie database
(`SessionStoreDb` v3). Different host impls can split the
storage as needed — the agent only knows the four interfaces.

## `deriveTitle(userText)` — `:80`

Helper exported alongside the interface. Whitespace-collapses
the input, trims, truncates to 60 chars (with an `…` marker).
Re-used by host-side UI rendering of session summaries (e.g.
`packages/web-acp/src/components/chat/SessionPicker.tsx`).

## Replay contract

The agent's wire shim (`acp/agent-adapter.ts:loadSession`,
`:150`) is the canonical consumer. It:

1. Calls `store.getSession(id)` — throws if unknown.
2. Re-acquires MCP connections under the request's headers
   (releasing any prior config first; the pool re-keys by
   fingerprint).
3. Re-installs `requestedMcpUrls` + `mcpInstances` from
   `_meta.bodhi`.
4. Calls `store.readEntries(id)`.
5. Iterates: `'notification'` → `runtime.sendRawNotification`
   (no double-persist); `'turn'` → captures the latest
   `finalMessages`. `'builtin'` entries are intentionally
   *not* re-emitted on the wire — the host rebuilds the
   built-in bubbles via a follow-up `bodhi/getSession` round
   trip after `loadSession` resolves (this keeps replay
   bytes-faithful for the live `session/update` stream while
   letting the host stamp the muted-builtin metadata).
6. Calls `services.inline.restoreMessages(lastTurnMessages)`
   if found, else `services.inline.clearMessages()`.
7. Marks the inline session active, acquires MCP connections,
   refreshes the available-commands cache.

## Cross-references

- Engine that emits + persists:
  [`acp.md`](./acp.md) (especially
  `AcpSessionRuntime.emit` and `PromptTurnDriver.run`).
- Host-side concrete impl:
  [`../web-acp-client/storage-dexie.md`](../web-acp-client/storage-dexie.md).
- CLI host's in-memory impl:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
- Built-in payload shape + action discriminator:
  [`commands.md`](./commands.md).
