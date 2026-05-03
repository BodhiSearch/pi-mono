# ACP 0.21 migration plan — `web-acp-agent` + `web-acp`

**Date:** 2026-05-03
**SDK pinned:** `@agentclientprotocol/sdk@0.21.0`
**Source compliance review:** `ai-docs/web-acp/reviews/acp-compliance-2026-05-03.md`
**Out-of-scope companion:** `packages/cli-acp-client/` — a single TECHDEBT entry is the only deliverable there.

---

## 1. Goal & non-goals

**Goal.** Replace the `_bodhi/*` extension methods and `_meta.bodhi.*` envelope hacks that already have native ACP 0.21 equivalents. After this PR: zero spec violations, every method name `_`-prefixed, every standard surface ACP 0.21 ships with a corresponding implementation in scope (model selection, listSessions, closeSession, setSessionConfigOption), and the two clean-side-channel rides (MCP lifecycle + builtin action) move from `_meta` rides on `agent_message_chunk` to dedicated `extNotification` channels. The host's reducer gets explicit cases for all 11 `SessionUpdate` discriminator kinds rather than 7 silent drops.

**Non-goals.** No `unstable_forkSession` (M6). No `usage_update` emit-side wiring (only the reducer slot lands here). No `resumeSession`. No tool-call `kind` heuristic — `prompt-driver.ts:273` keeps its hard-coded `"execute"`. No `additionalDirectories`. No `providers/*`. No `setSessionMode`. No `agent_thought_chunk` emission. No changes to `packages/cli-acp-client/`; its e2e tests will fail post-merge and a TECHDEBT entry catalogues the wire deltas it needs to port.

## 2. Migration ordering

The PR lands in commits that respect dependencies. Within the agent package:

1. **`SessionState.currentModelId` field** in `acp/engine/types.ts:15-34` — add before any handler reads it.
2. **`agent-adapter.ts:117-134` `newSession` populates `models` and `configOptions`** — needs a lazy model-catalog fetch in `newSession` (moves the work today done by `bodhi/listModels`).
3. **`Agent.unstable_setSessionModel` handler** in `agent-adapter.ts` plus a `runtime.setSessionModel` mutator on `AcpSessionRuntime` — depends on (1).
4. **`prompt-driver.ts:192-197` reads `currentModelId` from session state** instead of `_meta.bodhi.modelId` — depends on (3) so the field is guaranteed populated before first prompt.
5. **`Agent.listSessions` and `Agent.closeSession` handlers** — independent of model work; need capability advertisement bumped on `initialize`.
6. **`Agent.setSessionConfigOption` + `agent-adapter.ts` initial `configOptions` advertisement** — independent.
7. **`session-runtime.ts:193-223` switch from `_meta.bodhi.mcp` ride to `extNotification("_bodhi/mcp/state", …)`** — independent, but host changes (10) must land in the same PR.
8. **`builtin-dispatch.ts:62-77` split: keep `_meta.bodhi.builtin.command` on the chunk, move `action` to `extNotification("_bodhi/builtin/action", …)`** — independent.
9. **`agent-adapter.ts:150-199` `loadSession` stamps `_meta.bodhi.{title,mcpToggles}` + populates `models` + `configOptions`** — depends on (2), (6).
10. **Delete ext-method handlers + wire constants** — after every consumer is migrated.

Within the host package, the migrations are sequenced by the dependency on the new agent surfaces:

11. **`acp/runtime.ts:67-78` add `extNotification` handler** — receive both `_bodhi/mcp/state` and `_bodhi/builtin/action`. Lands first so (15) can drop the pre-discriminator extractor cleanly.
12. **`acp/client.ts` swap `listSessions`/`listModels`/`getSession`/`setFeature`/`prompt._meta.modelId`/etc.** — keyed off the new agent surface.
13. **`hooks/useAcpModels.ts` + `useAcpAuth.ts:103` drop manual `bodhi/listModels` reload**.
14. **`hooks/useAcpFeatures.ts` rewrite around `state.configOptions` slice**.
15. **`hooks/useAcpSession.ts:203-220` drop `bodhi/getSession` round-trip; read `_meta.bodhi.{title,mcpToggles}` from `LoadSessionResponse`**.
16. **`acp/streaming-reducer.ts` add explicit cases for all 11 SessionUpdate kinds + `state.configOptions` slice + drop `extractMcpMeta` pre-discriminator**.
17. **Delete dead constants from `acp/index.ts` and `acp/methods.ts`**.

Tests update alongside the consuming change.

## 3. Agent-side changes (`packages/web-acp-agent/src/`)

### 3.1 `acp/engine/types.ts`

Extend `SessionState` (currently `acp/engine/types.ts:15-34`):

```
SessionState {
  id, mcpServers, requestedMcpUrls, mcpInstances,
+ currentModelId: string | null,   // mirrors what `unstable_setSessionModel` writes; null on fresh `newSession` until either the picker selects a default or the session is loaded with a `lastModelId` row.
}
```

`ExtMethodHost` (`types.ts:41-57`) is unchanged in shape but loses no fields; the deleted ext-method handlers stop being routed through `dispatchExtMethod` instead. We do not add `setSessionModel` to `ExtMethodHost` because that handler is a first-class `Agent` method, not an extension.

### 3.2 `acp/engine/session-runtime.ts`

