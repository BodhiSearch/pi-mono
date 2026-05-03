# React hooks — `useAcp` facade + slice hooks

**Source of truth:** `packages/web-acp/src/hooks/`.

> **ACP 0.21 migration delta (M1–M7).**
> - `useAcpModels` rewritten as a thin slice. `setSelectedModel(id)`
>   now pushes the user pick to the agent via
>   `client.setSessionModel(sessionId, id)` and publishes the
>   in-flight promise to `acp/runtime.ts:setModelUpdatePromise` so
>   `useAcpStreaming.sendMessage` can await it before `prompt()`.
>   Removed: `loadModels`, `loadingModelsRef`, `isLoadingModels`,
>   `selectedApiFormat`, `apiFormat` plumbing.
> - `useAcpAuth` no longer fetches the model catalog. Removed
>   `setModels`, `setIsLoadingModels`, `ensureDefaultModel`,
>   `loadingModelsRef` deps. The auth effect just authenticates +
>   handles token rotation.
> - `useAcpFeatures` rewritten as a memo selector over
>   `state.configOptions`. `setFeature(key, value)` calls
>   `client.setSessionConfigOption(sessionId, '_bodhi/features/'+key,
>   value)`. Removed `featureDefaults`, `clearFeatures`,
>   `refreshFeatures`.
> - `useAcpSession.ensureSession` and `loadSession` populate the
>   model picker from `NewSessionResponse.models` /
>   `LoadSessionResponse.models` (`SessionModelState`) via a pure
>   `applyModelState` helper, and dispatch `'config-options-init'`
>   from `response.configOptions`. `loadSession` still fetches
>   `bodhi/getSession` for the message snapshot (M5 deferred).
> - `useAcpStreaming` gained an extNotification subscription that
>   routes `_bodhi/mcp/state` to the reducer and
>   `_bodhi/builtin/action` to the action dispatcher (M6). The
>   in-band action dispatch from `streamingMessage._builtin.action`
>   was removed; `sendMessage` awaits `getModelUpdatePromise()`
>   before `client.prompt()` to avoid the model-update race.

## Purpose

`useAcp()` is the single entry point the React layer
consumes. It composes eight per-concern slice hooks and
applies an `isAuthenticated ? real : EMPTY_*` gate so
consumers see empty state the instant auth flips rather than
stale data from a previous login.

The split mirrors the agent's wire/engine cut: `useAcp.ts`
is the facade, the per-concern hooks each own one slice of
the worker conversation. State that survives across
re-renders — the worker, the ACP client, the per-tab session
id — lives at module scope inside `acp/runtime.ts`. See
[`acp.md`](./acp.md) § runtime singleton.

## `useAcp` facade — `hooks/useAcp.ts:51`

Orchestrator. Mounts the eight slice hooks in dependency
order, threads cross-hook callbacks (e.g. `useAcpStreaming`
calls `refreshSessions` from `useAcpSession`), and gates the
returned values on `isAuthenticated`.

Mount order (matches dataflow). Eight slice hooks plus one
React primitive `useReducer` call interleaved between the
auth and session slices:

1. `useMcpInstances()` — Bodhi catalog watcher (live fetch).
2. `useAcpModels(isAuthenticated, setError)` — model catalog state.
3. `useAcpFeatures(setError)` — feature toggle slice.
4. `useAcpRuntime()` — runtime singleton + volumes.
5. `useAcpMcp({ setError, mcpInstances })` — toggle store + composer + dispatcher.
6. `useAcpAuth({ ...mutators })` — observes Bodhi auth, drives `authenticate`+`listModels`.
7. `useReducer(streamingReducer, initialStreamingState)` — primitive React call (not a slice hook), wires the streaming state machine.
8. `useAcpSession({ ...mutators, streamingDispatch })` — `ensureSession`, `loadSession`, `clearMessages`, `deleteSession`.
9. `useAcpStreaming({ state, dispatch, ... })` — `sendMessage`, `stop`, `session/update` subscription.

Empty constants (`EMPTY_MESSAGES`, `EMPTY_MODELS`, …) are
declared at module scope and frozen so they have stable
reference identity. The gate `isAuthenticated ? real :
EMPTY_*` keeps consumer effects from re-firing when auth
toggles.

Return shape: `{ messages, models, isLoadingModels,
selectedModel, setSelectedModel, sendMessage, stop, error,
clearError, sessions, currentSessionId, isLoadingSession,
loadSession, clearMessages, deleteSession, isStreaming,
toolCalls, isAuthenticated, refreshSessions, volumes,
features, featureDefaults, setFeature, clearFeatures,
mcp, availableCommands }`. The MCP slice is grouped under a
single nested key — `mcp: { instances, states, toggles,
isLoading, error, refresh, setToggle }` — so consumers
destructure `const { mcp } = useAcp()` and read
`mcp.instances`, `mcp.toggles`, `mcp.setToggle`. The internal
`dispatchAction` callback is **not** re-exported on the
facade return; it's threaded as a `useAcpStreaming` dep
inside the hook and stays internal. Consumer reference:
`components/chat/ChatDemo.tsx:33`.

