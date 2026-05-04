# React hooks — `useAcp` facade + slice hooks

**Source of truth:** `packages/web-acp/src/hooks/`.

## Purpose

`useAcp()` is the single entry point the React layer
consumes. It composes seven per-concern slice hooks plus an
inline features memo, and applies an `isAuthenticated ?
real : EMPTY_*` gate so consumers see empty state the instant
auth flips rather than stale data from a previous login.

The split mirrors the agent's wire/engine cut: `useAcp.ts`
is the facade, the per-concern hooks each own one slice of
the worker conversation. State that survives across
re-renders — the worker, the ACP client, the per-tab session
id, the model-update mutex — lives at module scope inside
`acp/runtime.ts`. See [`acp.md`](./acp.md) § runtime singleton.

## `useAcp` facade — `hooks/useAcp.ts:51`

Orchestrator. Mounts the slice hooks in dependency order, runs
the streaming + panels reducers, derives the per-session
features memo, exposes `setFeature`, and gates the returned
values on `isAuthenticated`.

There is **no** `useAcpFeatures` hook anymore — the inline
`features` memo + `setFeature` callback below absorbed it.

Mount order (matches dataflow):

1. `const { isAuthenticated } = useBodhi()`.
2. `useMcpInstances()` — Bodhi catalog watcher (live fetch).
3. `useState<string | null>(null)` for `error`.
4. `useAcpModels(setError)` — model catalog state +
   `hydrateFromSessionResponse`.
5. `useAcpRuntime()` — runtime singleton + volumes.
6. `useAcpMcp({ setError, mcpInstances })` — toggle store +
   composer + dispatcher + the three refs (`mcpInstancesRef`,
   `mcpTogglesRef`, `requestedMcpUrlsRef`).
7. `useAcpAuth({ setError, mcpInstancesRef, mcpTogglesRef,
   requestedMcpUrlsRef, mcpInstancesIsReady })` — observes
   Bodhi auth, drives `authenticate` + token-rotation
   `loadSession`. **Does not fetch the model catalog**.
8. `useReducer(streamingReducer, initialStreamingState)` and
   `useReducer(panelsReducer, initialPanelsState)` —
   per-turn vs cross-turn reducer pair (lines `:81–82`).
9. `dispatch` callback (lines `:83–86`) — fans every
   `AcpAction` into both reducers; `panelsReducer`'s
   `===`-bailout invariant means non-panel actions don't cause
   panel consumers to re-render.
10. **Inline features memo** (lines `:88–101`) — translates
    `panelsState.configOptions` into a `FeatureBag` via
    `FEATURE_KEY_BY_CONFIG_ID`. Accepts both stable
    `select` (`currentValue === 'on'`) and legacy unstable
    `boolean` shapes so a stale agent build doesn't break the
    toggle UI.
11. **Inline `setFeature` callback** (lines `:103–121`) —
    reads `getSession()`; bails when no session. Uses
    `FEATURE_KEY_TO_CONFIG_ID` to translate the UI's feature
    key back to the wire configId, then calls
    `client.setSessionConfigOption(sessionId, configId, value
    ? 'on' : 'off')`. Errors surface via `setError` and a
    `console.error`.
12. `useAcpSession({ ..., streamingDispatch: dispatch,
    hydrateModelsFromSessionResponse, setMcpToggles })` —
    `ensureSession`, `loadSession`, `clearMessages`,
    `deleteSession`, `refreshSessions`. Both `ensureSession`
    and `loadSession` populate the model picker via
    `hydrateFromSessionResponse(response.models)` and dispatch
    `'config-options-init'` from `response.configOptions`.
13. `useAcpStreaming({ state: streamingState, dispatch,
    ensureSession, refreshSessions, dispatchAction,
    selectedModel, setError })` — `sendMessage`, `stop`,
    `clearError`, plus the unified `session/update` +
    `extNotification` listener.

Empty constants (`EMPTY_MESSAGES`, `EMPTY_MODELS`,
`EMPTY_SESSIONS`, `EMPTY_FEATURES`, `EMPTY_TOOL_CALLS`,
`EMPTY_MCP_INSTANCES`) are declared at module scope (lines
`:35–40`) so they have stable reference identity. The
`EMPTY_AVAILABLE_COMMANDS`, `EMPTY_MCP_STATES`, and
`EMPTY_MCP_TOGGLES` constants are imported from
`@/acp/index` (the frozen sentinels) so the gate uses the
same identity the panel reducer initialises with.

The gate `isAuthenticated ? real : EMPTY_*` keeps consumer
effects from re-firing when auth toggles.

