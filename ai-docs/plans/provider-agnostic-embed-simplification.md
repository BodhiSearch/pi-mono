# Provider-agnostic embed surface — followup simplifications

## Context

The previous "adaptive plum" plan
([`some-thoughts-on-the-adaptive-plum.md`](./some-thoughts-on-the-adaptive-plum.md))
collapsed the embed ritual to one verb: `startAgent({ transport,
provider, ... })`. Working through the result revealed five more
asymmetries that, taken together, would push the agent from
"mostly host-neutral" to "actually host-neutral and
provider-neutral". This plan implements all five as one
coordinated change.

What's wrong today, after "adaptive plum":

- **`provider: BodhiProvider`** — the public boot signature names
  a concrete class. The engine reaches for two Bodhi-specific
  methods (`fetchServerInfo`, `getBaseUrl`) so the type can't
  just be widened to `LlmProvider` without surface changes.
- **`registry: VolumeRegistry`** — a *data structure*, not an
  environment seam. The host has no business constructing it.
  `VolumeRegistry.firstMountName()` leaks an internal
  bash-tool-default into the public surface.
- **`SessionStore`, `FeatureStore`, `McpToggleStore`** — three
  store interfaces for what is fundamentally one concept
  ("per-session keyed preferences"). Sessions stays separate
  (it owns transcript storage, not preferences); feature
  toggles + MCP toggles unify behind one `PreferenceStore`.
- **`isDev: boolean`** — a "production safety gate" for the
  `forceToolCall` feature flag. Worst-case if a user enables
  it is a weird LLM response, not a security issue. The host
  controls UI exposure; the agent shouldn't double-gate.
- **`_bodhi/server/info` extension method** — a Bodhi-specific
  passthrough to `GET /bodhi/v1/info`. The data it returns is
  exactly what we'd want to learn at the moment credentials
  land. Folding the probe into `setAuthToken`'s return value
  drops the extension method, the dedicated facade method, and
  one round-trip on boot.

The ACP wire surface is unchanged for the standard methods.
Two extensions disappear (`_bodhi/server/info`,
`_bodhi/features/*` — the latter already removed in M3 of
the ACP-0.21 migration; only `setSessionConfigOption` remains).
One extension (`_bodhi/mcp/toggles/set`) keeps its wire shape
but reads/writes through the new `PreferenceStore` internally.

The two in-scope hosts — `packages/web-acp/`,
`packages/tutorial-cli-client/` — get migrated in lock-step
and gated by their existing e2e suites. `packages/ws-acp-client/`
and `packages/cli-acp-client/` are out of scope and will need
a separate migration.

## Goals

1. **`provider: LlmProvider`** at the boot signature. `BodhiProvider`
   becomes one impl among many; the agent doesn't reach for any
   provider-specific methods directly.
2. **`volumes: VolumeInit[]`** at boot instead of
   `registry: VolumeRegistry`. Agent owns the registry
   internally. Runtime mount/unmount via `StartAgentHandle.mount`
   / `unmount`. `firstMountName` becomes internal.
3. **`PreferenceStore`** unifies `FeatureStore` + `McpToggleStore`.
   One interface, one in-memory default, one Dexie/SQLite table
   per host. Internal typed accessors handle the known keys.
4. **`isDev` deleted everywhere.** `forceToolCall` accepted
   unconditionally via `setSessionConfigOption`. Hosts decide
   UI exposure.
5. **`setAuthToken` returns provider info.** Wire surface puts
   it in `AuthenticateResponse._meta.bodhi.providerInfo`.
   `_bodhi/server/info` extension method, `BODHI_SERVER_INFO_METHOD`
   constant, and `BodhiServerInfoResponse` exported type all
   reshuffle: the value type stays public, the wire constant
   and ext-method file are deleted.
6. **All in-scope e2e suites pass with zero test-code changes.**

## The new public surface

`packages/web-acp-agent/src/index.ts` after this change:

