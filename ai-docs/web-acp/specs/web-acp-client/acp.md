# Host-side ACP wire layer

**Source of truth:** `packages/web-acp/src/acp/`.

## Purpose

The browser host's half of the ACP boundary: a
`ClientSideConnection` wrapper, the per-tab runtime singleton,
the streaming-state reducer, the panels reducer for cross-turn
UI state, the host-side built-in action dispatcher, plus the
wire constants the host exports for downstream consumers.

The `fs/*` IDE-integration handlers and the dedicated
`requestPermissionStub` module were both removed in the
"adaptive plum" simplification — see
`ai-docs/plans/some-thoughts-on-the-adaptive-plum.md`. The
SDK still requires `Client.requestPermission` so `runtime.ts`
inlines a one-line cancelled-outcome stub.

This is **not** the engine — the engine ships with
`@bodhiapp/web-acp-agent`. This file documents only the
client-side surface that observes ACP wire events and drives
the host UI; see [`../web-acp-agent/acp.md`](../web-acp-agent/acp.md)
for the agent half.

## Files

```
packages/web-acp/src/acp/
├── index.ts             # explicit barrel: empty sentinels + Bodhi constants/types + SessionInfoView
├── client.ts            # AcpClient — main-thread ClientSideConnection wrapper
├── runtime.ts           # AcpRuntime singleton + per-tab session/auth/model-update state
├── empty-sentinels.ts   # frozen EMPTY_* defaults — ===-stable for React selectors
├── feature-keys.ts      # FEATURE_KEY_BY_CONFIG_ID / *_TO_CONFIG_ID + FeatureBag alias
├── streaming-reducer.ts # per-turn slice (messages, cursor, toolCalls)
├── panels-reducer.ts    # cross-turn slice (availableCommands, mcpStates, configOptions)
├── builtin-dispatch.ts  # dispatchBuiltinAction (copy / mcp-add / mcp-remove) + dispatchCopyAction
├── message-shape.ts     # parseMcpStateParams, parseBuiltinActionParams, message helpers
└── session-meta.ts      # authKeyOf, composeSessionMeta
                         # (low-level wire helpers re-imported from @bodhiapp/web-acp-agent — no host-side wire-utils.ts / methods.ts)
```

## `AcpClient` — `acp/client.ts:37`

Main-thread wrapper over `@agentclientprotocol/sdk`'s
`ClientSideConnection`. Exposes the narrow set of methods the
host hooks actually use; transport plumbing (ports, NDJSON)
lives one layer up in [`transport.md`](./transport.md).

Constructor takes a `ClientSideConnection`. Members:

