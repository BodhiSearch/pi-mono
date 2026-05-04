# Storage — Dexie/IndexedDB store implementations

**Source of truth:** `packages/web-acp/src/runtime/storage-dexie/`.

## Purpose

Browser-host concrete implementations of the agent-package
storage interfaces (`SessionStore`, `PreferenceStore`). Backed
by a single Dexie database (`SessionStoreDb`, schema v4) with
three tables: `sessions`, `entries`, `preferences` (compound
key `[sessionId+key]`, value `unknown`).

> **Post-`provider-agnostic-embed-simplification` callout.**
> Schema bumped v3 → v4: legacy `features` and `mcpToggles`
> tables dropped; unified `preferences` table replaces both.
> No data migration — per-session toggles reset to defaults on
> first load post-upgrade (acceptable for a dev-only package).
> Body text below predates the refactor; canonical impl lives
> at `runtime/storage-dexie/preference-store.ts`. See
> `ai-docs/plans/provider-agnostic-embed-simplification.md`.

## `SessionStoreDb` schema — `runtime/storage-dexie/db.ts`

```ts
class SessionStoreDb extends Dexie {
    sessions!: Table<SessionRow, string>;
    entries!: Table<SessionEntry, [string, number]>;
    features!: Table<FeatureRow, string>;
    mcpToggles!: Table<McpTogglesRow, string>;
}
```

Schema migrations:

| Version | Tables | Notes |
| --- | --- | --- |
| v1 | `sessions: '&id, updatedAt'`, `entries: '&[sessionId+seq], sessionId'` | Initial sessions + entries (M1). |
| v2 | + `features: '&sessionId'` | Per-session feature flags (M2 phase B). |
| v3 | + `mcpToggles: '&sessionId'` | Per-session MCP server / tool toggles (M3 phase B). |

`DEFAULT_SESSION_DB_NAME = 'web-acp'`. Do **not** rename
without a migration plan — the constant is on-disk identity
for every existing tab.

`openSessionDb(options?)` (`db.ts:52`): `new SessionStoreDb(options.dbName ?? DEFAULT_SESSION_DB_NAME)`.

## `createStoreFromDb` — `runtime/storage-dexie/session-store.ts:13`

Implements `SessionStore` from `@bodhiapp/web-acp-agent`.
Methods:

| Method | Behaviour |
| --- | --- |
| `createSession(id, at)` | `db.sessions.put({ id, createdAt: at, updatedAt: at, title: null, turnCount: 0, lastModelId: null })`. |
| `recordNotification(id, notif, at)` | Transactional `rw` over `sessions + entries`. Loads the row (throws on miss); allocates `seq = nextSeq(db, id)` (= `count()` of entries for that session — see invariant note below); puts `{ sessionId, seq, at, kind: 'notification', payload }`; bumps `updatedAt`. |
| `recordTurn(id, userText, finalMessages, modelId, at)` | Transactional. Loads row, allocates `seq`, puts `{ kind: 'turn', payload: { userText, finalMessages, modelId } }`. Updates the row: `updatedAt`, `turnCount + 1`, `title = title ?? (turnCount === 0 ? deriveTitle(userText) : null)`, `lastModelId`. |
| `recordBuiltin(id, payload, at)` | Transactional. Allocates `seq`, puts `{ kind: 'builtin', payload }`. Bumps `updatedAt` only — does **not** bump `turnCount` or claim the title slot. |
| `listSummaries()` | `db.sessions.orderBy('updatedAt').reverse().toArray()` mapped to `SessionSummary`. |
| `readEntries(id)` | `db.entries.where('sessionId').equals(id).sortBy('seq')`. |
| `getSession(id)` | `db.sessions.get(id)`. |
| `setTitle(id, title)` | `db.sessions.update(id, { title, updatedAt: Date.now() })`. |
| `deleteSession(id)` | Single transaction over `sessions + entries + features + mcpToggles`: deletes every entry, the per-session features row, the per-session mcpToggles row, then the sessions row. |

### `nextSeq` invariant — `session-store.ts:113`

```ts
async function nextSeq(db: SessionStoreDb, sessionId: string): Promise<number> {
    return db.entries.where('sessionId').equals(sessionId).count();
}
```

Called from inside a `rw` transaction on `entries`. Dexie
serialises writes on a table within a transaction, so
`count()` followed by `seq = count` is monotonic **as long
as entries for a given session are never individually
deleted** (only whole-session deletion). This invariant
holds today; a future "delete one notification" feature
would need to switch to a `MAX(seq) + 1` scheme.

`createSessionStore(options)` (`session-store.ts:9`) is the
factory most callers use — wraps `createStoreFromDb(openSessionDb(options))`.

## `createFeatureStore` — `runtime/storage-dexie/feature-store.ts:15`

Implements `FeatureStore`. Reads merge persisted overrides
on top of `FEATURE_DEFAULTS` from the agent package; writes
only persist the override patch to keep the wire shape
minimal.