```ts
// boot — the only verb hosts call
export { startAgent, createInMemoryDuplex } from './api';
export type {
  AcpTransport,
  InMemoryDuplex,
  StartAgentHandle,
  StartAgentOptions,
} from './api';

// LLM provider — interface + default impl
export {
  apiFormatOfModel,
  BODHI_PROVIDER_TAG,
  BodhiProvider,
  type LlmAuthCredential,
  type LlmProvider,
} from './agent/bodhi-provider';

// Volumes — host wires FS backends inward via VolumeInit
export type { VolumeInit } from './agent/volume-registry';
//   `VolumeRegistry`, `VolumeRegistryListener`, `VolumeSnapshot`,
//   `ZenfsVolumeRegistry` — all dropped from public surface
//   (internal to the agent now).

// Commands surface that host UIs may surface
export {
  COMMANDS_DIR_RELPATH,
  type CommandDef,
  type CommandSource,
  canonicalCommandName,
  type FrontMatter,
  PROMPTS_DIR_RELPATH,
} from './agent/commands';
export { builtinAvailableCommands, isBuiltinName } from './agent/commands/builtins';

// Storage interfaces — host implements when it wants persistence
export type { SessionEntry, SessionEntryKind, SessionRow,
  SessionSummary, TurnPayload, BuiltinPayload, SessionStore,
} from './storage/session-store';
export { deriveTitle } from './storage/session-store';
//   FeatureRow + McpTogglesRow — dropped (subsumed by PreferenceStore)
export type { PreferenceStore } from './storage/preference-store';
//   FeatureStore + McpToggleStore — dropped (subsumed)
//   Keep FEATURE_DEFAULTS + isFeatureKey as utility consts;
//   keep EMPTY_MCP_TOGGLES + isServerEnabled + isToolEnabled
//   helpers (consumed by host MCP UI for toggle-state queries).
export type { FeatureKey, FeatureSnapshot, FeatureDefaults } from './storage/feature-defaults';
export { FEATURE_DEFAULTS, isFeatureKey } from './storage/feature-defaults';
export type { McpToggleSnapshot } from './storage/mcp-toggle-shape';
export { EMPTY_MCP_TOGGLES, isServerEnabled, isToolEnabled } from './storage/mcp-toggle-shape';

export { canonicalizeMcpUrl, deriveSlugFromUrl } from './mcp/url-canonical';

// `_bodhi/*` wire constants — `BODHI_SERVER_INFO_METHOD` removed
export {
  BODHI_AUTH_METHOD_ID,
  BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
  BODHI_FEATURE_BASH_ENABLED_CONFIG_ID,
  BODHI_FEATURE_CONFIG_CATEGORY,
  BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID,
  BODHI_GET_SESSION_METHOD,
  BODHI_GET_SESSION_METHOD_LEGACY,
  BODHI_MCP_STATE_NOTIFICATION_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
} from './wire';
export type { /* ... + new BodhiAuthenticateResponseMeta, retain BodhiServerInfoResponse ... */ } from './wire';
```

### `startAgent` signature

```ts
export interface StartAgentOptions {
  transport: AcpTransport;
  provider: LlmProvider;
  volumes?: VolumeInit[];
  sessions?: SessionStore;
  preferences?: PreferenceStore;
  buildVersion?: string;
}