Return shape (lines `:161–193`): `{ messages, streamingMessage,
isStreaming, selectedModel, setSelectedModel, sendMessage,
stop, clearMessages, error, clearError, models, sessions,
refreshSessions, loadSession, deleteSession, currentSessionId,
isLoadingSession, volumes, features, setFeature, toolCalls,
availableCommands, mcp: { instances, states, toggles,
isLoading, error, refresh, setToggle } }`. The MCP slice is
grouped under a single nested key so consumers destructure
`const { mcp } = useAcp()` and read `mcp.instances`,
`mcp.toggles`, `mcp.setToggle`. The internal `dispatchAction`
callback is **not** re-exported on the facade return; it's
threaded as a `useAcpStreaming` dep and stays internal.
Consumer reference: `components/chat/ChatDemo.tsx`.

## Slice hooks

### `useAcpRuntime` — `hooks/useAcpRuntime.ts:17`

Mounts the runtime singleton via `useMemo(() => ensureRuntime(),
[])` (line `:19`). The `useMemo` runs during render — no effect
needed because `ensureRuntime()` is idempotent and the
module-scope guard inside it is the StrictMode-safe seam.
Wraps `useVolumes({ volumeControl, onInitialVolumes })` — the
volumes hook is responsible for resolving the worker's `init`
payload by calling `runtime.resolveInit(initialMounts)`.

Returns `{ runtime, volumes }`.

### `useAcpAuth` — `hooks/useAcpAuth.ts:51`

Owns the auth observation + token rotation effects. Watches
Bodhi auth state (`useBodhi`) and:

- Computes the auth key via `acp/session-meta.ts:authKeyOf`.
- On change: calls `client.authenticate({ token, baseUrl })`
  inside the `getAuthPromise` dedupe + caches the auth key.
- On token rotation while a session is active (token A →
  token B with a non-null `getSession()`): re-issues
  `client.loadSession(sessionId, composedMcpServers,
  composeSessionMeta(...))` so the worker re-acquires MCP
  connections under the new fingerprint and reloads its
  inline-agent history. Gated on `mcpInstancesIsReady` —
  otherwise we'd compose with an empty server list and the
  worker pool would drop every connection.

`UseAcpAuthDeps` is the cross-hook plumbing bag. The slice
no longer mutates anyone else's state — it just touches
`runtime.client` and the runtime accessors. The model catalog
is no longer fetched here; it ships back via
`NewSessionResponse.models` /
`LoadSessionResponse.models`, consumed by `useAcpModels`.

### `useAcpModels` — `hooks/useAcpModels.ts:31`

Owns the per-tab model catalog state. Thin slice: state +
mutators + `hydrateFromSessionResponse` + the
`setSelectedModel` push.

| Returned value | Behaviour |
| --- | --- |
| `models: BodhiModelInfo[]` | The cached catalog (`{ id }` only — `apiFormat` plumbing dropped). |
| `selectedModel: string` | Active selection. |
| `setSelectedModel(id)` (`:35`) | Updates local state; if `getSession()` is set, calls `client.setSessionModel(sessionId, id)`, publishes the in-flight promise to `setModelUpdatePromise` so `useAcpStreaming.sendMessage` can await it before `prompt()`, and clears the promise on `finally`. Errors flow into `setError`. |
| `hydrateFromSessionResponse(state)` (`:59`) | Consumed by `useAcpSession.ensureSession` / `loadSession` after `NewSessionResponse` / `LoadSessionResponse` arrives. Maps `availableModels[].modelId → BodhiModelInfo[]`. Selects `state.currentModelId` if still in the list, else preserves the prior selection if still in the list, else picks the first available. |

There are no `loadModels` / `loadingModelsRef` /
`isLoadingModels` / `selectedApiFormat` / `applyLastModel`
returns anymore — model catalog hydration rides on
`SessionModelState` from the agent.

### `useAcpMcp` — `hooks/useAcpMcp.ts:50`

The MCP composition + toggle slice. Owns:

- `mcpToggles: McpToggleSnapshot` — current toggle state, reset
  on `clearMessages` / `loadSession`.
- `setMcpToggles(toggles)` — React setter exposed for
  `useAcpSession` to call after `loadSession` (full
  toggle-snapshot replace from the snapshot's
  `_meta.bodhi.mcpToggles`).
- `setMcpToggle(serverSlug, value, toolName?)` (`:161`) —
  single-key mutate via `client.setMcpToggle`. Server-level
  changes re-issue `client.loadSession` so the agent
  re-acquires under the new server set; per-tool changes
  trickle through to the next `prompt` turn since the pool is
  unchanged.