- Add `setSessionModel(sessionId, modelId): void` helper (around `:62-79` near the other session-map accessors). Writes `state.currentModelId = modelId`.
- Add `ensureModelsLoaded(): Promise<Model<Api>[]>` — pulls the catalog from `bodhi.getAvailableModels()` exactly once, caches in `#models`. Replaces the single-shot population that today lives in `ext-methods/list-models.ts:5-11`. Called by `newSession` and `loadSession`.
- Replace `broadcastMcpPoolEvent` (`session-runtime.ts:193-223`):
  - Drop the `_meta.bodhi.mcp` envelope wrapped around an empty `agent_message_chunk`.
  - Emit `await this.#conn.extNotification("_bodhi/mcp/state", { sessionId, server: event.server, state: event.type, ...(event.error ? { error } : {}), ...(event.tools ? { tools } : {}) })` per affected session.
  - Persistence semantics unchanged (still transient — `extNotification` doesn't go through `runtime.emit`).

### 3.3 `acp/engine/prompt-driver.ts`

- Drop the local `BodhiPromptMeta` interface (`:20-24`).
- Replace `#resolveModel` (`:192-197`):
  ```
  const session = this.#runtime.getSession(params.sessionId);
  const modelId = session?.currentModelId;
  if (!modelId) return undefined;
  return this.#runtime.getModels().find((m) => m.id === modelId);
  ```
- Update the throw at `:104`: `"No model selected: call session/setModel first"`.
- Tool-call `kind` stays hard-coded `"execute"` at `:273` — explicitly out of scope per the user.

### 3.4 `acp/engine/builtin-dispatch.ts`

- The `agent_message_chunk` notification at `:70-77` keeps `_meta.bodhi.builtin.command` (the **tag** — needed for muted-bubble rendering on the chunk that travels with assistant text).
- The `action` field moves off `_meta`. Right after the persisted chunk emit, when `result.action` is present, fire `await conn.extNotification("_bodhi/builtin/action", { sessionId, command: match.cmd.name, action: result.action })`.
- The store's `BuiltinPayload.action` field on disk (`storage/session-store.ts:41-46`) stays — replay needs to know whether a builtin reply had a side-action so `bodhi/getSession` style snapshots (or any future action replay) can reconstruct correctly. (After A11 collapses `bodhi/getSession`, the host doesn't read this on load anyway, but the store should still record it for diagnostics.)
- Delete `BodhiPromptMeta` (`:7-11`) and the now-unused `resolveBuiltinModelId` (`:93-99`); read `currentModelId` from `runtime.getSession(sessionId)?.currentModelId`.

### 3.5 `acp/agent-adapter.ts`