export interface StartAgentHandle {
  dispose(): Promise<void>;
  mount(init: VolumeInit): Promise<void>;
  unmount(mountName: string): Promise<void>;
}
```

Six fields, four optional. Two host-side interfaces (`SessionStore`,
`PreferenceStore`) — both default to internal in-memory impls
when omitted. `isDev` gone.

### `LlmProvider` change

```ts
export interface LlmProvider {
  getApiKeyAndHeaders(model): Promise<{ apiKey: string; headers?: Record<string, string> }>;
  getAvailableModels(): Promise<Model<Api>[]>;
  setAuthToken?(credential: LlmAuthCredential | null): Promise<unknown>;
  // `getBaseUrl?` removed — engine no longer reaches for it.
  // `fetchServerInfo` not added; setAuthToken's return value
  //   carries that data instead.
}
```

`setAuthToken` switches from `void` → `Promise<unknown>`. Three
contractual rules:

- On a valid credential, the provider may return any
  JSON-serialisable value carrying connectivity / capability
  metadata. The agent puts it verbatim under
  `AuthenticateResponse._meta.bodhi.providerInfo`.
- Returning `undefined` → agent omits `_meta.bodhi.providerInfo`.
- Throwing → propagates as the `authenticate` JSON-RPC error.
  Providers should throw on auth-fundamentally-invalid (401, 403)
  and return-with-error-shape for transient connectivity issues.

`BodhiProvider.setAuthToken` becomes:

```ts
async setAuthToken(credential: LlmAuthCredential | null): Promise<BodhiServerInfoResponse | undefined> {
  if (!credential) {
    this.token = null;
    this.baseUrl = undefined;
    return undefined;
  }
  this.token = credential.token;
  this.baseUrl = credential.baseUrl;
  return this.fetchServerInfo();  // throws on 401/403/network
}
```

`BodhiProvider.fetchServerInfo()` and `BodhiProvider.getBaseUrl()`
stay as public methods on the class — host code can still call
them directly outside the auth flow if needed; the *engine* just
doesn't.

### Wire shape — `AuthenticateResponse._meta`

```ts
// Wire-level shape exported from `wire/index.ts`
export interface BodhiAuthenticateResponseMeta {
  bodhi?: {
    providerInfo?: unknown;       // setAuthToken's return value, opaque
  };
}
```

`BodhiServerInfoResponse` stays exported (host casts the opaque
value to it). `BODHI_SERVER_INFO_METHOD` constant deleted —
no more `_bodhi/server/info` extension method.

### `PreferenceStore`

```ts
export interface PreferenceStore {
  get(sessionId: string, key: string): Promise<unknown>;
  set(sessionId: string, key: string, value: unknown): Promise<void>;
  delete(sessionId: string, key: string): Promise<void>;
  list(sessionId: string): Promise<Record<string, unknown>>;
  clearSession(sessionId: string): Promise<void>;
}
```

Internal typed wrappers in the agent live alongside
`feature-defaults.ts` and `mcp-toggle-shape.ts`:

```ts
// agent/internal/feature-prefs.ts (not exported)
export async function readFeature(prefs, sid, key: FeatureKey): Promise<boolean> {
  const v = await prefs.get(sid, `feature:${key}`);
  return typeof v === 'boolean' ? v : FEATURE_DEFAULTS[key];
}
export async function writeFeature(prefs, sid, key: FeatureKey, value: boolean): Promise<FeatureSnapshot> {
  await prefs.set(sid, `feature:${key}`, value);
  return readAllFeatures(prefs, sid);
}

