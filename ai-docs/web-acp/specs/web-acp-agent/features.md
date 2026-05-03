# Features — `FeatureStore` interface + ACP wire surface

**Source of truth (agent package):** `packages/web-acp-agent/src/storage/feature-store.ts`,
`packages/web-acp-agent/src/acp/engine/ext-methods/features-{list,set}.ts`.

## Purpose

Per-session boolean feature toggles, managed by the host but
read by the agent before each turn. Two flags ship today:

- `bashEnabled` — gates the bash tool registration in
  `prompt-driver.ts:run` (`:128`). Default `true`.
- `forceToolCall` — DEV-only; when on, the driver pushes
  `toolChoice: 'required'` into the per-turn stream override
  (`:141`) so the LLM is forced to emit a tool call on the
  first request of the turn. Default `false`. Used by e2e
  tests to drive deterministic tool-call paths.

The agent ships only the **interface**; host runtimes provide
the concrete implementation:

- Browser host:
  `packages/web-acp/src/runtime/storage-dexie/feature-store.ts:createFeatureStore`
  (Dexie `features` table; see [`../web-acp-client/storage-dexie.md`](../web-acp-client/storage-dexie.md)).
- CLI host:
  `packages/cli-acp-client/src/services/stores.ts` (in-memory
  `Map<sessionId, FeatureSnapshot>`).

## `FeatureStore` interface — `storage/feature-store.ts:35`

```ts
interface FeatureStore {
    get(sessionId: string): Promise<FeatureSnapshot>;
    set(sessionId: string, key: string, value: boolean): Promise<FeatureSnapshot>;
    clear(sessionId: string): Promise<void>;
}
```

| Method | Caller | Behaviour |
| --- | --- | --- |
| `get(sessionId)` | `acp/engine/session-runtime.ts:readFeatures` (`:109`) — driver reads it via the `BuiltinHandlerCtx` and the per-turn `featureSnapshot`. | Returns the stored bag merged on top of `FEATURE_DEFAULTS`. Newly-introduced flags surface immediately (no migration). |
| `set(sessionId, key, value)` | `_bodhi/features/set` handler — `acp/engine/ext-methods/features-set.ts:featuresSet`. | Writes the override; returns the updated snapshot. Only writes the override (not the whole row) so the default surface stays observable via deletion. |
| `clear(sessionId)` | Reserved for session deletion paths; the host may run this from `deleteSession` if it doesn't share a transaction with `SessionStore.deleteSession`. The browser host doesn't call this directly — Dexie handles cleanup transactionally inside `deleteSession`. |

## Defaults — `storage/feature-store.ts:15` (interface) + `:20` (value object)

```ts
interface FeatureDefaults {
    bashEnabled: boolean;     // true
    forceToolCall: boolean;   // false
}
const FEATURE_DEFAULTS: FeatureDefaults = {
    bashEnabled: true,
    forceToolCall: false,
};
```

`FeatureKey = keyof FeatureDefaults` — the type-narrow
"known" key list.

`isFeatureKey(key)` (`:27`) — `key in FEATURE_DEFAULTS`. The
agent uses this in `_bodhi/features/set` to reject unknown
keys (`'unknown feature ...'`) so a typo can't silently
poison persistence.

`FeatureSnapshot` (`:31`) extends `FeatureDefaults` with an
open `[key: string]: boolean` index signature — the
implementation is allowed to surface flags the agent doesn't
know about yet (forward-compat). The driver only reads the
known keys.

## ACP wire surface

Both extension methods are dispatched via
`acp/engine/ext-methods/index.ts:dispatchExtMethod`. Constants:

- `BODHI_FEATURES_LIST_METHOD = '_bodhi/features/list'`
- `BODHI_FEATURES_SET_METHOD = '_bodhi/features/set'`

### `_bodhi/features/list` — `ext-methods/features-list.ts:featuresList`

```ts
// Request
{ sessionId: string }
// Response
{ features: FeatureBag, defaults: FeatureBag }
```

Validates `sessionId: string`; calls `host.readFeatures(sessionId)`
(which falls back to `FEATURE_DEFAULTS` when no store is
configured); returns the snapshot + the defaults so the host
can render which keys are at default vs explicitly overridden.

### `_bodhi/features/set` — `ext-methods/features-set.ts:featuresSet`

```ts
// Request
{ sessionId: string, key: string, value: boolean }
// Response
{ features: FeatureBag }
```

Validates the param shape; rejects unknown keys via
`isFeatureKey`; rejects `forceToolCall` when `!host.isDev`
(throws with JSON-RPC `code: -32004` so the host can render a
friendly error); persists via `host.features.set`; returns
the updated bag.

The DEV gate matters: `forceToolCall` is observable in the
agent only when `AcpAgentAdapterOptions.isDev === true`
(see [`acp.md`](./acp.md)). The host bridges its own
build-mode flag (`import.meta.env.DEV` for Vite, custom
flag for Node) into the adapter's options; the agent
enforces from there.

## Per-turn read

`prompt-driver.ts:run` calls
`runtime.readFeatures(sessionId)` once per turn (line 122).
The snapshot drives:

- `featureSnapshot.bashEnabled` → bash tool registration.
- `featureSnapshot.forceToolCall && isDev && tools.length > 0`
  → `streamOverrides.current = { toolChoice: 'required' }`.

## Storage row shape (host-implementable)

`FeatureRow` is defined in `storage/session-store.ts:91` so
the browser host's Dexie schema can declare a `features`
table row that mirrors the agent's contract:

```ts
interface FeatureRow {
    sessionId: string;
    flags: Record<string, boolean>;
    updatedAt: number;
}
```

The host's `createFeatureStore(db)` reads `flags` from this
row, merges with `FEATURE_DEFAULTS`, and writes back the
patched bag on `set`. CLI host stores in-memory; SQLite
swap-in is a future follow-up.

## Cross-references

- Engine read-site:
  [`acp.md`](./acp.md) (PromptTurnDriver run).
- Host-side hook + UI:
  [`../web-acp-client/features.md`](../web-acp-client/features.md)
  (`useAcpFeatures`, `FeaturePanel`).
- Persistence row shape lives alongside sessions:
  [`sessions.md`](./sessions.md).
- DEV-mode discipline (`isDev` in
  `AcpAgentAdapterOptions`):
  [`acp.md`](./acp.md) § wire shim.