- `composeCurrentMcpServers(toggles?: McpToggleSnapshot)`
  (`:87`) — joins instance catalog + JWT + server-level
  toggle filter into the `McpServerHttp[]` payload
  `loadSession` expects. The token + `baseUrl` are read from
  `useBodhi`'s `auth.accessToken` and `bodhiClient.getState()`
  **inside the closure** — they are not parameters. Calls
  `compose-mcp-servers.ts:composeMcpServers` after the
  lookup.
- `dispatchAction(action, messages)` (`:143`) — proxies into
  `acp/builtin-dispatch.ts:dispatchBuiltinAction`, passing
  the live `triggerLoginWithRequested` closure.
  `triggerLoginWithRequested` (`:120`) calls `logout()` then
  `login(builder.build())` so Keycloak re-issues the
  authorization redirect with the updated MCP scopes (the
  Bodhi SDK's `login()` short-circuits on
  already-authenticated tokens, hence the explicit logout
  first).
- Refs (`mcpInstancesRef`, `mcpTogglesRef`,
  `requestedMcpUrlsRef`) — mutable views of the latest
  values, useful for `useAcpAuth` / `useAcpSession` callbacks
  that don't want a re-render dependency on a fast-changing
  object.

Boot effect (`:79`): loads `requested-mcps-store.ts:loadRequestedMcps()`
into `requestedMcpUrlsRef.current` once on mount.

### `useAcpSession` — `hooks/useAcpSession.ts:57`

Session lifecycle slice. Owns:

- `sessions: SessionInfoView[]` — the picker list (the
  flattened `SessionInfo + _meta.bodhi` shape from
  `AcpClient.listSessions`).
- `currentSessionId: string | null` — read via
  `useSyncExternalStore(subscribeToSession, getSession,
  getSession)` so external `setSession` calls (auth-loss
  effect, cancel path) repaint the picker without local
  mirror state.
- `isLoadingSession: boolean`.
- `refreshSessions()` (`:76`) — `client.listSessions` →
  state. Re-checks `isAuthenticated` after the await so a
  mid-flight auth-loss doesn't stamp a stale list.
- `ensureSession()` (`:108`) — returns the active session id,
  lazily creating one via `client.newSession` if absent.
  Concurrency-safe via the runtime's `getSessionPromise` /
  `setSessionPromise`. After resolution: dispatches
  `'config-options-init'` from `response.configOptions ?? []`,
  calls `hydrateModelsFromSessionResponse(response.models)`,
  and resets `mcpToggles` to `EMPTY_MCP_TOGGLES`.
- `loadSession(sessionId)` (`:182`) — full reload:
    1. Dispatch `'load-start'`.
    2. Close prior active session via
       `client.closeSession(prior)` so the agent releases MCP
       refcounts.
    3. **Pre-pass `client.getSession(sessionId)`** to read
       toggles before composing servers (TODO at `:208–210`
       tracks collapsing this round-trip — M5 deferred).
    4. `client.loadSession(sessionId, servers, sessionMeta)`.
    5. `setSession(sessionId)` + `setModelUpdatePromise(null)`
       (drop any in-flight set-model promise owned by the
       prior session).
    6. `setMcpToggles(toggles)`.
    7. Dispatch `'config-options-init'` from
       `loadResponse.configOptions ?? []`.
    8. Dispatch `'load-end'` with `snapshot.messages`.
    9. `hydrateModelsFromSessionResponse(loadResponse.models)`.
- `clearMessages()` (`:252`) — fire-and-forget
  `cancel + closeSession` for the active session, then
  `setSession(null)`, `setModelUpdatePromise(null)`,
  `setError(null)`, `setMcpToggles(EMPTY_MCP_TOGGLES)`,
  dispatch `'reset'`.
- `deleteSession(sessionId)` (`:267`) —
  `client.deleteSession`; if active, also `cancel` +
  `clearMessages` first. Fires `refreshSessions` in `finally`.

Boot effects (two separate `useEffect`s):

1. `refreshSessions()` runs unconditionally on mount and
   whenever its deps flip — the function itself gates on
   `isAuthenticated` internally and clears state on logout
   (lines `:96–106`).
2. The auto-`ensureSession` effect (`:155`) is gated on
   `isAuthenticated && !currentSessionId && mcpInstancesIsReady`
   and lazily creates a fresh session when the user is
   authenticated and the MCP catalog is ready but no
   `currentSessionId` exists yet. Awaits `getAuthPromise()`
   first so the session fetch doesn't race the
   `authenticate` round-trip.