// agent/internal/mcp-toggle-prefs.ts (not exported)
export async function readMcpToggles(prefs, sid): Promise<McpToggleSnapshot> {
  const v = await prefs.get(sid, 'mcp:toggles');
  return isMcpToggleSnapshot(v) ? v : { servers: {}, tools: {} };
}
export async function writeMcpToggles(prefs, sid, next: McpToggleSnapshot): Promise<McpToggleSnapshot> {
  await prefs.set(sid, 'mcp:toggles', next);
  return next;
}
```

Key namespace convention: `feature:<key>`, `mcp:toggles`, room
for future `theme:default`, `model:lastUsed`, etc. Keys are
strings; values are JSON-serialisable.

### `isDev` deletion

- `StartAgentOptions.isDev` removed.
- `AcpAgentAdapterOptions.isDev` removed.
- `AcpAdapterContext.isDev` removed.
- `feature-config.ts:buildFeatureConfigOptions` no longer
  filters by `devOnly`. `DEV_ONLY` marker dropped.
- `handlers/session-crud.ts:handleSetSessionConfigOption`
  removes the `forceToolCall && !isDev` guard. Always accepts.
- `handlers/session-crud.ts:handleNewSession` /
  `handleLoadSession` no longer pass `isDev` to
  `buildFeatureConfigOptions`.

### `/info` builtin — server URL source

`builtin-dispatch.ts:45` currently does
`serverUrl: services.bodhi.getBaseUrl?.() ?? null`. After typing
as `LlmProvider`, `getBaseUrl` isn't available. Fix: cache the
last `setAuthToken` return value on the services context
(or session runtime) at authenticate-time; `/info` reads
`(cached as BodhiServerInfoResponse)?.url ?? null`. Same value,
sourced from the same call but cached after the wire response.

The cache is opaque (`unknown`) at the agent level; only the
`/info` builtin formatter does the cast — and only for the
Bodhi-flavored agent. Future non-Bodhi providers' `/info`
output simply omits the URL field.

## Host migrations

### Web-acp (`packages/web-acp/src/`)

| Path | Change |
| --- | --- |
| `agent/agent-worker.ts` | Replace `registry: new ZenfsVolumeRegistry()` + `attachVolumeChannel(scope, registry)` + `mountAll(...)` with `volumes: VolumeInit[]` constructed from `hostVolumes.map(toAgentVolumeInit)`. Keep the postMessage sidechannel listener for runtime mount/unmount, but bridge it to `handle.mount`/`unmount` instead of `registry.mount`/`unmount`. Drop `isDev` line. |
| `runtime/volumes-fsa/volume-channel.ts` | Retarget the bridge: instead of `attachVolumeChannel(scope, registry)` accepting a registry, now `attachMountControl(scope, handle)` accepting a `StartAgentHandle`. Same wire shape, target changes. (Could keep the existing function name and just swap the second arg's type to satisfy the new API.) |
| `runtime/storage-dexie/db.ts` | Schema bump v3 → v4. New `preferences` table (`sessionId+key` compound key, `value` blob). Drop `features` and `mcpToggles` tables. **Migration: drop on upgrade** — existing per-session toggles reset to defaults on first load post-upgrade. Acceptable for a dev package with no production users; document in the CHANGELOG. |
| `runtime/storage-dexie/preference-store.ts` | **New.** `createPreferenceStore(db): PreferenceStore`. Replaces both `createFeatureStore` and `createMcpToggleStore`. |
| `runtime/storage-dexie/feature-store.ts` | **Delete.** |
| `runtime/storage-dexie/mcp-toggle-store.ts` | **Delete.** |
| `runtime/storage-dexie/index.ts` | Drop the deleted exports; add `createPreferenceStore`. |
| `runtime/storage-dexie/agent-adapter.test.ts` | Update store wiring — single `preferences` instead of `features` + `mcpToggles`. |
| Various host-side reads | Update spots that consumed `BODHI_SERVER_INFO_METHOD` / `BodhiServerInfoResponse` from a separate extMethod call. (Per the prior plan check: web-acp doesn't currently surface server info anywhere; the old method was wired but unused. Confirm via grep; delete if dead.) |

### Tutorial-cli-client (`packages/tutorial-cli-client/src/`)

| Path | Change |
| --- | --- |
| `agent/embed.ts` | Drop the `serverInfo()` facade method. `authenticate()` now returns the `AuthenticateResponse`; the host casts `resp._meta?.bodhi?.providerInfo as BodhiServerInfoResponse \| undefined` and stores/returns it however the bootstrap code wants. Remove the `BODHI_SERVER_INFO_METHOD` import. |
| `bootstrap.ts` | The "BodhiApp ack" emit moves from the `agent.serverInfo()` call to reading `authResp._meta.bodhi.providerInfo`. One round-trip dropped. |
| `dispatcher.ts` | The `/bodhiapp:status` REPL command currently calls `agent.serverInfo()`. Either re-issue an authenticate (refresh probe — clean), or have the host cache the last auth probe and re-display. Simplest: make `/bodhiapp:status` re-authenticate; that's also a useful "still alive?" probe. |

The CLI's `EmbeddedAgent` facade shrinks from
`{ initialize, authenticate, serverInfo, close }` →
`{ initialize, authenticate, close }`. `authenticate` now
returns the `InitializeResponse`-equivalent metadata as part
of its return value.

## Agent-package internal changes

| Path | Change |
| --- | --- |
| `api/types.ts` | New options shape per § "startAgent signature". Drop `isDev`, `registry`, `features`, `mcpToggles`; add `volumes`, `preferences`. New handle exposes `mount`/`unmount`. |
| `api/start-agent.ts` | Internal: build the registry from `options.volumes ?? []`; default `preferences` to `createInMemoryPreferenceStore()`. Wire `handle.mount`/`unmount` through to the internal registry. Drop `isDev` threading. |
| `acp/agent-adapter.ts` | Remove `isDev` from constructor options. Adapter context loses the field. `handleSetSessionConfigOption` stops needing it. |
| `acp/handlers/initialize.ts` | `handleAuthenticate` becomes:<br/>```ts<br/>let providerInfo: unknown;<br/>try {<br/>  providerInfo = await ctx.services.bodhi.setAuthToken?.({ ... });<br/>} catch (err) { throw err; }<br/>// Cache the value on the services context for /info builtin to read.<br/>ctx.services.lastProviderInfo = providerInfo;<br/>return providerInfo !== undefined ? { _meta: { bodhi: { providerInfo } } } : {};<br/>``` |
| `acp/handlers/session-crud.ts` | `handleSetSessionConfigOption` drops the `forceToolCall && !isDev` guard. `handleNewSession`/`handleLoadSession` drop the `isDev` arg to `buildFeatureConfigOptions`. |
| `acp/feature-config.ts` | Drop `entry.devOnly` filtering. Signature becomes `buildFeatureConfigOptions(snapshot)` (one arg). |
| `acp/engine/services.ts` | `AcpAdapterServices` field renames: `features?` + `mcpToggles?` → unified `preferences: PreferenceStore`. `bodhi: BodhiProvider` → `provider: LlmProvider`. Add `lastProviderInfo: unknown` slot. The `assembleServices` function adapts. |
| `acp/engine/builtin-dispatch.ts` | `/info` builtin reads server URL from `services.lastProviderInfo` cast to `BodhiServerInfoResponse`. Same for any other field that used `services.bodhi.getBaseUrl?.()`. |
| `acp/engine/ext-methods/server-info.ts` | **Delete.** |
| `acp/engine/ext-methods/index.ts` | Remove `BODHI_SERVER_INFO_METHOD` from the handler map. |
| `acp/engine/ext-methods/mcp-toggles-set.ts` | Read/write through `prefs` instead of the separate `mcpToggles` store. Internal helpers from `agent/internal/mcp-toggle-prefs.ts`. |
| `acp/engine/ext-methods/get-session.ts` | Read MCP toggles from `prefs` instead of `mcpToggles` store. |
| `acp/engine/session-runtime.ts` | Read features + MCP toggles via internal `feature-prefs`/`mcp-toggle-prefs` helpers. |
| `agent/bodhi-provider.ts` | `setAuthToken` returns `Promise<BodhiServerInfoResponse \| undefined>`. Implementation calls `fetchServerInfo` after storing credentials; returns the result. Throws on 401/403 (no change to error semantics — `fetchServerInfo` already throws). |
| `agent/volume-registry.ts` | Drop from public barrel: `VolumeRegistry`, `VolumeRegistryListener`, `VolumeSnapshot`, `ZenfsVolumeRegistry`. Keep `VolumeInit` exported. The class becomes internal — only `start-agent.ts` constructs it. |
| `storage/preference-store.ts` | **New.** The `PreferenceStore` interface. |
| `storage/feature-defaults.ts` | **New.** Hosts the `FeatureKey`, `FeatureSnapshot`, `FeatureDefaults`, `FEATURE_DEFAULTS`, `isFeatureKey` exports — used to be in `feature-store.ts`. |
| `storage/mcp-toggle-shape.ts` | **New.** Hosts `McpToggleSnapshot`, `EMPTY_MCP_TOGGLES`, `isServerEnabled`, `isToolEnabled` — used to be in `mcp-toggle-store.ts`. |
| `storage/feature-store.ts` | **Delete.** |
| `storage/mcp-toggle-store.ts` | **Delete.** |
| `storage/in-memory/preference-store.ts` | **New.** Single-Map default impl. |
| `storage/in-memory/feature-store.ts` | **Delete.** |
| `storage/in-memory/mcp-toggle-store.ts` | **Delete.** |
| `storage/in-memory/index.ts` | Drop deleted exports; add `createInMemoryPreferenceStore`. |
| `storage/session-store.ts` | Drop `FeatureRow`, `McpTogglesRow` exports — both subsumed by `PreferenceStore`. |
| `wire/index.ts` | Add `BodhiAuthenticateResponseMeta` type. Delete `BODHI_SERVER_INFO_METHOD` constant. Keep `BodhiServerInfoResponse` (it's the shape the host casts to). |
| `index.ts` | Reflect the new public surface above. Drop dropped exports. |
| `test-utils/index.ts` | `assembleServices` signature changed; update the type re-exports. |

## What we're explicitly NOT changing

- The `LlmAuthCredential` shape (`{ provider, baseUrl?, token }`).
  Still HTTP-shaped via `baseUrl` — out of scope until a non-HTTP
  provider arrives.
- The MCP toggle wire shape (`_bodhi/mcp/toggles/set` extension
  method). Storage moves to `PreferenceStore` but the wire stays.
- The session-store interface or transcript shape.
- The ACP engine layer (session-runtime, prompt-driver,
  builtin-dispatch).
- `packages/ws-acp-client/` and `packages/cli-acp-client/`. Out
  of scope — both will break and migrate separately.

## Documentation updates

| Path | Change |
| --- | --- |
| `ai-docs/web-acp/guide/04-embedding-the-agent.md` | Update §4.2 options table (drop `isDev`, replace `registry` with `volumes`, replace `features`+`mcpToggles` with `preferences`). Update §4.4 worker code sample. Add a §4.5 note: server connectivity info rides `AuthenticateResponse._meta.bodhi.providerInfo`; no separate facade method. |
| `ai-docs/web-acp/specs/web-acp-agent/index.md` | Update Public surface, Folder layout (new `storage/preference-store.ts`, new `storage/feature-defaults.ts` + `mcp-toggle-shape.ts`, dropped `feature-store.ts` + `mcp-toggle-store.ts` + `ext-methods/server-info.ts`). Update Hard constraints. Mark dropped exports. |
| `ai-docs/web-acp/specs/web-acp-agent/{features,mcp,sessions}.md` | Update store-interface references — `PreferenceStore` is the surface; `FeatureStore`/`McpToggleStore` are gone. |
| `ai-docs/web-acp/specs/web-acp-agent/agent.md` | Update `LlmProvider` interface description — `setAuthToken` returns `Promise<unknown>`; drop `getBaseUrl?` mention. |
| `ai-docs/web-acp/specs/web-acp-client/index.md` | Update worker-shim description, runtime adapters list, and folder layout (drop fs-handlers if any references survived; replace `feature-store` + `mcp-toggle-store` with `preference-store`). |
| `ai-docs/web-acp/specs/web-acp-client/storage-dexie.md` | Schema bump v3 → v4; new `preferences` table; migration policy (drop on upgrade). |
| `ai-docs/web-acp/specs/web-acp-client/features.md` | Update — `setSessionConfigOption('forceToolCall', 'on')` always succeeds. Drop the `isDev` gate language. |
| `ai-docs/web-acp/specs/web-acp-client/volumes.md` | Reflect that the host passes `volumes: VolumeInit[]` at boot; runtime mount/unmount goes through `StartAgentHandle`. |
| `ai-docs/web-acp/steering/02-architecture.md` | Update the layer-cake comment about `isDev`-gated `forceToolCall`. Note the agent-package surface is now provider-agnostic. |
| `ai-docs/web-acp/milestones/index.md` | Update the ACP-compliance table row for `_bodhi/server/info` (no longer exists; provider info rides `AuthenticateResponse._meta`). |

`packages/web-acp-agent/CHANGELOG.md` (if it exists) gets an
entry: "Breaking — embed surface refactor. See migration notes
in `ai-docs/plans/provider-agnostic-embed-simplification.md`."

## Verification

Both e2e suites are gate-checks. Tests are black-box; they MUST
pass without test-code changes.

1. **Agent package compiles + lints clean.**
   - `cd packages/web-acp-agent && npx tsgo --noEmit`
   - `cd packages/web-acp-agent && npm run check`
   - Vitest unit tests pass (some test-utils setup may need
     adjusting for the new services-bag shape — those are agent-
     internal tests, not e2e gates).

2. **Web-acp host: full e2e suite.**
   - `cd packages/web-acp && npm run check`
   - `cd packages/web-acp && npm test`
   - `cd packages/web-acp && npm run test:e2e`
   - Particular spots to watch:
     - `forceToolCall` toggle still works through
       `setSessionConfigOption`.
     - Volume mount/unmount UX still works (the postMessage
       bridge retarget shouldn't change behaviour).
     - First-load post-Dexie-bump: existing per-session
       toggles reset to defaults — the e2e setup doesn't
       persist between runs, so this isn't visible to tests,
       but worth confirming manually with `npm run dev`.

3. **CLI tutorial host: full e2e suite.**
   - `cd packages/tutorial-cli-client && npm run check`
   - `cd packages/tutorial-cli-client && npm test`
   - `cd packages/tutorial-cli-client && npm run test:e2e`
   - The `/bodhiapp:status` REPL flow now triggers a re-auth.
     The spec asserts via the REPL output text, so as long as
     the BodhiApp ack still emits with correct fields, the
     spec passes.

4. **Sanity grep** — confirm no in-scope code references the
   dropped surface:
   - `rg "BODHI_SERVER_INFO_METHOD\|services\.bodhi\b\|VolumeRegistry\|FeatureStore\|McpToggleStore\|isDev" packages/web-acp/src/ packages/tutorial-cli-client/src/`
     should return zero hits (excluding internal agent-package
     paths).

## Sequencing

Land in one branch, five commits:

1. **Agent package — internal refactor groundwork.** Add
   `storage/preference-store.ts`, `storage/feature-defaults.ts`,
   `storage/mcp-toggle-shape.ts`. Add `storage/in-memory/preference-store.ts`.
   Add internal helpers `agent/internal/feature-prefs.ts` and
   `agent/internal/mcp-toggle-prefs.ts`. Existing `FeatureStore` /
   `McpToggleStore` interfaces stay alongside (deprecation phase).
   Add new public-API types but don't yet remove old ones.
2. **Agent package — `setAuthToken` + `_meta` change.** Update
   `LlmProvider.setAuthToken` signature; update `BodhiProvider`
   impl; update `handleAuthenticate` to populate
   `_meta.bodhi.providerInfo`. Add `BodhiAuthenticateResponseMeta`
   wire type. Cache `lastProviderInfo` on services context.
   Update `/info` builtin to read from the cache. Delete
   `acp/engine/ext-methods/server-info.ts`. Delete
   `BODHI_SERVER_INFO_METHOD` constant.
3. **Agent package — drop `isDev` + `registry`-as-input.**
   Update `AcpAgentAdapter` constructor, `AcpAdapterContext`,
   `handleSetSessionConfigOption`, `handleNewSession`,
   `handleLoadSession`, `feature-config.ts`. Update `start-agent.ts`
   to take `volumes: VolumeInit[]` and own the registry
   internally. Add `mount`/`unmount` to `StartAgentHandle`.
4. **Hosts migrate.** Web-acp's `agent-worker.ts`, `volume-channel.ts`,
   Dexie store layer (schema bump + delete two stores +
   add preference store). Tutorial-cli-client's `embed.ts` +
   `bootstrap.ts` + `dispatcher.ts`. Run both e2e suites green.
5. **Agent package — finish the cleanup.** Delete
   `storage/feature-store.ts`, `storage/mcp-toggle-store.ts`,
   `storage/in-memory/{feature-store,mcp-toggle-store}.ts`.
   Drop `VolumeRegistry`, `ZenfsVolumeRegistry`,
   `VolumeRegistryListener`, `VolumeSnapshot`, `FeatureStore`,
   `McpToggleStore`, `FeatureRow`, `McpTogglesRow` from public
   barrel. Update all `ai-docs/` per § Documentation updates.

If any e2e step fails, fix the host migration before proceeding —
do not weaken the new API to accommodate a host bug.

## Follow-ups (out of scope)

- **`LlmAuthCredential` cleanup.** Drop `baseUrl` from the
  generic credential shape; it's HTTP-specific. Move it into a
  Bodhi-specific subtype. Tackle when a non-Bodhi provider
  arrives.
- **`BodhiProvider` extraction.** Move the class to its own
  package (`@bodhiapp/llm-provider-bodhi`?) so
  `@bodhiapp/web-acp-agent` ships truly provider-neutral. Tackle
  at the M8 library-extract milestone.
- **`ws-acp-client` + `cli-acp-client` migration.** Both packages
  will fail to build against this surface. Migrate separately,
  not as part of this plan.
- **Re-evaluate `_bodhi/mcp/toggles/set`.** If ACP's
  `SessionConfigOption` type system grows nested-JSON support,
  reconsider whether MCP toggles can ride that instead of a
  custom extension method.