## Slice hooks

### `useAcpRuntime` — `hooks/useAcpRuntime.ts`

Mounts the runtime singleton. `ensureRuntime()` (from
`acp/runtime.ts`) constructs the Worker + `AcpClient` once
per tab; the hook is just an effect that calls it. Wraps
`useVolumes({ volumeControl, onInitialVolumes })` — the
volumes hook is responsible for resolving the worker's
`init` payload by calling
`runtime.resolveInit(initialMounts)`.

Returns `{ runtime, volumes }`.

### `useAcpAuth` — `hooks/useAcpAuth.ts`

Owns the auth observation + token rotation effects. Watches
Bodhi auth state (`useBodhi`) and:

- Computes the auth key via `acp/session-meta.ts:authKeyOf`.
- On change: calls `client.authenticate({ token, baseUrl })`,
  then `client.listModels()` to warm the catalog.
- Caches the auth key + models via the runtime's
  `setAuthKey` / `setAuthModels` accessors so other slice
  hooks see consistent values.
- On token rotation while a session is active: rebuilds
  the session via `client.loadSession(sessionId,
  composedMcpServers, composeSessionMeta(...))` so the
  worker re-acquires MCP connections under the new
  fingerprint and reloads its inline-agent history.
- On auth loss: dispatches `'reset'` to the streaming
  reducer.

`UseAcpAuthDeps` is the cross-hook plumbing bag. The slice
calls into mutators owned by sibling hooks (`setModels`,
`ensureDefaultModel`, etc.) so the facade is the single
place that knows the wiring.

### `useAcpModels` — `hooks/useAcpModels.ts`

Owns the per-tab model catalog state.

| Returned value | Behaviour |
| --- | --- |
| `models: BodhiModelDescriptor[]` | The cached catalog. |
| `isLoadingModels` | True while the model fetch is in-flight. |
| `selectedModel: string`, `selectedApiFormat: ApiFormat` | Active selection. |
| `setSelectedModel(id, fmt)` | UI-driven selection update. |
| `loadModels()` | Manual refresh — used by the picker's "Reload" button. Calls `client.listModels()` + `setAuthModels(models)`. |
| `setModels(list)` / `setIsLoadingModels(loading)` | Mutators exposed for use by sibling hooks (`useAcpAuth` populates `models` after auth flip). |
| `ensureDefaultModel(list)` | If no selection or current selection has vanished, pick the first model. |
| `applyLastModel(lastModelId, list)` | After `session/load`: re-select the snapshot's `lastModelId` if it's still in `list`. |
| `loadingModelsRef: MutableRefObject<boolean>` | Concurrent-fetch dedupe used by `useAcpAuth`. |

### `useAcpFeatures` — `hooks/useAcpFeatures.ts`

`_bodhi/features/list` + `_bodhi/features/set` slice. The
features bag is **per-session**; this hook neither owns nor
watches the session id —`refreshFeatures(sessionId)` is
invoked by `useAcpSession` on `session/new` / `session/load`,
while `setFeature(key, value)` reads the active session from
the runtime singleton.

Returns `{ features, featureDefaults, refreshFeatures,
setFeature, clearFeatures }`. `featureDefaults` is **state**,
not a static mirror — it is populated by the worker's
per-call response (`payload.defaults`) inside
`refreshFeatures`. The agent today returns the agent-package
`FEATURE_DEFAULTS` verbatim, but the UI must not assume that
contract; treat `featureDefaults` as session-derived.

### `useAcpMcp` — `hooks/useAcpMcp.ts`

The MCP composition + toggle slice. Owns:

- `mcpToggles: McpToggleSnapshot` — current toggle state, reset on `clearFeatures` / `loadSession`.
- `setMcpToggles(toggles)` — React setter exposed for `useAcpSession.ts` to call after `bodhi/getSession`'s snapshot rebuild (full toggle-snapshot replace).
- `setMcpToggle(serverSlug, value, toolName?)` — single-key mutate via `client.setMcpToggle`. Server-level changes re-issue `client.loadSession` so the agent re-acquires under the new server set.
- `composeCurrentMcpServers(toggles?: McpToggleSnapshot)` — joins instance catalog + JWT + server-level toggle filter into the `McpServerHttp[]` payload `loadSession` expects. The token + `baseUrl` are read from `useBodhi`'s `auth.accessToken` and `bodhiClient.getState()` **inside the closure** — they are not parameters. Calls `compose-mcp-servers.ts:composeMcpServers` after the lookup.
- `dispatchAction(action, messages)` — proxies into `acp/builtin-dispatch.ts:dispatchBuiltinAction`, passing the live `triggerLogin` closure.
- Refs (`mcpInstancesRef`, `mcpTogglesRef`, `requestedMcpUrlsRef`) — mutable views of the latest values, useful for `useAcpAuth`/`useAcpSession` callbacks that don't want a re-render dependency on a fast-changing object.