Auth-loss teardown effect (`:297`): cancels any in-flight
prompt, clears `_session`, clears
`_modelUpdatePromise`. The `isAuthenticated ? X : EMPTY_*`
gating in the facade masks the rest of the UI on its own.

### `useAcpStreaming` — `hooks/useAcpStreaming.ts:33`

The prompt-turn loop + the unified `session/update` +
`extNotification` listener.

Single-effect listener pair (`:65–87`):

- `client.onSessionUpdate(notif => dispatch({ type:
  'session-update', notif }))`.
- `client.onExtNotification((method, params) => {...})` —
  routes:
  - `BODHI_MCP_STATE_NOTIFICATION_METHOD` →
    `parseMcpStateParams(params)` → dispatch `{ type:
    'mcp-state', meta }` (consumed by `panelsReducer`).
  - `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD` →
    `parseBuiltinActionParams(params)` → call the latest
    `dispatchActionRef.current(action, messagesRef.current)`.
    The refs (`messagesRef`, `dispatchActionRef`) are synced
    via plain `useEffect`s so the listener doesn't need to
    resubscribe on every dispatch identity churn.
  - Anything else → `console.warn`.

`sendMessage(prompt)` (`:89`):

1. Detect a built-in tag via `detectBuiltinTag` so the
   "no model selected" gate doesn't apply to built-ins
   (built-ins bypass the LLM agent-side).
2. `await getAuthPromise()` if one's pending (silent return
   on auth error — surfaced by the auth effect).
3. Build the user message (`userMessage(prompt)`),
   stamp the built-in tag if present.
4. `await ensureSession()`.
5. **Await `getModelUpdatePromise()` before `turn-start`** —
   so a model-update failure surfaces as an inline error
   instead of an orphan user message in the transcript.
6. Dispatch `'turn-start'` with the user message.
7. `await client.prompt(sessionId, prompt)` — two arguments;
   the agent reads the model from
   `SessionState.currentModelId`.
8. Dispatch `'turn-end'` with `response.stopReason ??
   'end_turn'`. **Note: the turn-end fold of
   `streamingMessage` happens inside the reducer** (no ref
   read here), closing a commit/effect race that the legacy
   ref-based fold exhibited.
9. `void refreshSessions()` to keep the picker in sync.

`stop()` (`:144`) — `client.cancel(sessionId)` for the
active session.

`clearError()` — `setError(null)`.

### `useVolumes` — `hooks/useVolumes.ts`

Volume hook called from `useAcpRuntime`. Documented in
[`volumes.md`](./volumes.md) § hook surface.

## StrictMode + HMR invariants

- **Singleton survival.** `acp/runtime.ts:ensureRuntime`
  reads / writes `_runtime` at module scope. StrictMode's
  double-mount calls `ensureRuntime()` twice; the second
  call returns the cached value. Vite HMR preserves module
  state. `useAcpRuntime` calls `ensureRuntime` from a
  `useMemo` so the worker spawn happens during render rather
  than after-effect — a deliberate choice that hands the SDK a
  live `ClientSideConnection` synchronously, before any child
  effect tries to subscribe to it.
- **Per-tab session id.** Same pattern: `let _session` at
  module scope. `useAcpSession` reads it on every effect, so
  a hook re-mount sees the existing session rather than
  creating a duplicate. `useSyncExternalStore` gives the
  picker a re-render hook into the singleton.
- **Auth promise dedup.** `getAuthPromise` /
  `setAuthPromise` hold the in-flight `authenticate` work;
  concurrent slice hooks `await` the same promise rather
  than racing.
- **Model-update promise mutex.** `setSelectedModel` writes
  the in-flight `setSessionModel` promise to
  `setModelUpdatePromise`; `sendMessage` awaits
  `getModelUpdatePromise()` before `prompt`. `loadSession`
  and `clearMessages` clear the slot so a stale promise from
  a closed session can't bleed into the next one.

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
  `panelsReducer`, `dispatchBuiltinAction`,
  `parseMcpStateParams`, `parseBuiltinActionParams`).
- Storage adapters:
  [`storage-dexie.md`](./storage-dexie.md).
- Volume hook detail:
  [`volumes.md`](./volumes.md) § hook surface.
- MCP catalog + composer:
  [`mcp.md`](./mcp.md).
- Features UI surface (inline `useAcp` slice + FeaturePanel):
  [`features.md`](./features.md).
- Browser-host startup walk-through:
  [`startup-sequence.md`](./startup-sequence.md).
