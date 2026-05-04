# Features — `setSessionConfigOption` + `FeatureStore`

**Source of truth (agent package):**
`packages/web-acp-agent/src/storage/feature-store.ts`,
`packages/web-acp-agent/src/acp/feature-config.ts`,
`packages/web-acp-agent/src/acp/handlers/session-crud.ts:handleSetSessionConfigOption`,
`packages/web-acp-agent/src/wire/index.ts`.

## Purpose

Per-session boolean feature toggles, managed by the host but
read by the agent before each turn. Two flags ship today:

- `bashEnabled` — gates the bash tool registration in
  `acp/engine/prompt-driver.ts:#runTurn`. Default `true`.
- `forceToolCall` — DEV-only; when on, the driver pushes
  `toolChoice: 'required'` into the per-turn stream override
  (consumed once by `agent/stream-fn.ts`) so the LLM is forced
  to emit a tool call on the first request of the turn.
  Default `false`. Used by e2e tests to drive deterministic
  tool-call paths.

Wire surface rides standard ACP:

- **Initial state** — agent emits
  `SessionConfigOption[]` on `NewSessionResponse.configOptions`
  and `LoadSessionResponse.configOptions`.
- **Mutation** — host calls
  `Agent.setSessionConfigOption({ sessionId, configId, type:
  'select', value: 'on' | 'off' })`. Response carries the
  freshly-rebuilt `configOptions[]`; the agent additionally
  fires a `config_option_update` SessionUpdate so any other
  observer of the same session reconciles.
- **Categorisation** — every Bodhi-owned option carries
  `category: '_bodhi/feature'` so the host UI can route them
  into the dedicated panel without keying off ID prefixes.

The agent ships only the **interface** for persistence; host
runtimes provide the concrete implementation:

- Browser host:
  `packages/web-acp/src/runtime/storage-dexie/feature-store.ts:createFeatureStore`
  (Dexie `features` table; see
  [`../web-acp-client/storage-dexie.md`](../web-acp-client/storage-dexie.md)).
- CLI host:
  `packages/cli-acp-client/src/services/stores.ts` (in-memory
  `Map<sessionId, FeatureSnapshot>`).

## Wire constants — `wire/index.ts`

| Constant | Value | Line |
| --- | --- | --- |
| `BODHI_FEATURE_BASH_ENABLED_CONFIG_ID` | `'_bodhi/features/bashEnabled'` | `:207` |
| `BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID` | `'_bodhi/features/forceToolCall'` | `:208` |
| `BODHI_FEATURE_CONFIG_CATEGORY` | `'_bodhi/feature'` | `:209` |

The host imports these from
`@bodhiapp/web-acp-agent` (re-exported from the package
barrel) so it never inlines the string IDs.

## Feature config registry — `acp/feature-config.ts`

`acp/feature-config.ts:FEATURE_CONFIG_ENTRIES` (`:20`) is the
single source of truth that maps each `_bodhi/features/*`
config ID to:

- the internal `FeatureKey` (`bashEnabled` | `forceToolCall`),
- the human-readable `name` + `description` shipped to the
  host on `SessionConfigOption.{name, description}`,
- an optional `devOnly: true` flag (forceToolCall) that filters
  the entry out of the wire surface when
  `AcpAgentAdapterOptions.isDev !== true`.

```ts
// feature-config.ts:20–35
export const FEATURE_CONFIG_ENTRIES: readonly FeatureConfigEntry[] = [
    {
        configId: BODHI_FEATURE_BASH_ENABLED_CONFIG_ID,
        featureKey: 'bashEnabled',
        name: 'Bash tool',
        description: 'Register the bash shell tool with the LLM.',
    },
    {
        configId: BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID,
        featureKey: 'forceToolCall',
        name: 'Force tool call (DEV)',
        description:
            'Pass tool_choice=required to pi-ai so a benign prompt deterministically triggers a tool call.',
        devOnly: true,
    },
];
```

Two helpers fall out of the registry:

- `configIdToFeatureKey(configId)` (`:41`) — reverse lookup
  used by `handleSetSessionConfigOption` to validate inbound
  IDs and translate them to the persistence key. Returns
  `null` for unknown IDs (handler maps that to a thrown
  `'unknown configId …'` error).
- `buildFeatureConfigOptions(snapshot, isDev)` (`:50`) —
  builds the `SessionConfigOption[]` shipped on
  `NewSessionResponse.configOptions`,
  `LoadSessionResponse.configOptions`, the
  `setSessionConfigOption` response, and the
  `config_option_update` SessionUpdate. Filters
  `devOnly` entries when `!isDev`. Always emits `type:
  'select'` with the two-option enum `[{ value: 'on', name:
  'On' }, { value: 'off', name: 'Off' }]` (the
  `ON_OFF_SELECT_OPTIONS` constant `:45`); `currentValue` is
  `snapshot[featureKey] ? 'on' : 'off'`. The boolean wire
  type used to ship in earlier drafts but the picker UX was
  better expressed as an explicit two-option select; the
  handler still accepts a legacy boolean `value` for older
  clients (see below).

## Handler — `acp/handlers/session-crud.ts:handleSetSessionConfigOption`