- **`initialize` (`:73-96`).** Add:
  - `agentInfo: { name: "@bodhiapp/web-acp-agent", version: this.#buildVersion }` — needs `buildVersion` saved as a private field on the adapter (currently it's only passed to `PromptTurnDriver`; copy it onto `this`).
  - `agentCapabilities.sessionCapabilities = { list: {}, close: {} }` (no `resume` / `fork` / `additionalDirectories`).
- **`newSession` (`:117-135`).** Before returning, await `runtime.ensureModelsLoaded()`. Then return:
  ```
  return {
    sessionId,
    models: { availableModels: models.map(m => ({ modelId: m.id, name: m.id })), currentModelId: models[0]?.id ?? "" },
    configOptions: this.#initialConfigOptions(),  // see 3.5.4
  };
  ```
  Set `state.currentModelId = models[0]?.id ?? null` so the first prompt without an explicit `setSessionModel` still resolves something. (Alternative: leave `currentModelId: null` and force the host to call `setSessionModel`. The simpler default-first-model path matches today's UX, where the picker auto-selects.)
- **`loadSession` (`:150-199`).** Before returning, await `runtime.ensureModelsLoaded()`. Read `row.lastModelId` and seed `state.currentModelId`. Build the `_meta.bodhi.{title,mcpToggles}` payload from the existing `row.title` (already on `SessionRow` per `session-store.ts:56-63`) and `host.readMcpToggles(sessionId)` (helper already present, see `:121-129`). Return:
  ```
  return {
    models: { availableModels: ..., currentModelId: row.lastModelId ?? defaultModelId },
    configOptions: await this.#initialConfigOptions(sessionId),
    _meta: { bodhi: { title: row.title, mcpToggles: toWireMcpToggles(toggles) } },
  };
  ```
  Notification re-emit (`:178-189`) and inline-rehydrate (`:184-194`) are unchanged.
- **`prompt` (`:201-203`).** Unchanged signature; the driver reads `currentModelId` from session state (3.3).
- **`extMethod` (`:209-211`).** Unchanged plumbing, but the registered handler set shrinks (3.6).
- **New methods:**
  - `async listSessions(_params: ListSessionsRequest): Promise<ListSessionsResponse>` — read `host.store?.listSummaries()`, map each `SessionSummary` to `SessionInfo { sessionId, cwd: "/", title: row.title, updatedAt: new Date(row.updatedAt).toISOString(), _meta: { bodhi: { turnCount, lastModelId, createdAt } } }`. No cursor pagination yet (out of scope; just return everything).
  - `async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse>` — do exactly what `ext-methods/sessions-delete.ts:18-27` does today minus the `store.deleteSession`: `await mcpPool.releaseAll`, `runtime.deleteSessionEntry`, clear inline if active. Return `{}`.
  - `async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse>` — validate `modelId` against the cached catalog; throw if unknown; call `runtime.setSessionModel(sessionId, modelId)`. Return `{}`.
  - `async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse>` — see 3.5.4.
- **3.5.4 `#initialConfigOptions(sessionId?)`** (new private method on the adapter).
  - When `sessionId` is provided, read current `featureSnapshot = await host.readFeatures(sessionId)`.
  - Otherwise use `FEATURE_DEFAULTS` (storage/feature-store.ts).
  - Return `[ { type: "boolean", id: "_bodhi/features/bashEnabled", name: "Bash tool", category: "_bodhi/feature", currentValue: featureSnapshot.bashEnabled }, ...(this.#isDev ? [{ type: "boolean", id: "_bodhi/features/forceToolCall", name: "Force tool call (DEV)", category: "_bodhi/feature", currentValue: featureSnapshot.forceToolCall }] : []) ]`.
- **3.5.5 `setSessionConfigOption` handler.**
  - Recognise `configId === "_bodhi/features/bashEnabled"` → `await host.features.set(sessionId, "bashEnabled", value)`. Same for `forceToolCall` (with the existing `isDev` gate; mirror `ext-methods/features-set.ts:13-17`).
  - Reject any other `configId` with `RequestError.invalidParams` (or its TS equivalent).
  - After mutation, emit a `session/update` with `sessionUpdate: "config_option_update"` carrying the full freshly-rebuilt config-options list.
  - Return the standard SDK `{}` response (`SetSessionConfigOptionResponse` is empty).
- Remove the comment block at `:147-149` about `bodhi/listSessions / getSession` (no longer accurate).

### 3.6 `acp/engine/ext-methods/`

**Delete:**
- `list-models.ts`
- `list-sessions.ts`
- `get-session.ts`
- `features-list.ts`
- `features-set.ts`

**Keep:**
- `volumes-list.ts` (no ACP equivalent)
- `mcp-toggles-set.ts` (per-tool toggling has no ACP equivalent)
- `sessions-delete.ts` — internally call the new `closeSession` path, then `host.store.deleteSession`. Today its body (`:18-27`) is the close-equivalent + delete; refactor: helper `cleanupInMemorySession(sessionId)` shared with `Agent.closeSession`.

**`ext-methods/index.ts:1-32`.** Drop the five constants from the import block, remove the five entries from `HANDLERS`. After the change `HANDLERS` keys are exactly: `BODHI_VOLUMES_LIST_METHOD`, `BODHI_MCP_TOGGLES_SET_METHOD`, `BODHI_SESSIONS_DELETE_METHOD`.

### 3.7 `wire/index.ts`

**Delete (constants + types):**
- `BODHI_LIST_MODELS_METHOD` (`:25`)
- `BODHI_LIST_SESSIONS_METHOD` (`:26`)
- `BODHI_GET_SESSION_METHOD` (`:27`)
- `BODHI_FEATURES_LIST_METHOD` (`:33`)
- `BODHI_FEATURES_SET_METHOD` (`:34`)
- `BodhiModelDescriptor` (`:79`), `BodhiListModelsResponse` (`:84`)
- `BodhiSessionSummary` (`:94-101`), `BodhiListSessionsResponse` (`:103-105`)
- `BodhiGetSessionRequest` (`:114`), `BodhiGetSessionResponse` (`:118-124`)
- `BodhiFeatureBag` (`:57`), `BodhiFeaturesListResponse` (`:59-62`), `BodhiFeaturesSetRequest` (`:64-68`), `BodhiFeaturesSetResponse` (`:70-72`)
- The `M2 extension methods` comment block (`:29-31`) referring to legacy renames.

**Keep:**
- `BODHI_AUTH_METHOD_ID` (`:24`)
- `BODHI_VOLUMES_LIST_METHOD` (`:32`)
- `BODHI_MCP_TOGGLES_SET_METHOD` (`:40`)
- `BODHI_SESSIONS_DELETE_METHOD` (`:46`)
- `BodhiAuthenticateMeta` (`:74`), `BodhiVolumeDescriptor` / `BodhiVolumesListResponse` (`:48-55`), `BodhiMcpToggleSnapshot` (`:131`), `BodhiMcpTogglesSetRequest` / `Response` (`:142-151`), `BodhiSessionsDeleteRequest` / `Response` (`:153-165`).
- `BodhiBuiltinAction` family + `BodhiBuiltinMeta` + `BodhiBuiltinTag` (`:181-215`) — `command` still rides on chunk `_meta`; `action` rides on `extNotification`. The action union types are still re-exported because the host's `extNotification` handler narrows `params.action` against them.
- `BodhiMcpInstanceDescriptor` + `BodhiSessionMeta` (`:223-240`) — still on `_meta` of `newSession`/`loadSession`.

**Add:**
- `BODHI_MCP_STATE_NOTIFICATION_METHOD = "_bodhi/mcp/state"` constant.
- `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD = "_bodhi/builtin/action"` constant.
- `BodhiMcpStateNotificationParams { sessionId: string; server: string; state: McpConnectionState; error?: string; tools?: string[] }`.
- `BodhiBuiltinActionNotificationParams { sessionId: string; command: string; action: AnyBodhiBuiltinAction }`.
- `BodhiLoadSessionMeta { title?: string | null; mcpToggles?: BodhiMcpToggleSnapshot }` — typed shape of `_meta.bodhi` on `LoadSessionResponse`.
- `BodhiSessionInfoMeta { turnCount: number; lastModelId: string | null; createdAt: number }` — typed shape of `_meta.bodhi` on each `SessionInfo` in the list response.
- (Optional) `BODHI_FEATURE_BASH_CONFIG_ID = "_bodhi/features/bashEnabled"` and `BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID = "_bodhi/features/forceToolCall"` so the host doesn't string-match.

### 3.8 `index.ts` (public barrel)

- Drop the deleted exports propagated by `export * from "./wire"` (`:139`) — naturally handled by the wire deletes.
- No new explicit re-exports needed unless the new `BODHI_MCP_STATE_NOTIFICATION_METHOD` / `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD` constants are wanted for direct host import (recommended; the host's `extNotification` handler should switch on the constant).

### 3.9 `storage/session-store.ts` — verification only

- `SessionRow.lastModelId` (line `62`) — confirmed updated by `recordTurn` (per host-side dexie impl `runtime/storage-dexie/session-store.ts:58`). This is the source for `LoadSessionResponse.models.currentModelId` on rehydrate. No code change.
- `SessionSummary` (`:65-72`) — already carries `turnCount, lastModelId, createdAt`, exactly what gets stamped onto `SessionInfo._meta.bodhi`. No code change.
- `recordBuiltin.action` field — still write it; future `getSession` snapshot replay (if reintroduced) consumes it.

### 3.10 Tests in agent package

Most agent code is currently exercised by `packages/web-acp/src/runtime/storage-dexie/agent-adapter.test.ts` (the host's integration test against the real adapter), not by tests in `web-acp-agent` itself. The agent vitest suite has zero tests against the wire shim. The host's adapter test will need rewrites (see § 4.10).

## 4. Host-side changes (`packages/web-acp/src/`)

### 4.1 `acp/client.ts`

- Drop imports of `BODHI_LIST_MODELS_METHOD`, `BODHI_LIST_SESSIONS_METHOD`, `BODHI_GET_SESSION_METHOD`, `BODHI_FEATURES_LIST_METHOD`, `BODHI_FEATURES_SET_METHOD`, `BodhiListModelsResponse`, `BodhiListSessionsResponse`, `BodhiGetSessionResponse`, `BodhiFeaturesListResponse`, `BodhiFeaturesSetResponse`, `BodhiModelDescriptor`.
- Delete `listModels()` (`:79-83`).
- Delete `getSession()` (`:115-118`).
- Delete `listFeatures()` (`:139-142`).
- Delete `setFeature()` (`:144-151`).
- **Replace `listSessions()` (`:85-89`)** to call `this.#conn.listSessions({})` and return `response.sessions` (typed as `SessionInfo[]`). Callers read `summary._meta?.bodhi` for `turnCount` / `lastModelId` / `createdAt`.
- **Add `closeSession(sessionId: string): Promise<void>`** — calls `this.#conn.closeSession({ sessionId })`. Used by future logout/teardown polish; not required by current host code paths but advertised so the new wire surface has a host shim.
- **Add `setSessionModel(sessionId: string, modelId: string): Promise<void>`** — calls `this.#conn.unstable_setSessionModel({ sessionId, modelId })`. Used by `useAcpModels.setSelectedModel`.
- **Add `setSessionConfigOption(sessionId: string, configId: string, value: boolean): Promise<void>`** — calls `this.#conn.setSessionConfigOption({ sessionId, configId, value })`. Used by `useAcpFeatures.setFeature`.
- **`prompt` (`:174-180`).** Drop `_meta: { bodhi: { modelId } }`; change signature to `prompt(sessionId: string, text: string): Promise<PromptResponse>` (no `modelId` param) — the model is server-side state now.
- Keep `deleteSession` (`:127-131`), `setMcpToggle` (`:159-172`), `listVolumes` (`:133-137`), `cancel` (`:182-184`), `authenticate` (`:72-77`), `initialize` (`:60-70`), `newSession` (`:91-100`), `loadSession` (`:102-113`).

### 4.2 `acp/runtime.ts`

- Update the `Client` literal at `:67-78`:
  ```
  const handler: Client = {
    requestPermission: requestPermissionStub,
    sessionUpdate(params) { holder.client?.dispatchSessionUpdate(params); },
    readTextFile(params) { return fsHandlers.readTextFile(params); },
    writeTextFile(params) { return fsHandlers.writeTextFile(params); },
    async extNotification(method, params) {
      if (method === BODHI_MCP_STATE_NOTIFICATION_METHOD) {
        holder.client?.dispatchExtNotification(method, params);
        return;
      }
      if (method === BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD) {
        holder.client?.dispatchExtNotification(method, params);
        return;
      }
      console.warn("[acp/runtime] dropping unknown extNotification:", method);
    },
  };
  ```
- Add a parallel listener registry on `AcpClient` (in `client.ts`) for `extNotification` so hooks subscribe the same way they do for `session/update`. Mirror the `onSessionUpdate` / `dispatchSessionUpdate` pattern at `:186-203`.
- Remove `_authModels`, `getAuthModels`, `setAuthModels` (`:30, 157-163`) — models now ride on `NewSessionResponse.models` / `LoadSessionResponse.models` and the per-session model selection is server-side state.

### 4.3 `acp/streaming-reducer.ts`

- **Drop the pre-discriminator `extractMcpMeta` block (`:136-142`).** MCP state now arrives via the `extNotification` handler in `runtime.ts` and updates `state.mcpStates` through a separate dispatch the hook publishes.
- Move the `mcpStates` slice management out of `applySessionUpdate`; expose a new reducer action `{ type: 'mcp-state'; meta: McpConnectionMeta }` that the runtime's `extNotification` handler dispatches via the registry.
- Add `state.configOptions: SessionConfigOption[]` (default `[]` frozen identity per the `EMPTY_*` pattern at `:25-26`). Add reducer action handlers for:
  - `'config-options-init'` (initial value when `useAcpSession.ensureSession` / `loadSession` lands).
  - `'session-update'` discriminator `'config_option_update'` → replace `state.configOptions` with `update.configOptions`.
- Add explicit `case` arms for the 7 currently-dropped SessionUpdate kinds (`streaming-reducer.ts:215`):
  - `agent_thought_chunk` — accumulate into a separate `state.streamingThought` slice (or simply log + no-op for now if no UI). Recommend: add the slice now even if rendering lags.
  - `current_mode_update` — store `state.currentModeId`. No UI today — track for future.
  - `plan` — store `state.plan` (the full `PlanEntry[]`). No UI today; reducer slot present.
  - `user_message_chunk` — log + no-op (the host echoes user content locally; agent never emits today).
  - `config_option_update` — update `state.configOptions`.
  - `session_info_update` — update `state.sessionTitle` (and any other `SessionInfoUpdate` fields the spec defines).
  - `usage_update` — store `state.usage` (full latest snapshot). M7 reads it.
- Default `case` returns `state` with a `console.warn("[streaming-reducer] unhandled SessionUpdate kind:", update.sessionUpdate)`.

### 4.4 `acp/builtin-dispatch.ts`

- Function signature stays at `dispatchBuiltinAction(action, messages, triggerLogin)` (`:43-79`). The call site moves: today it's invoked from `useAcpStreaming.ts:108-110` reading `getBuiltinTag(finalMsg)?.action`; **after migration** the action arrives via `extNotification("_bodhi/builtin/action", { sessionId, command, action })`, so:
  - The `useAcpStreaming` invocation block (`:101-111`) reads the action solely from the new extNotification stream, not from the streaming chunk's tag.
  - The chunk's `_meta.bodhi.builtin.command` (`extractBuiltinMeta` in `lib/builtin-format.ts:27-39`) keeps producing a `BodhiBuiltinTag` with **only** the `command` field — the `action` field on the tag is no longer populated. Update the typedef in `wire/index.ts` so `BodhiBuiltinTag` reflects this (`action` field becomes optional and is never written by the chunk path post-migration; only relevant for stored snapshots from before the rollout).
- Add a small adapter in `useAcpMcp.ts` (or a sibling hook) that subscribes to the runtime's `extNotification` registry, narrows on `method === BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`, and calls `dispatchBuiltinAction(params.action, messagesRef.current, triggerLogin)`. The `messagesRef` plumbing already exists in `useAcpStreaming.ts:50-52`.

### 4.5 `acp/index.ts` and `acp/methods.ts`

- `acp/index.ts:31-41` — drop `BODHI_LIST_MODELS_METHOD`, `BODHI_LIST_SESSIONS_METHOD`, `BODHI_GET_SESSION_METHOD`, `BODHI_FEATURES_LIST_METHOD`, `BODHI_FEATURES_SET_METHOD` re-exports. Add `BODHI_MCP_STATE_NOTIFICATION_METHOD`, `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`.
- `acp/index.ts:43-72` — drop `BodhiFeatureBag`, `BodhiFeaturesListResponse`, `BodhiFeaturesSetRequest`, `BodhiFeaturesSetResponse`, `BodhiGetSessionRequest`, `BodhiGetSessionResponse`, `BodhiListModelsResponse`, `BodhiListSessionsResponse`, `BodhiModelDescriptor`, `BodhiSessionSummary`. Add `BodhiMcpStateNotificationParams`, `BodhiBuiltinActionNotificationParams`, `BodhiLoadSessionMeta`, `BodhiSessionInfoMeta`.
- `acp/methods.ts:12-29` — same pruning, same additions.

### 4.6 `hooks/useAcpModels.ts`

- Drop `loadModels` (`:73-96`) — there is no `bodhi/listModels` round-trip any more. Models come from `NewSessionResponse.models.availableModels` (passed in by `useAcpSession`).
- Keep `selectedModel`, `selectedApiFormat`, `setSelectedModel`, `ensureDefaultModel`, `applyLastModel`. Change `setSelectedModel(id, fmt)` to additionally call `await runtime.client.setSessionModel(sessionId, id)` (with the active session id from `getSession()`); race-safe against concurrent picks the same way `loadModels` was.
- Remove the `loadingModelsRef` ref-based dedupe (no more concurrent fetches).
- Remove the `BodhiModelDescriptor` import/type — replace with a thin local `ModelOption { id: string; apiFormat: ApiFormat }`. The `apiFormat` field is currently inferred from `BodhiModelDescriptor.apiFormat` returned by `bodhi/listModels`; in the new world it has to be inferred per-model from the `ModelInfo` shape (which only has `modelId`/`name`/`description`). Since the agent's own `listModels` cache populates `Model<Api>[]` from pi-ai (see `agent/bodhi-provider.ts`), `apiFormatOfModel` is the source of truth — and that lookup happens worker-side. Two options:
  - (a) Stamp `_meta.bodhi.apiFormat` on each `ModelInfo` and read it host-side. Lower-friction.
  - (b) Drop `apiFormat` from the host entirely; the host doesn't use it for any wire decision (the prompt no longer carries `modelId`, so the SDK doesn't need it). It's used only by `ModelCombobox` for display labels — a `string` is enough. **Recommend (b)** to avoid extending `_meta`.
- Drop `setAuthModels` import; the `useAcpAuth` hook no longer fetches the catalog.

### 4.7 `hooks/useAcpAuth.ts`

- Remove the `runtime.client.listModels()` call inside the inner async `run` (`:103`). After `authenticate` the hook simply awaits `runtime.initialize` and resolves the promise with no model fetching.
- Drop `setAuthModels` plumbing (`:81, 110, 113`) and the `getAuthModels()` import.
- The `useAcpAuth` hook's deps (`UseAcpAuthDeps.setModels`, `setIsLoadingModels`, `ensureDefaultModel`) should also drop these pieces — populating `models` is now `useAcpSession.ensureSession`'s job (it receives `models` from `NewSessionResponse`).
- Token rotation path (`:117-135`) is unchanged — still re-issues `session/load`. The new `LoadSessionResponse` will include the rebuilt `models` payload, but the rotation path doesn't need to do anything with it (the active selection is on the worker as `currentModelId` already).

### 4.8 `hooks/useAcpFeatures.ts`

Rewrite top-to-bottom. The hook becomes a thin selector over the reducer's `state.configOptions` slice plus a `setFeature` mutator:

```
function useAcpFeatures(setError, configOptions) {
  const features = useMemo(() => {
    // fold SessionConfigOption[] into a Record<string, boolean>
    const out: Record<string, boolean> = {};
    for (const opt of configOptions) {
      if (opt.type === "boolean" && opt.id.startsWith("_bodhi/features/")) {
        const key = opt.id.slice("_bodhi/features/".length);
        out[key] = opt.currentValue;
      }
    }
    return out;
  }, [configOptions]);

  const setFeature = useCallback(async (key: string, value: boolean) => {
    const sessionId = getSession();
    if (!sessionId) return;
    try {
      await ensureRuntime().client.setSessionConfigOption(sessionId, `_bodhi/features/${key}`, value);
      // Server emits config_option_update; the reducer updates state.configOptions.
    } catch (err) {
      console.error("setSessionConfigOption failed:", err);
      setError(getErrorMessage(err, "Failed to toggle feature"));
    }
  }, [setError]);

  return { features, setFeature };
}
```

- `featureDefaults` slice goes away — `SessionConfigOption.currentValue` carries the canonical state; defaults are an agent concept that the host doesn't need to render separately. (FeaturePanel changes are minor — drop the "default" badge or compute it from the agent-emitted shape.)
- `clearFeatures` callback goes away (not needed; `state.configOptions` resets on `'reset'` action).
- `refreshFeatures(sessionId)` goes away — not needed; the `NewSessionResponse.configOptions` / `LoadSessionResponse.configOptions` are dispatched into reducer via a new `'config-options-init'` action.

### 4.9 `hooks/useAcpSession.ts`

- **`refreshSessions` (`:80-93`).** Update to read `summary.title` directly from `SessionInfo`, `summary.updatedAt` (ISO string instead of number), and pull `turnCount`/`lastModelId`/`createdAt` from `summary._meta?.bodhi`. The `SessionPicker` consumer expects a `BodhiSessionSummary` shape today — refactor to a `SessionInfoView` shape that carries the `_meta` extras alongside the standard fields.
- **`ensureSession` (`:110-141`).** After `runtime.client.newSession(servers, sessionMeta)` resolves with `NewSessionResponse`, dispatch `{ type: 'config-options-init', configOptions: response.configOptions ?? [] }` into the streaming reducer, and call `setModels(response.models?.availableModels ?? [])` and `applyLastModel(response.models?.currentModelId, ...)` against `useAcpModels`.
- **`loadSession` (`:180-240`).** This is the big collapse:
  - **Drop** `runtime.client.getSession(sessionId)` (`:203`). Drop the `snapshot.mcpToggles` read.
  - The pre-load `composeCurrentMcpServers(toggles)` step at `:205` becomes a transient: pass `composeCurrentMcpServers()` (no toggles arg) and let the agent treat the toggles as authoritative state from the prior session row. (Per the compliance review's caveat at D5: option (a) of the trade-off — pass main-thread state directly.) The toggles load arrives back inside the `LoadSessionResponse._meta.bodhi.mcpToggles`, which dispatches into `setMcpToggles` *after* the load resolves.
  - After `runtime.client.loadSession(...)`, read `response.models?.currentModelId` → `applyLastModel(...)`. Read `response.models?.availableModels` → `setModels(...)`. Read `response._meta?.bodhi?.title` and `response._meta?.bodhi?.mcpToggles`.
  - The `streamingDispatch({ type: 'load-end', messages: snapshot.messages ... })` (`:215-218`) cannot be sourced from `bodhi/getSession` any more. Two options:
    - **(a)** Let the worker's notification re-emit (already happening at `agent-adapter.ts:178-189`) drive the message slice. The reducer would have to learn how to fold notifications during replay (`isReplaying = true` currently suppresses chunks at `streaming-reducer.ts:154`). Drop the replay guard's chunk suppression so chunks during load fold into `messages`. This is a behaviour change worth noting.
    - **(b)** Keep the per-session message snapshot as a `_meta.bodhi.messages` blob on `LoadSessionResponse`. Bigger, simpler.
    - **Recommend (a)** because it aligns with the spec's intent ("agents replay history as `session/update` notifications"). The reducer needs a new `'load-replay-chunk'` mode; on `load-end` we transfer the accumulated chunks into `messages`. Defer the implementation detail to the PR — this is the trickiest single change.
- **`deleteSession` (`:256-281`).** After migration, you can call `runtime.client.closeSession(sessionId)` first (cleanly free in-memory resources) then `runtime.client.deleteSession(sessionId)` (persistent removal). Or leave as-is since `_bodhi/sessions/delete` already does both internally. Recommend: keep call site identical; the agent does both.
- **Auth-loss teardown effect (`:286-306`).** Optionally swap `cancel` for `closeSession` to release MCP pool earlier. Out of scope; mention as a follow-up.

### 4.10 `hooks/useAcpStreaming.ts`

- Confirm `client.prompt(sessionId, prompt, selectedModel)` at `:94` becomes `client.prompt(sessionId, prompt)` (modelId argument removed).
- Drop `selectedModel` from the deps array (`:119`). The "Please select a model first" guard at `:69` still works — the host knows whether a model is selected from `useAcpModels` state (which is now driven by `NewSessionResponse.models.currentModelId`).
- Move the builtin-action dispatch (`:101-111`) out of this hook entirely. The action arrives via `extNotification` now; receive it in a sibling hook that subscribes to `runtime.client.onExtNotification`.

### 4.11 Tests in host package

Mid-level tests with directly-asserted wire shapes:
- `src/acp/streaming-reducer.test.ts` — adds cases for the 7 new SessionUpdate kinds, drops the `_meta.bodhi.mcp` test (the new `'mcp-state'` action takes its place).
- `src/runtime/storage-dexie/agent-adapter.test.ts` — heavy rewrites. Currently asserts `bodhi/listSessions` / `bodhi/listModels` / `bodhi/getSession` / `_bodhi/features/*` round-trips. Replace with `Agent.listSessions`, `Agent.unstable_setSessionModel`, `Agent.setSessionConfigOption`, `Agent.closeSession`, `LoadSessionResponse._meta.bodhi.*` assertions.
- `e2e/sessions.spec.ts` — line 40 references `bodhi/listSessions` ordering; spec assertions should still hold but the wire intercept names need updating.
- `e2e/builtins.spec.ts`, `e2e/mcp.spec.ts`, `e2e/chat.spec.ts` — likely need updates wherever they intercept JSON-RPC method names. Grep `_bodhi/features` and `_meta.bodhi.modelId` in e2e specs to find the edits.
- `App.test.tsx` — sanity-test the auth + session boot, mock the new `client.listSessions` etc.

## 5. TECHDEBT entry text — `packages/cli-acp-client/TECHDEBT.md`

The file currently has 1 line; the entry below is appended (or made the whole content with a header if the file is genuinely empty / placeholder):

````markdown
# cli-acp-client — known tech debt

## Wire surface lags ACP-0.21 migration in `web-acp-agent` / `web-acp`

**What.** `packages/web-acp-agent/` migrated its wire surface from `_bodhi/*` extension methods + `_meta.bodhi.*` envelopes to native ACP 0.21 surfaces (`Agent.listSessions`, `Agent.unstable_setSessionModel`, `Agent.setSessionConfigOption`, `Agent.closeSession`, `extNotification("_bodhi/mcp/state")`, `extNotification("_bodhi/builtin/action")`, `LoadSessionResponse._meta.bodhi.{title,mcpToggles}`, `NewSessionResponse.{models,configOptions}`). `cli-acp-client` was not updated in that round; its `EmbeddedHost.client` still calls the deleted `_bodhi/*` methods and expects the deleted `_meta.bodhi.modelId` request shape. As of this PR the package's vitest + e2e suites fail against an upgraded agent.

**Where.**
- `src/acp/client.ts` — drops `BODHI_LIST_MODELS_METHOD`, `BODHI_LIST_SESSIONS_METHOD`, `BODHI_GET_SESSION_METHOD`, `BODHI_FEATURES_LIST_METHOD`, `BODHI_FEATURES_SET_METHOD` from import block; calls to `client.listModels()`, `client.listSessions()`, `client.getSession()`, `client.listFeatures()`, `client.setFeature()` need replacement.
- `src/bootstrap.ts:294-306` — warm-up `client.listModels()` after authenticate; new world: models live on `NewSessionResponse.models` so warm-up lands on `client.newSession(...)` (or skips entirely; the catalog is no longer a pre-prompt prerequisite).
- `src/commands/login.ts:83-87` — same warm-up `listModels`.
- `src/commands/models.ts:16` — `client.listModels()` → read from the active session's `availableModels` cache.
- `src/commands/session.ts:51-52, 103, 170-182` — `client.listSessions()` → `client.listSessions({})` returning `SessionInfo[]`. `client.getSession(id)` is **gone**; the `messages` snapshot is replayed via `session/load` notifications. The CLI's pre-load snapshot fetch needs replacement: either fold the replay into a stream-controller buffer or read `LoadSessionResponse._meta.bodhi.{title}` for the title-only case.
- `src/commands/feature.ts:53, 114` — `client.listFeatures(sessionId)` → read from `NewSessionResponse.configOptions` (cached on the session ctx). `client.setFeature(sessionId, key, value)` → `client.setSessionConfigOption(sessionId, "_bodhi/features/" + key, value)`. The CLI's mock client in `commands/feature.test.ts:16-110` needs the new method shape.
- `src/mcp/catalog.ts:94` — `client.getSession(sessionId)` for `mcpToggles` snapshot. New: read `LoadSessionResponse._meta.bodhi.mcpToggles` from the load round-trip already happening, or call the surviving `_bodhi/mcp/toggles/set` handler with a no-op mutation to read back. Cleaner: stamp `mcpToggles` onto `_meta.bodhi` of the load response (already done in this PR) and have the CLI read it in `acp/embedded-host.ts` via the `loadSession` adapter.
- `src/acp/stream-controller.ts:13, 57-95` and `src/acp/stream-controller.test.ts:88-121` — currently route `_meta.bodhi.builtin.action` and `_meta.bodhi.mcp` from `session/update` notifications. New: subscribe to `extNotification("_bodhi/mcp/state", ...)` and `extNotification("_bodhi/builtin/action", ...)` on the agent connection. The `_meta.bodhi.builtin.command` tag still rides on the chunk for muted-bubble rendering.
- `src/acp/builtin-dispatch.ts:53` — `ctx.client.getSession(sessionId)` for `messages` snapshot inside `/copy`. New: track messages via the stream-controller's incremental fold (the agent stops shipping a snapshot endpoint).
- `src/acp/builtin-dispatch.test.ts:55-300` — every `getSession` mock disappears; rewrite around the in-memory message log.
- `src/auth/debug.test.ts:54` — error string check `"No model selected: send session/prompt with _meta.bodhi.modelId"` becomes `"No model selected: call session/setModel first"`.
- `src/commands/mcp.ts:17` — comment about `_meta.bodhi.builtin.action`; update to cite `extNotification("_bodhi/builtin/action")`.
- Prompt path — wherever the CLI builds a `session/prompt` payload with `_meta.bodhi.modelId`, drop the meta and call `client.unstable_setSessionModel(sessionId, modelId)` once when the user picks a model.

**Why it matters.** The agent rejects `bodhi/listSessions` / `bodhi/listModels` / `bodhi/getSession` / `_bodhi/features/*` with `Unknown extension method` (per `dispatchExtMethod`'s error path). `session/prompt` with `_meta.bodhi.modelId` still works at the wire level (the agent ignores unknown `_meta` fields) but the agent now resolves the model from `SessionState.currentModelId`, so prompts will fail with `"No model selected: call session/setModel first"` until the CLI calls `unstable_setSessionModel` after authenticate. Builtin `/copy` actions ride a different channel and won't dispatch until the CLI wires `extNotification`. Net: every CLI-issued session that calls `/copy`, picks a model, lists sessions, lists features, or toggles a feature is broken.

**Fix sketch.** Mirror the host migration in `web-acp/`. Specifically:
1. Add an `extNotification` handler to the embedded host's `Client` literal; route `_bodhi/mcp/state` into the existing mcp-state slice and `_bodhi/builtin/action` into the existing builtin-dispatch.
2. Replace `AcpClient.listSessions()` / `listModels()` / `getSession()` / `listFeatures()` / `setFeature()` with the standard SDK calls; update every call site listed above.
3. Add `AcpClient.setSessionModel(sessionId, modelId)` and call it after `authenticate` (or whenever the user picks a model). Drop `_meta.bodhi.modelId` from the prompt payload.
4. Add `AcpClient.setSessionConfigOption(sessionId, configId, value)`; route the `/feature` command through it.
5. Read `_meta.bodhi.{title,mcpToggles}` off `LoadSessionResponse` and seed the CLI's session ctx from it; collapse the pre-load `getSession` round-trip the same way `useAcpSession.loadSession` does in `web-acp`.
6. Update `stream-controller.test.ts` and `builtin-dispatch.test.ts` to remove `getSession` mocks and rely on the in-memory message log.
````

## 6. Test impact + verification plan

### `npm run check` (typecheck) at `packages/web-acp-agent/`

- After the wire deletes, every still-existing reference inside `web-acp-agent` should be wire-clean. The vitest tests in `agent/commands/` and `agent/mcp/` don't touch the deleted constants.
- `index.ts:139` (`export * from "./wire"`) shrinks naturally; no consumer inside the agent package should import the deleted symbols. (Ext-method handler files are deleted alongside their constants.)

### `npm run check` at `packages/web-acp/`

- The host re-exports the deleted constants from `acp/index.ts:31-72`. Every remove must be paired with an `acp/methods.ts` cleanup so dependent hooks (`useAcpFeatures`, `useAcpSession`) compile.
- Strictest blocker: `apiFormat` field on `BodhiModelDescriptor` was used by `ModelCombobox`. Switching to `ModelInfo` means `apiFormat` is gone — verify whether any tool/wire decision actually consumed it. (Per § 4.6, only display labels do; safe to drop.)

### `npm run test` (vitest)

- `packages/web-acp/src/acp/streaming-reducer.test.ts` rewrites required (Section 4.11).
- `packages/web-acp/src/runtime/storage-dexie/agent-adapter.test.ts` is the integration test; expect the most edits. It boots a real `AcpAgentAdapter` over a `MessageChannel`-shaped stream and asserts wire round-trips.
- `packages/web-acp/src/lib/builtin-format.test.ts` — drop tests covering `_meta.bodhi.builtin.action` extraction; the host no longer reads `action` off the chunk.

### `npm run test:e2e` at `packages/web-acp/`

- The e2e suites assert UI behaviour over real chrome. They don't intercept JSON-RPC by raw method name, so most assertions hold. Check spec by spec:
  - `sessions.spec.ts:40` — comment-only reference to `bodhi/listSessions`; behaviour-level assertion (sessions ordered by updatedAt desc) should still pass.
  - `builtins.spec.ts` — `/help`, `/version`, `/copy`, `/mcp` flows. `/copy` needs the action to arrive via the new `extNotification` channel; assertion that the toast fires should still hold.
  - `mcp.spec.ts` — `_bodhi/mcp/state` rides extNotification now; the chip-state assertion should still hold because the reducer slice is fed identically.
  - `chat.spec.ts` — model picker + prompt flow. Confirm the picker doesn't depend on `bodhi/listModels` round-trip; should now read from `NewSessionResponse.models`.
- Snapshot tests of `available_commands_update` payloads — none in the e2e suite (advertised commands are read by `CommandPicker` via `state.availableCommands`, no snapshot).

### `cli-acp-client` test impact

- Vitest unit tests fail (mock `client.listSessions`, `client.getSession`, `client.listFeatures`, `client.setFeature` shapes don't exist on the new agent surface).
- E2E tests fail (the spawned agent rejects calls to deleted methods).
- This is the explicit trade-off in the user's scope decision; TECHDEBT entry catalogues it.

## 7. Rollback strategy

**Single PR, single revert.** All deliverables ride one commit (or one merge commit) so rollback is `git revert` against the merge SHA. Reasoning:

- The `_meta.bodhi.modelId` removal on prompts and the corresponding `unstable_setSessionModel` adoption are atomic — partial rollback (revert prompt-side without reverting `setSessionModel`) leaves the agent unable to find a model.
- The `_bodhi/features/*` removal and `setSessionConfigOption` adoption are atomic — partial rollback leaves the host with no way to mutate features.
- `bodhi/getSession` collapse depends on `LoadSessionResponse._meta.bodhi` being populated; partial rollback leaves the host pre-loading via a deleted method.

The cli-acp-client TECHDEBT entry is informational and lands in the same PR. If a follow-up PR fixes cli-acp-client, the TECHDEBT entry is deleted in that PR.

## 8. Risks / open questions

1. **`_meta.bodhi.title` on `LoadSessionResponse`.** `SessionInfo` (from `listSessions`) carries a stable `title?: string | null`. `LoadSessionResponse` does **not** carry a `title` field in 0.21. Two viable rides:
   - (a) `_meta.bodhi.title` on `LoadSessionResponse` — ties the host to a custom `_meta` field for a piece of info ACP could plausibly stabilise on `LoadSessionResponse` later. Recommend.
   - (b) Have the host call `listSessions` once on tab boot and look up `title` by `sessionId` locally on each load. Lower-cost wire-wise, more state on the host.
   - **Recommendation: (a)**; it matches the existing `_meta.bodhi.mcpToggles` pattern. Document in the migration commit message that the field disappears the day ACP adds a stable `LoadSessionResponse.title`.

2. **Default model resolution on fresh `newSession`.** The user's spec leaves `currentModelId` ambiguous on first `newSession`. Options:
   - (a) Pick `availableModels[0]` server-side. Matches today's auto-default behaviour. Recommend.
   - (b) Leave `currentModelId` as `""` (empty string per the spec's `ModelId = string` shape) and force the host to call `unstable_setSessionModel` before the first prompt. Stricter; mirrors how the picker's "no model selected" guard works today on the host.
   - **Recommendation: (a)** with a typed `currentModelId: string` (never null on the wire); host UI is unchanged.

3. **Reducer message replay during `loadSession`.** § 4.9 flagged the trade-off: today the host fetches `messages` via `bodhi/getSession`, which is outside the notification stream. Removing it forces the reducer to fold `agent_message_chunk` / `tool_call` etc. *during* replay. The current `isReplaying` guard suppresses live chunks at `streaming-reducer.ts:154`; we'd need a `replayBuffer` slice that accumulates while replaying and flushes into `messages` on `load-end`. Risk: tool-call ordering inside the buffer needs to match the persisted-notification order. The agent's `loadSession` already replays in `seq` order via `store.readEntries` (`agent-adapter.ts:176-189`), so order is preserved.

4. **`config_option_update` emission.** The agent emits one `session/update` per `setSessionConfigOption` call. If the host's `setSessionConfigOption` request returns *before* the `config_option_update` notification round-trips, the reducer's slice updates are eventually-consistent. The optimistic-update path (mirroring today's `useAcpFeatures.setFeature`) requires the hook to dispatch a local `'config-option-set'` action on success and let the notification overwrite (idempotent). Acceptable.

5. **`AcpClient.setSessionConfigOption` strictness.** SDK 0.21's `SetSessionConfigOptionRequest.value` is `unknown` (driven by the option's `type`). For boolean-typed options (today: `bashEnabled`, `forceToolCall`) the value is a plain boolean. Future select-typed options would carry strings. The host wrapper signature should be `value: boolean | string` or `value: unknown` and let TypeScript narrow at call sites.

6. **`agentInfo` source.** Plumbing `buildVersion` into `initialize` requires saving it on the adapter. Today only `PromptTurnDriver` reads it (`:67`). Add an instance field `this.#buildVersion` on the adapter; reuse for both `agentInfo` and the driver constructor.

7. **`bashEnabled` default migration.** Existing sessions in IndexedDB have `featureRow.flags.bashEnabled` written with the M2-era logic. After migration, the agent's `#initialConfigOptions(sessionId)` reads from the same `FeatureStore` — no data migration. Verify: the dexie store reads back the `flags.bashEnabled` field and the new `setSessionConfigOption` writes through the same path.

8. **`extNotification` SDK handler optionality.** SDK 0.21's `Client.extNotification` is optional. Adding the handler in `runtime.ts` is non-breaking. The agent's `Agent.extNotification` is also optional and we don't need to declare a handler on the agent side (the agent only sends, never receives, custom notifications). Confirmed by `acp.d.ts:830`.

### Critical Files for Implementation

- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/web-acp-agent/src/acp/agent-adapter.ts`
- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/web-acp-agent/src/acp/engine/session-runtime.ts`
- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/web-acp-agent/src/wire/index.ts`
- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/web-acp/src/acp/client.ts`
- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/web-acp/src/acp/streaming-reducer.ts`
- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/web-acp/src/hooks/useAcpSession.ts`
- `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono/packages/cli-acp-client/TECHDEBT.md`