Boot effect: loads `requested-mcps-store.ts:loadRequestedMcps()`
into `requestedMcpUrlsRef.current` on mount.

### `useAcpSession` — `hooks/useAcpSession.ts`

Session lifecycle slice. Owns:

- `sessions: BodhiSessionSummary[]` — the picker list.
- `currentSessionId: string | null`.
- `isLoadingSession: boolean`.
- `refreshSessions()` — `client.listSessions` → state.
- `ensureSession()` — returns the active session id, lazily creating one via `client.newSession` if absent. Concurrency-safe via the runtime's `getSessionPromise` / `setSessionPromise`.
- `loadSession(sessionId)` — full reload:
    1. `streamingDispatch({ type: 'load-start' })`.
    2. `client.loadSession(...)` (replays via `runtime.sendRawNotification`s on the agent side).
    3. `client.getSession(...)` for the snapshot rebuild (messages, lastModelId, mcpToggles, …).
    4. `applyLastModel(snapshot.lastModelId, models)`.
    5. `setMcpToggles(snapshot.mcpToggles)` + `refreshFeatures(sessionId)`.
    6. `streamingDispatch({ type: 'load-end', messages: snapshot.messages })`.
- `clearMessages()` — `streamingDispatch({ type: 'reset' })` + `clearFeatures()` + un-set the active session id.
- `deleteSession(sessionId)` — `client.deleteSession`; if active, also `clearMessages`. Fires `refreshSessions` on success.

Boot effects (two separate `useEffect`s, do not collapse them
in your head):

1. `refreshSessions()` runs unconditionally on mount and
   whenever its deps flip — the function itself gates on
   `isAuthenticated` internally and clears state on logout.
2. The auto-`ensureSession` effect is gated on
   `isAuthenticated && mcpInstancesIsReady` and lazily creates
   a fresh session when the user is authenticated and the MCP
   catalog is ready but no `currentSessionId` exists yet.

### `useAcpStreaming` — `hooks/useAcpStreaming.ts`

The prompt-turn loop + `session/update` listener.

- Subscribes to `client.onSessionUpdate(notif => dispatch({ type: 'session-update', notif }))` once per mount.
- `sendMessage(prompt)`:
    1. `await ensureSession()`.
    2. Build the user message, detect a built-in tag via `detectBuiltinTag`, dispatch `'turn-start'`.
    3. `client.prompt(sessionId, prompt, selectedModel)`.
    4. After resolve: dispatch `'turn-end'` with `finalMessage` from the `streamingMessageRef`. The ref is **not** updated by the reducer (the reducer is pure) — it is synced via a side-effect `useEffect` listening on `state.streamingMessage` so the imperative `sendMessage` callback can read the latest assistant message at resolve time without a re-render dependency.
    5. If the final message carries a `_builtin.action`, call `dispatchAction(action, messagesRef.current)` — note `messagesRef.current` is snapshotted *before* the appended built-in pair, giving `/copy` the LLM-only conversation.
- `stop()` — `client.cancel(sessionId)`.
- `clearError()` — `setError(null)`.

### `useVolumes` — `hooks/useVolumes.ts`

Volume hook called from `useAcpRuntime`. Documented in
[`volumes.md`](./volumes.md) § hook surface.

## StrictMode + HMR invariants

- **Singleton survival.** `acp/runtime.ts:ensureRuntime`
  reads / writes `_runtime` at module scope. StrictMode's
  double-mount calls `ensureRuntime()` twice; the second
  call returns the cached value. Vite HMR preserves module
  state.
- **Per-tab session id.** Same pattern: `let _session` at
  module scope. `useAcpSession` reads it on every effect,
  so a hook re-mount sees the existing session rather than
  creating a duplicate.
- **Auth promise dedup.** `getAuthPromise` / `setAuthPromise`
  hold the in-flight auth+listModels work; concurrent slice
  hooks `await` the same promise rather than racing.

## Cross-hook plumbing

The facade passes mutators between slices through deps
objects (`UseAcpAuthDeps`, `UseAcpSessionDeps`, etc.) rather
than React Context. Reasoning:

- The whole orchestration is per-tab + lazily mounted; a
  context provider would force every hook into the
  React tree, which is more layering than the host needs.
- Tests exercise individual slice hooks by passing
  hand-rolled deps; no context wrapper required.

## Cross-references

- ACP wire layer the hooks consume:
  [`acp.md`](./acp.md) (`AcpClient`, `streamingReducer`,
  `dispatchBuiltinAction`).
- Storage adapters:
  [`storage-dexie.md`](./storage-dexie.md).
- Volume hook detail:
  [`volumes.md`](./volumes.md) § hook surface.
- MCP catalog + composer:
  [`mcp.md`](./mcp.md).
- Features UI surface:
  [`features.md`](./features.md).
- Browser-host startup walk-through:
  [`startup-sequence.md`](./startup-sequence.md).