`handleSetSessionConfigOption(ctx, params)` (`:191`) is the
delegated handler for the standard ACP
`Agent.setSessionConfigOption` method. Wire shape (from
`@agentclientprotocol/sdk`):

```ts
SetSessionConfigOptionRequest = {
    sessionId: string;
    configId: string;
    value: boolean | string | number;
};
```

Behaviour (lines `:194–224`):

1. `configIdToFeatureKey(configId)` — throws `'unknown
   configId …'` (JSON-RPC `-32603`) on miss.
2. **DEV gate.** When `featureKey === 'forceToolCall' &&
   !ctx.isDev` → throws `'forceToolCall is DEV-only'` with
   JSON-RPC `code: -32004`. The host renders the friendly
   error inline; the gate never short-circuits at the
   transport layer.
3. **Store availability.** When `!ctx.services.features` →
   throws `'feature store unavailable'`.
4. **Value coercion.** Accepts the stable `'on'` / `'off'`
   string schema OR a legacy boolean (older clients). Anything
   else throws `'configId … value must be 'on' | 'off' (or
   legacy boolean)'`.
5. Persists via `ctx.services.features.set(sessionId,
   featureKey, nextBool)` — returns the updated
   `FeatureSnapshot`.
6. Builds `SessionConfigOption[]` via
   `buildFeatureConfigOptions(next, ctx.isDev)`.
7. Fires `runtime.emitConfigOptionUpdate(sessionId, options)` —
   transient (not persisted; feature state is rebuilt from
   the persisted feature row on every `loadSession`).
8. Returns `{ configOptions: options }` so the SDK request
   resolves with the freshly-rebuilt list.

## `FeatureStore` interface — `storage/feature-store.ts:35`

```ts
// feature-store.ts:35–39
interface FeatureStore {
    get(sessionId: string): Promise<FeatureSnapshot>;
    set(sessionId: string, key: string, value: boolean): Promise<FeatureSnapshot>;
    clear(sessionId: string): Promise<void>;
}
```

| Method | Caller | Behaviour |
| --- | --- | --- |
| `get(sessionId)` | `acp/engine/session-runtime.ts:readFeatures` (`:131`); also called by `handleNewSession` (`:58`) and `handleLoadSession` (`:124`) before building `configOptions`. | Returns the stored bag merged on top of `FEATURE_DEFAULTS`. Newly-introduced flags surface immediately (no migration). When the store throws, `readFeatures` logs and falls back to `{ ...FEATURE_DEFAULTS }`. |
| `set(sessionId, key, value)` | `handleSetSessionConfigOption` (`:221`). | Writes the override; returns the updated snapshot. Only writes the override (not the whole row) so the default surface stays observable via deletion. |
| `clear(sessionId)` | Reserved for session-deletion paths; the host may run this from `deleteSession` if it doesn't share a transaction with `SessionStore.deleteSession`. The browser host doesn't call this directly — Dexie handles cleanup transactionally inside `deleteSession`. |

## Defaults — `storage/feature-store.ts:15` (interface), `:20` (value)

```ts
// feature-store.ts:15–23
interface FeatureDefaults {
    bashEnabled: boolean;     // true
    forceToolCall: boolean;   // false
}
const FEATURE_DEFAULTS: FeatureDefaults = {
    bashEnabled: true,
    forceToolCall: false,
};
```

`FeatureKey = keyof FeatureDefaults` (`:25`) is the type-narrow
"known" key list. `isFeatureKey(key)` (`:27`) — `key in
FEATURE_DEFAULTS` — is no longer called from a wire entry point
(the wire validates by `configId` instead) but stays exported
for callers that need to validate raw key strings.

`FeatureSnapshot` (`:31`) extends `FeatureDefaults` with an
open `[key: string]: boolean` index signature — the
implementation is allowed to surface flags the agent doesn't
know about yet (forward-compat). The driver only reads the
known keys.

## Per-turn read

`prompt-driver.ts:#runTurn` calls
`runtime.readFeatures(sessionId)` once per turn. The snapshot
drives:

- `featureSnapshot.bashEnabled` → bash tool registration
  (gated additionally on `services.registry` present and
  `registry.list().length > 0` — no point registering bash
  with no volumes mounted).
- `featureSnapshot.forceToolCall && isDev && tools.length > 0`
  → `streamOverrides.current = { toolChoice: 'required' }`
  before `inline.prompt(text)`.

## Storage row shape (host-implementable)

`FeatureRow` is defined in `storage/session-store.ts:86` so
the browser host's Dexie schema can declare a `features`
table row that mirrors the agent's contract:

```ts
// session-store.ts:86–90
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
  [`acp.md`](./acp.md) (PromptTurnDriver `#runTurn`).
- Host-side hook + UI:
  [`../web-acp-client/features.md`](../web-acp-client/features.md)
  (`useAcp` features slice, `FeaturePanel`).
- Persistence row shape lives alongside sessions:
  [`sessions.md`](./sessions.md).
- DEV-mode discipline (`isDev` in
  `AcpAgentAdapterOptions`): [`acp.md`](./acp.md) § wire shim.