```ts
async get(sessionId) {
    const row = await db.features.get(sessionId);
    return mergeWithDefaults(row?.flags);
}

async set(sessionId, key, value) {
    if (!isFeatureKey(key)) throw new Error(`Unknown feature key '${key}'`);
    const current = (await db.features.get(sessionId))?.flags ?? {};
    const nextFlags = { ...current, [key]: value };
    await db.features.put({ sessionId, flags: nextFlags, updatedAt: Date.now() });
    return mergeWithDefaults(nextFlags);
}

async clear(sessionId) {
    await db.features.delete(sessionId);
}
```

`mergeWithDefaults(flags)` (`:39`) merges `FEATURE_DEFAULTS`
under `flags ?? {}`. Newly-introduced flags surface
immediately (no migration).

`isFeatureKey(key)` is imported from `@bodhiapp/web-acp-agent`
— the agent package owns the canonical key list. Throwing
on unknown keys mirrors the agent's
`handleSetSessionConfigOption` validation in
`acp/handlers/session-crud.ts`; the host's `setFeature`
inline callback in `useAcp.ts` catches the resulting
JSON-RPC error and surfaces it via `setError` (toast layer).

## `createMcpToggleStore` — `runtime/storage-dexie/mcp-toggle-store.ts:20`

Implements `McpToggleStore`. Three writes (`setServer`,
`setTool`, `clear`) plus `get`. Each write reads the current
row, patches additively, puts the full updated row, returns
the snapshot.

`rowToSnapshot(row)` (`:10`) deeply clones the per-server
tool maps so callers can't mutate the cached row. (The bare
return value would alias the live Dexie object.)

```ts
async get(sessionId) {
    return rowToSnapshot(await db.mcpToggles.get(sessionId));
}

async setServer(sessionId, serverSlug, value) {
    const current = await db.mcpToggles.get(sessionId);
    const nextServers = { ...(current?.servers ?? {}), [serverSlug]: value };
    const next: McpTogglesRow = { sessionId, servers: nextServers,
        tools: current?.tools ?? {}, updatedAt: Date.now() };
    await db.mcpToggles.put(next);
    return rowToSnapshot(next);
}
```

`setTool` is symmetric — patches `tools[serverSlug][toolName]`.

`clear(sessionId)` deletes the row outright. The session
store's `deleteSession` runs `mcpToggles.delete` inside its
own transaction; this `clear` exists for callers that want
to reset toggles without dropping the session.

## Barrel — `runtime/storage-dexie/index.ts`

```ts
export {
    DEFAULT_SESSION_DB_NAME,
    SessionStoreDb,
    openSessionDb,
    type OpenSessionDbOptions,
} from './db';
export { createSessionStore, createStoreFromDb } from './session-store';
export { createFeatureStore } from './feature-store';
export { createMcpToggleStore } from './mcp-toggle-store';
```

Consumed by:

- `packages/web-acp/src/agent/agent-worker.ts` (boot shim) —
  constructs all three stores once per worker boot via
  `createStoreFromDb(openSessionDb())` (the
  `createSessionStore` factory exists for callers that want
  to pass `options`; the worker uses the lower-level pair
  directly so the shim has no `dbName` knob to thread).
- Test utilities — the `runtime/storage-dexie/agent-adapter.test.ts`
  drives the agent's adapter against a fresh Dexie database
  per test.

## Test fixtures

Tests use `fake-indexeddb/auto` so the Dexie database runs in
an in-memory IndexedDB shim. The shim is **imported per-test**
at the top of each `*.test.ts` file (`agent-adapter.test.ts`,
`feature-store.test.ts`, `mcp-toggle-store.test.ts`,
`session-store.test.ts`) — it is **not** declared globally in
`vite.config.ts`'s `test.setupFiles` (`./src/test/setup.ts`
intentionally does not import it). Each test should construct
a fresh DB with a unique name (e.g. `new
SessionStoreDb('web-acp-test-' + crypto.randomUUID())`) to
avoid bleed-through between tests.

The test files in this folder cover:

- `session-store.test.ts` — interface contract (createSession,
  recordNotification, recordTurn, recordBuiltin, list /
  read / get / setTitle / deleteSession).
- `feature-store.test.ts` — defaults merge, override
  persistence, unknown-key rejection.
- `mcp-toggle-store.test.ts` — server vs tool override
  patching, clear semantics.
- `agent-adapter.test.ts` — integration test that wires the
  agent's adapter against a Dexie store and exercises the
  ACP wire path (the canonical end-to-end at the host
  boundary).

## Cross-references

- Agent-side interface contracts:
  [`../web-acp-agent/sessions.md`](../web-acp-agent/sessions.md),
  [`../web-acp-agent/features.md`](../web-acp-agent/features.md),
  [`../web-acp-agent/mcp.md`](../web-acp-agent/mcp.md).
- Worker boot that instantiates the stores:
  [`transport.md`](./transport.md).
- Hook surface for features + MCP toggles:
  [`hooks.md`](./hooks.md),
  [`features.md`](./features.md),
  [`mcp.md`](./mcp.md).