| Member | Line | Behaviour |
| --- | --- | --- |
| `signal` | `:46` | Forwards `conn.signal` for callers that want to react to disconnect. |
| `closed` | `:50` | Forwards `conn.closed`. |
| `initialize()` | `:54` | Calls `conn.initialize` with `protocolVersion: PROTOCOL_VERSION` and `clientCapabilities: {}`. Architecture is agent-owned filesystem (volumes mount inside the worker); the `fs/*` IDE seam was dropped. Logs a `console.warn` when the agent advertises a different protocol version. |
| `authenticate({ token, baseUrl })` | `:73` | `conn.authenticate({ methodId: BODHI_AUTH_METHOD_ID, _meta: { token, baseUrl } })`. |
| `setSessionModel(sessionId, modelId)` | `:80` | Wraps `conn.unstable_setSessionModel({ sessionId, modelId })`. The agent updates `SessionState.currentModelId` (see agent's [`acp.md`](../web-acp-agent/acp.md) § handlers). |
| `listSessions()` | `:85` | Wraps SDK's `Agent.listSessions({})` and **flattens** each `SessionInfo` + `_meta.bodhi` into a `SessionInfoView` with numeric timestamps (`updatedAt = Date.parse(info.updatedAt)`, `createdAt`/`turnCount`/`lastModelId` read from `_meta.bodhi`). The picker UI consumes the flat shape. |
| `newSession(mcpServers, sessionMeta?)` | `:101` | `conn.newSession({ cwd: '/', mcpServers: toMcpServers(mcpServers), _meta?.bodhi })`. Returns the SDK `NewSessionResponse` (carries `models?` + `configOptions`). |
| `closeSession(sessionId)` | `:113` | `conn.closeSession({ sessionId })` — releases in-memory resources; the persisted row remains for `loadSession`. The runtime's `pagehide`/`beforeunload` hook calls this for the active session. |
| `loadSession(sessionId, mcpServers, sessionMeta?)` | `:117` | Same shape, `conn.loadSession`. Returns the SDK `LoadSessionResponse` (carries `models?`, `configOptions`, `_meta.bodhi.{title, mcpToggles}`). |
| `getSession(sessionId)` | `:130` | `conn.extMethod(BODHI_GET_SESSION_METHOD, { sessionId })` → `BodhiGetSessionResponse`. Used after `loadSession` to rebuild the muted-builtin transcript. |
| `deleteSession(sessionId)` | `:142` | `conn.extMethod(BODHI_SESSIONS_DELETE_METHOD, { sessionId })` → `boolean`. Idempotent on missing rows. |
| `listVolumes()` | `:148` | `conn.extMethod(BODHI_VOLUMES_LIST_METHOD, {})` → `BodhiVolumeDescriptor[]`. |
| `setSessionConfigOption(sessionId, configId, value)` | `:154` | Wraps SDK's `conn.setSessionConfigOption({ sessionId, configId, value })`. The host always sends the stable `'on'` / `'off'` string schema; the agent accepts a legacy boolean too. See [`features.md`](./features.md). |
| `setMcpToggle(sessionId, serverSlug, value, toolName?)` | `:164` | `conn.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, { sessionId, serverSlug, toolName?, value })`. Server-level when `toolName` is `undefined`. |
| `prompt(sessionId, text)` | `:179` | `conn.prompt({ sessionId, prompt: [{ type: 'text', text }] })`. Two arguments — model selection rides `setSessionModel` per session, **not** `_meta.bodhi.modelId`. |
| `cancel(sessionId)` | `:186` | `conn.cancel({ sessionId })`. |
| `onSessionUpdate(listener)` | `:190` | Subscribes to `session/update` notifications; returns the unsubscribe fn. |
| `dispatchSessionUpdate(notification)` | `:199` | Public entry the outer `Client` handler in `runtime.ts` calls when a `session/update` arrives — fans out to listeners. Catches each listener's exception so a buggy subscriber can't break the dispatch. |
| `onExtNotification(listener)` | `:209` | Subscribes to `extNotification` callbacks. Returns the unsubscribe fn. |
| `dispatchExtNotification(method, params)` | `:214` | Symmetric to `dispatchSessionUpdate` for ext notifications. The runtime's `Client.extNotification` callback (`runtime.ts:66`) forwards to this. |

Helper `toMcpServers(servers)` (`:229`) coerces composed
`McpServerHttp[]` entries into the wire-shape `McpServer`
union with `type: 'http' as const`.

The `dispatchSessionUpdate` / `dispatchExtNotification`
forwarding pattern uses a `holder.client` reference because
`ClientSideConnection` constructs its `Client` callback
**synchronously** in the `runtime.ts:ensureRuntime` body —
before `AcpClient` exists. The `holder` is mutated on the
following line so when the SDK eventually invokes the
callback (asynchronously, after `init` lands), `holder.client`
points at the live wrapper.

## `AcpRuntime` singleton — `acp/runtime.ts`

Module-scope per-tab state. **One worker per tab**, regardless
of how many `useAcp()` consumers mount. StrictMode's
double-mount and React fast-refresh both re-enter the
`useAcpRuntime` effect but never spawn a second worker.

`AcpRuntime` interface (`:14`):

```ts
interface AcpRuntime {
    worker: Worker;
    client: AcpClient;
    volumeControl: VolumeControl;
    initialize: Promise<void>;
    resolveInit: (volumes: HostVolumeInit[]) => void;
}
```

`ensureRuntime()` (`:34`):

1. Returns existing `_runtime` if set.
2. Spawn the Worker (`new Worker(new URL('../agent/agent-worker.ts',
   import.meta.url), { type: 'module' })`).
3. Create a `MessageChannel`. Hold `port2` for the worker; use
   `port1` on the main thread.
4. Build a deferred `init` posting via `resolveInit`. The
   worker `postMessage({ type: 'init', agentPort: port2,
   volumes }, [port2])` is **not** sent until `useVolumes`
   resolves the initial volume list. Without this defer, the
   `ClientSideConnection` would dispatch requests into a worker
   that hasn't built the agent yet.
5. Wrap `port1` via `createMessagePortStream`. Frame with
   `ndJsonStream`.
6. Build the `Client` handler with the holder pattern.
   The handler exposes:
   - `requestPermission` — one-line cancelled-outcome stub
     (SDK requires the field; agent never invokes it).
   - `sessionUpdate(params)` →
     `holder.client?.dispatchSessionUpdate(params)`.
   - `extNotification(method, params)` →
     `holder.client?.dispatchExtNotification(method, params)`.
7. Construct `ClientSideConnection(() => handler, stream)` and
   the `AcpClient` wrapper.
8. Chain `initialize = initPromise.then(() =>
   client.initialize()).then(resp => { _initResponse = resp;
   })` so the `InitializeResponse` is available globally for
   any reader that needs `agentCapabilities`.
9. Build the `volumeControl` via `createVolumeControl(worker)`
   — forwards FSA-handle-bearing mount/unmount requests to the
   worker over a raw-postMessage sidechannel (FSA handles aren't
   JSON-serialisable so they can't ride the ACP wire).
10. Cache + return `_runtime`.
11. **Tab-close hook** (`:91`) — best-effort `pagehide` +
    `beforeunload` listener that fires
    `client.closeSession(_session)` when a session is active.
    Fire-and-forget — the message may not round-trip through
    bfcache.

`useAcpRuntime` (in `hooks/useAcpRuntime.ts`) calls
`ensureRuntime()` from a `useMemo` so the worker spawn happens
during render rather than after-effect — see
[`hooks.md`](./hooks.md) for the StrictMode rationale.

Per-tab session/auth/model-update state lives at module scope
alongside the runtime — a deliberate choice so HMR /
StrictMode double-mounts observe the same identity. Accessor
pairs:

| Pair | Lines | Purpose |
| --- | --- | --- |
| `getSession` / `setSession` | `:139`/`:143` | Active session id (string \| null). Setter notifies `subscribeToSession` listeners synchronously. |
| `subscribeToSession` | `:157` | `useSyncExternalStore`-shaped listener registration. |
| `getSessionPromise` / `setSessionPromise` | `:164`/`:168` | In-flight `ensureSession` promise (deduped concurrent calls). |
| `getAuthKey` / `setAuthKey` | `:172`/`:176` | Most-recent `authKeyOf` result; rotation invalidates cached state. |
| `getAuthPromise` / `setAuthPromise` | `:180`/`:184` | In-flight `authenticate` promise. |
| `getModelUpdatePromise` / `setModelUpdatePromise` | `:188`/`:192` | "Model swap before next prompt" mutex. `useAcpModels.setSelectedModel` writes the in-flight `setSessionModel` promise here; `useAcpStreaming.sendMessage` awaits it before issuing `prompt` so the agent sees the new `currentModelId` before the turn starts. |
| `getInitResponse` | `:196` | Returns the cached `InitializeResponse` from Phase 2. Used by hooks that need to read `agentCapabilities` (e.g. checking `loadSession` before offering the picker). |

There is **no** `getAuthModels` / `setAuthModels` accessor —
the model catalog now ships back via
`NewSessionResponse.models` / `LoadSessionResponse.models`
(`SessionModelState`) and `useAcpSession` consumes those
directly.

Each accessor is a one-line getter/setter against a `let` —
keeps the API testable while preserving reference identity
across re-renders.

`volumeControl` is the host-side `createVolumeControl(worker)`
client for the worker's mount/unmount sidechannel.
`dispose()` detaches the `MessagePort` listener and rejects
every pending mount/unmount. Mount errors propagate to the
caller; the previous `MainZenfs` mirror layer was removed.

## Empty sentinels — `acp/empty-sentinels.ts`

Frozen identity sentinels reused everywhere a slice can be
"empty". Identity equality (`===`) is the contract — React's
`useMemo` / `useReducer` selectors bail out when a panel
hasn't changed, and the panels reducer's `'reset'` case checks
`state.availableCommands === EMPTY_AVAILABLE_COMMANDS` to
avoid building a redundant new state object.

| Constant | Type | Used by |
| --- | --- | --- |
| `EMPTY_AVAILABLE_COMMANDS` | `readonly AvailableCommand[]` | `panelsReducer` initial state + `'reset'` short-circuit. |
| `EMPTY_MCP_STATES` | `Record<string, McpConnectionMeta>` | `panelsReducer` initial state. |
| `EMPTY_CONFIG_OPTIONS` | `readonly SessionConfigOption[]` | `panelsReducer` initial state + `'config_option_update'` arm fallback. |
| `EMPTY_MCP_TOGGLES` | `McpToggleSnapshot` | `useAcpMcp` default toggle snapshot. |

Re-exported from `acp/index.ts` for downstream consumers.

## Feature-key mapping — `acp/feature-keys.ts`

Tiny bridge between ACP `configId` strings (
`'_bodhi/features/bashEnabled'`,
`'_bodhi/features/forceToolCall'`) and the internal feature
keys (`'bashEnabled'`, `'forceToolCall'`):

- `FEATURE_KEY_BY_CONFIG_ID` — `Record<string, string>` (keyed
  by configId). Used by the inline `useAcp` features memo to
  translate `configOptions` into a `FeatureBag` for UI
  consumption.
- `FEATURE_KEY_TO_CONFIG_ID` — inverse. Used by `setFeature`
  to translate the UI's feature key back to the wire configId
  before calling `client.setSessionConfigOption`.
- `FeatureBag = Record<string, boolean>` — the alias the
  facade exposes.

The constants the table references come from `acp/index.ts`
(re-exported from `@bodhiapp/web-acp-agent`).

## `streamingReducer` — `acp/streaming-reducer.ts`

Pure reducer over the **per-turn** slice of state. Does **not**
own panel state (`availableCommands`, `mcpStates`,
`configOptions`) — those live in `panelsReducer` (next
section) so they survive `'reset'` and replay.

State shape (`:31`):

```ts
interface StreamingState {
    messages: AgentMessage[];           // committed turns
    streamingMessage: AgentMessage | undefined;
    streamingMessageId: string | undefined;
    toolCalls: Map<string, ToolCallView>;
    turnIndex: number;
    isStreaming: boolean;
    isReplaying: boolean;
}
```

`isReplaying` lives in state (not a ref) so the guard observes
synchronously with each notification — without that, a stray
late chunk between `loadSession` resolving and the `'load-end'`
dispatch could leak into the rebuilt transcript.

Actions are shared with `panelsReducer` via the
`AcpAction` union (`:52`):

- `'turn-start'` — append the user message, clear streaming,
  mark in-flight.
- `'turn-end'` — fold the in-flight `streamingMessage` into
  `messages` (unless `stopReason === 'cancelled'` — discards
  the partial), clear streaming, bump `turnIndex`. The fold
  closes the commit/effect race where the caller would have
  read a stale ref.
- `'load-start'` — set `isReplaying: true`.
- `'load-end'` — `isReplaying: false`. With `messages`: full
  snapshot replace (used after `getSession` rebuild). Without:
  just clear the flag.
- `'session-update'` — full notification dispatch (see below).
- `'config-options-init'` and `'mcp-state'` — **no-ops** in
  this reducer. They route to `panelsReducer`. Listed here
  rather than dropped so the dispatcher can fan a single
  action to both reducers.
- `'reset'` — reset to `initialStreamingState` with a fresh
  empty `Map` for `toolCalls`.

`applySessionUpdate(state, notification)` (`:119`):

1. **Panel-owned kinds bail early** — `available_commands_update`
   and `config_option_update` return `state` unchanged so the
   default-warning stays narrow (those kinds reach
   `panelsReducer` instead).
2. **Replay guard** — `if (state.isReplaying) return state` —
   live updates during `loadSession` replay are dropped on
   the floor; the reducer relies on the `'load-end'` action
   to deliver the rebuilt snapshot.
3. **`agent_message_chunk`** — accumulate per-`messageId`. The
   delta-vs-cumulative contract is documented in
   [`../web-acp-agent/acp.md`](../web-acp-agent/acp.md) §
   prompt-driver. The host extracts the optional
   `_meta.bodhi.builtin` tag via
   `lib/builtin-format.ts:extractBuiltinMeta` and stamps it
   onto the message via `withBuiltinTag` so the bubble renders
   muted. Snippet:

```ts
// streaming-reducer.ts:133–155
case 'agent_message_chunk': {
    const content = update.content;
    if (!content || content.type !== 'text') return state;
    const delta = content.text ?? '';
    if (!delta) return state;

    const builtinMeta = extractBuiltinMeta(notification._meta);
    const messageId = update.messageId ?? undefined;
    let streamingMessage = state.streamingMessage;
    let streamingMessageId = state.streamingMessageId;
    if (messageId && messageId !== streamingMessageId) {
        streamingMessageId = messageId;
        streamingMessage = emptyAssistantMessage();
    }
    const current = streamingMessage ?? emptyAssistantMessage();
    const nextText = getAssistantText(current) + delta;
    let next = withAssistantText(current, nextText);
    const carriedTag = builtinMeta ?? getBuiltinTag(current);
    if (carriedTag) next = withBuiltinTag(next, carriedTag);
    return { ...state, streamingMessage: next, streamingMessageId };
}
```

4. **`tool_call`** — insert into `toolCalls` keyed by
   `toolCallId` with `status: 'in_progress'` (or `'pending'`
   when ACP says so).
5. **`tool_call_update`** — patch the existing entry's status
   + `text` (rendered via `toolCallContentText`) +
   `rawOutput`.
6. **Accepted-but-not-yet-rendered kinds**
   (`user_message_chunk`, `agent_thought_chunk`, `plan`,
   `current_mode_update`, `session_info_update`,
   `usage_update`) bail out explicitly so the default
   `console.warn` only fires for truly-unknown kinds.

## `panelsReducer` — `acp/panels-reducer.ts`

Pure reducer over the **cross-turn** slice of state. Owned
separately so panels survive `'reset'` (which clears the
chat) and stay populated through `loadSession` rehydration.

State shape (`:16`):

```ts
interface PanelsState {
    availableCommands: readonly AvailableCommand[];
    mcpStates: Record<string, McpConnectionMeta>;
    configOptions: readonly SessionConfigOption[];
}
```

`initialPanelsState` (`:22`) seeds all three slices to the
frozen `EMPTY_*` sentinels.

Action handling (`:32`):

- `'reset'` — drops `availableCommands` only (since the agent
  re-emits `available_commands_update` on every `session/new`
  / `session/load`). Returns the same state instance when the
  slice is already at the empty sentinel — that's the
  React-bailout invariant.
- `'config-options-init'` — replaces `configOptions` with the
  payload (used by `useAcpSession` after a fresh
  `NewSessionResponse` / `LoadSessionResponse` ships
  `configOptions`).
- `'mcp-state'` — patches `mcpStates[meta.server]` with the
  new `McpConnectionMeta`.
- `'session-update'` with kind `available_commands_update` —
  replaces the slice; falls back to `EMPTY_AVAILABLE_COMMANDS`
  for empty payloads. **Bypasses the streaming reducer's
  replay guard** so panels stay in sync during `session/load`
  rehydration.
- `'session-update'` with kind `config_option_update` —
  replaces `configOptions`; same empty-payload fallback.
- All other actions return the same state instance.

`useAcp` runs both reducers from a single
`React.useReducer(streamingReducer, initialStreamingState)` +
`React.useReducer(panelsReducer, initialPanelsState)` pair and
fans every action through both. The `===`-bailout invariant on
`panelsReducer` means non-panel actions don't trigger a
re-render of consumers that select from `panelsState`.

## `dispatchBuiltinAction` — `acp/builtin-dispatch.ts:43`

Host-side dispatcher for the optional `action` carried on a
built-in's reply. The action no longer rides on the chunk's
`_meta.bodhi.builtin.action` slot — it arrives via the
`_bodhi/builtin/action` extNotification and is parsed by
`message-shape.ts:parseBuiltinActionParams` before reaching
this dispatcher.

Switches on `action.kind`:

| Kind | Behaviour |
| --- | --- |
| `'copy'` | Calls `dispatchCopyAction(messages)` (extracted at `:18` so other code paths can copy without going through the dispatcher) — `renderConversationMarkdown(messages)` (skips builtin entries) → `navigator.clipboard.writeText`. Toast on success / failure. |
| `'mcp-add'` | `addRequestedMcp(action.params.url)` (`mcp/requested-mcps-store.ts`) — IDB write. On `canonical === null` → toast error. On `!added` → toast info "already requested". On success → `triggerLogin(list)` to re-trigger Bodhi auth with the updated list. |
| `'mcp-remove'` | Symmetric: `removeRequestedMcp(url)`. |

`triggerLogin` is a `LoginTrigger = (urls: string[]) =>
Promise<void>`. The host hook closes over `useBodhi`'s
`login` / `logout` pair and injects the trigger so the
dispatcher stays React-free + testable.

## fs/* and permissions — removed

`fs-handlers.ts` (the `fs/readTextFile` + `fs/writeTextFile`
IDE-integration seam) and `permissions.ts` (the
`requestPermissionStub` re-export) were both deleted in the
"adaptive plum" simplification. `clientCapabilities` is now
`{}` — the architecture is agent-owned filesystem (volumes
mount inside the worker; the bash tool reads/writes through
them directly), and the deferred permission bridge will return
as a coherent end-to-end feature when product-ready. See
`ai-docs/plans/some-thoughts-on-the-adaptive-plum.md` and
`ai-docs/web-acp/milestones/deferred.md`.

## Constants + types — `acp/index.ts`

Explicit re-export barrel (no wildcards). Three groups:

- **Local frozen empty sentinels** (defined in
  `acp/empty-sentinels.ts`) — `EMPTY_AVAILABLE_COMMANDS`,
  `EMPTY_CONFIG_OPTIONS`, `EMPTY_MCP_STATES`,
  `EMPTY_MCP_TOGGLES`.
- **Re-exports from `@bodhiapp/web-acp-agent`** (constants):
  `BODHI_AUTH_METHOD_ID`,
  `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`,
  `BODHI_FEATURE_BASH_ENABLED_CONFIG_ID`,
  `BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID`,
  `BODHI_GET_SESSION_METHOD`,
  `BODHI_MCP_STATE_NOTIFICATION_METHOD`,
  `BODHI_MCP_TOGGLES_SET_METHOD`,
  `BODHI_SESSIONS_DELETE_METHOD`,
  `BODHI_VOLUMES_LIST_METHOD`.
- **Re-exports from `@bodhiapp/web-acp-agent`** (types):
  `BodhiAuthenticateMeta`, `AnyBodhiBuiltinAction`,
  `BodhiBuiltinTag`, `BodhiGetSessionResponse`,
  `BodhiMcpInstanceDescriptor`, `BodhiMcpTogglesSetResponse`,
  `BodhiSessionInfoMeta`, `BodhiSessionMeta`,
  `BodhiSessionsDeleteResponse`, `BodhiVolumeDescriptor`,
  `BodhiVolumesListResponse`.
- **Local view shape** — `SessionInfoView { id, title,
  createdAt, updatedAt, turnCount, lastModelId }` returned by
  `AcpClient.listSessions`.

The barrel does **not** re-export legacy `BODHI_LIST_MODELS_METHOD`
/ `BODHI_LIST_SESSIONS_METHOD` / `BODHI_FEATURES_*_METHOD`,
nor the legacy types around them — they're gone from the
agent's wire surface entirely. The barrel does **not**
re-export SDK symbols (`AgentSideConnection`,
`ClientSideConnection`, `ndJsonStream`, request/response
shapes); call sites import those directly from
`@agentclientprotocol/sdk`.

There is no longer a separate `acp/methods.ts` — constants
ride `acp/index.ts` directly.

## Wire helpers — `message-shape.ts`, `session-meta.ts` (+ agent-package re-exports)

Pure functions for shaping wire payloads + composing helpers
the React layer consumes. The lower-level wire helpers
(`extractSessionMeta`, `filterHttpServers`, `toAvailableCommand`,
`toolTitle`, `toToolCallContent`, `toWireMcpToggles`,
`extractAssistantText`, `extractMessageId`,
`makeBuiltinUserMessage`, `makeBuiltinAssistantMessage`) live
agent-side and are re-imported from `@bodhiapp/web-acp-agent`
when needed — the host does not duplicate them.

Host-only helpers in `message-shape.ts`:

- `parseMcpStateParams(params)` (`:6`) — defensively coerces
  the `_bodhi/mcp/state` extNotification params into a
  `McpConnectionMeta { server, state, error?, tools? }`.
  Returns `undefined` for malformed payloads (server not a
  string, state not in the known set) so the
  `useAcpStreaming` ext-notification listener can no-op rather
  than crash. Logs a warning on unknown state values.
- `parseBuiltinActionParams(params)` (`:111`) — defensively
  coerces the `_bodhi/builtin/action` extNotification params
  into an `AnyBodhiBuiltinAction`. Validates `kind` ∈
  `{ 'copy', 'mcp-add', 'mcp-remove' }` and per-kind
  `params.url: string` shape; returns `undefined` otherwise so
  non-Bodhi agents speaking the same protocol can't crash
  `dispatchBuiltinAction`.
- `emptyAssistantMessage` / `getAssistantText` /
  `withAssistantText` / `userMessage` — drive the
  streaming-reducer accumulation.
- `detectBuiltinTag(text)` — mirrors the worker's `/<name>`
  prefix rule via the agent package's `isBuiltinName` so the
  user bubble's tag matches what `tryHandleBuiltin` would
  detect.
- `toolCallContentText`, `mapToolStatus` — `session/update`
  decode helpers.

`session-meta.ts`:

- `authKeyOf(token, baseUrl)` (`:4`) — stable cache key for
  token-rotation detection. Used by `useAcpAuth` to decide
  whether the active session needs re-`loadSession`.
- `composeSessionMeta(requestedMcpUrls, instances)` (`:15`) —
  builds the `BodhiSessionMeta` payload (`requestedMcpUrls`
  plus the projected `BodhiMcpInstanceDescriptor[]`). Returns
  `undefined` when both inputs are empty so the wire frame
  stays compact for vanilla sessions.

There is no host-side `toBodhiModelInfo` helper anymore — the
catalog ships pre-flattened from the agent on
`NewSessionResponse.models` /
`LoadSessionResponse.models` and `useAcpSession` consumes the
SDK's `SessionModelState` directly.

## Cross-references

- Agent-side wire shim + engine layer:
  [`../web-acp-agent/acp.md`](../web-acp-agent/acp.md).
- The hook layer that consumes this:
  [`hooks.md`](./hooks.md).
- Browser-host startup flow:
  [`startup-sequence.md`](./startup-sequence.md).
- Built-in command formatter:
  `lib/builtin-format.ts` — covered in
  [`commands.md`](./commands.md).
- `_bodhi/mcp/state` extNotification + the panel routing:
  [`mcp.md`](./mcp.md).
- `_bodhi/builtin/action` extNotification + the dispatcher
  routing: [`commands.md`](./commands.md).
