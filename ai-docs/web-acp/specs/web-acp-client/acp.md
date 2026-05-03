# Host-side ACP wire layer

**Source of truth:** `packages/web-acp/src/acp/`.

## Purpose

The browser host's half of the ACP boundary: a `ClientSideConnection`
wrapper, the per-tab runtime singleton, the streaming-state
reducer, the host-side built-in action dispatcher, the `fs/*`
IDE-integration handlers, plus the wire constants the host
exports for downstream consumers.

This is **not** the engine — the engine ships with
`@bodhiapp/web-acp-agent`. This file documents only the
client-side surface that observes ACP wire events and drives
the host UI; see [`../web-acp-agent/acp.md`](../web-acp-agent/acp.md)
for the agent half.

## Files

```
packages/web-acp/src/acp/
├── index.ts             # SDK re-exports + Bodhi method constants + wire types
├── methods.ts           # _bodhi/* method-name barrel (mirrors agent's wire/index.ts)
├── client.ts            # AcpClient — main-thread ClientSideConnection wrapper
├── runtime.ts           # AcpRuntime singleton + per-tab session/auth state
├── streaming-reducer.ts # Pure reducer for session/update + turn lifecycle
├── builtin-dispatch.ts  # dispatchBuiltinAction (copy / mcp-add / mcp-remove)
├── fs-handlers.ts       # fs/readTextFile + fs/writeTextFile handlers (IDE seam)
├── permissions.ts       # session/request_permission stub (deferred)
├── message-shape.ts     # Empty/get/withAssistantText helpers, builtin tag, MCP meta
├── session-meta.ts      # authKeyOf, toBodhiModelInfo, composeSessionMeta
└── wire-utils.ts        # Helpers (extractSessionMeta, filterHttpServers, …)
```

## `AcpClient` — `acp/client.ts:44`

Main-thread wrapper over `@agentclientprotocol/sdk`'s
`ClientSideConnection`. Exposes the narrow set of methods
`useAcp` actually uses; transport plumbing (ports, NDJSON)
lives one layer up in [`transport.md`](./transport.md).

Constructor takes a `ClientSideConnection`. Members:

| Member | Behaviour |
| --- | --- |
| `signal` | Forwards `conn.signal` for callers that want to react to disconnect. |
| `closed` | Forwards `conn.closed`. |
| `initialize()` | Calls `conn.initialize` with `protocolVersion: 1` and `clientCapabilities.fs = { readTextFile: true, writeTextFile: true }`. The `fs` capability advertises the IDE-integration seam; built-in `bash` never uses it. |
| `authenticate({ token, baseUrl })` | `conn.authenticate({ methodId: BODHI_AUTH_METHOD_ID, _meta: { token, baseUrl } })`. |
| `listModels()` | `conn.extMethod(BODHI_LIST_MODELS_METHOD, {})` → `BodhiModelDescriptor[]`. |
| `listSessions()` | `conn.extMethod(BODHI_LIST_SESSIONS_METHOD, {})` → `BodhiSessionSummary[]`. |
| `newSession(mcpServers, sessionMeta?)` | `conn.newSession({ cwd: '/', mcpServers: toMcpServers(mcpServers), _meta?.bodhi })`. |
| `loadSession(sessionId, mcpServers, sessionMeta?)` | Same shape, `conn.loadSession`. |
| `getSession(sessionId)` | `conn.extMethod(BODHI_GET_SESSION_METHOD, { sessionId })`. |
| `deleteSession(sessionId)` | `conn.extMethod(BODHI_SESSIONS_DELETE_METHOD, { sessionId })` → `boolean` (idempotent on missing). |
| `listVolumes()` | `conn.extMethod(BODHI_VOLUMES_LIST_METHOD, {})`. |
| `listFeatures(sessionId)` / `setFeature(sessionId, key, value)` | `_bodhi/features/list` / `_bodhi/features/set`. |
| `setMcpToggle(sessionId, serverSlug, value, toolName?)` | `_bodhi/mcp/toggles/set`. Server-level when `toolName` is `undefined`. |
| `prompt(sessionId, text, modelId)` | `conn.prompt({ sessionId, prompt: [{ type: 'text', text }], _meta: { bodhi: { modelId } } })`. |
| `cancel(sessionId)` | `conn.cancel({ sessionId })`. |
| `onSessionUpdate(listener)` | Subscribes to `session/update` notifications; returns the unsubscribe fn. |
| `dispatchSessionUpdate(notification)` | Public entry the outer `Client` handler calls when a `session/update` arrives — fans out to listeners. |

Helper `toMcpServers(servers)` (`:210`) coerces composed
`McpServerHttp[]` entries into the wire-shape `McpServer`
union with `type: 'http' as const`.

`buildClientHandler(client)` (`:214`) builds the SDK's
`Client` callback shape; `useAcp` and `acp/runtime.ts` use a
holder pattern instead because `ClientSideConnection`
constructs the handler synchronously, *before* the `AcpClient`
exists. See `acp/runtime.ts:ensureRuntime` for the live
wiring.

## `AcpRuntime` singleton — `acp/runtime.ts`

Module-scope per-tab state. **One worker per tab**, regardless
of how many `useAcp()` consumers mount. StrictMode's
double-mount and React fast-refresh both re-enter the effect
but never spawn a second worker.

`AcpRuntime` interface (`:18`):

```ts
interface AcpRuntime {
    worker: Worker;
    client: AcpClient;
    volumeControl: VolumeControl;
    mainZenfs: MainZenfs;
    initialize: Promise<void>;
    resolveInit: (volumes: HostVolumeInit[]) => void;
}
```

`ensureRuntime()` (`:34`):

1. Returns existing `_runtime` if set.
2. Spawn the Worker (`new Worker(new URL('../agent/agent-worker.ts', import.meta.url), { type: 'module' })`).
3. Create a `MessageChannel`. Hold `port2` for the worker; use `port1` on the main thread.
4. Build a deferred `init` posting via `resolveInit`. The worker `postMessage({ type: 'init', agentPort: port2, volumes }, [port2])` is **not** sent until `useVolumes` resolves the initial volume list. Without this defer, the `ClientSideConnection` would dispatch requests into a worker that hasn't built the agent yet.
5. Wrap `port1` via `createMessagePortStream`. Frame with `ndJsonStream`.
6. Build the `Client` handler with the holder pattern. The `fs/*` handlers come from `acp/fs-handlers.ts:buildFsHandlers({ view: { list: () => mainZenfs.list() } })` — the *main thread* ZenFS mirror is the source of truth for IDE-integration reads.
7. Construct `ClientSideConnection(() => handler, stream)` and the `AcpClient` wrapper.
8. Build the `volumeControl` via `wrapVolumeControl(createVolumeControl(worker), mainZenfs)` — the wrapper mirrors mount/unmount onto `MainZenfs` so `fs/*` handlers stay in sync.
9. Cache + return `_runtime`.

Per-tab session/auth state lives at module scope alongside
the runtime — a deliberate choice so HMR / StrictMode
double-mounts observe the same identity. Accessor pairs:

| Pair | Purpose |
| --- | --- |
| `getSession` / `setSession` | Active session id (string \| null). |
| `getSessionPromise` / `setSessionPromise` | In-flight `ensureSession` promise (deduped concurrent calls). |
| `getAuthKey` / `setAuthKey` | Most-recent `authKeyOf` result; rotation invalidates the model cache. |
| `getAuthPromise` / `setAuthPromise` | In-flight authenticate / list-models promise. |
| `getAuthModels` / `setAuthModels` | Cached `BodhiModelDescriptor[]` from `listModels`. |

Each accessor is a one-line getter/setter against a `let` —
keeps the API testable while preserving reference identity
across re-renders.

`wrapVolumeControl` (`:96`) is the host-side decorator that
forwards every mount/unmount to the worker (authoritative)
*and* to `MainZenfs` (mirror). Worker-side mount errors fail
the call; main-thread mount errors are logged but never
surfaced — the handler falls back to the membership check
inside `fs-handlers.ts` on every call.

## `streamingReducer` — `acp/streaming-reducer.ts`

Pure reducer over the `session/update` notifications. State
shape (`:28`):

```ts
interface StreamingState {
    messages: AgentMessage[];           // committed turns
    streamingMessage: AgentMessage | undefined;
    streamingMessageId: string | undefined;
    toolCalls: Map<string, ToolCallView>;
    turnIndex: number;
    isStreaming: boolean;
    isReplaying: boolean;
    availableCommands: readonly AvailableCommand[];
    mcpStates: Record<string, McpConnectionMeta>;
}
```

Actions (`:52`):

- `'turn-start'` — append the user message, clear streaming, mark in-flight.
- `'turn-end'` — append `finalMessage` (unless `stopReason === 'cancelled'`), clear streaming, bump `turnIndex`.
- `'load-start'` — clear streaming, set `isReplaying: true` (suppresses live notifications during `loadSession` replay).
- `'load-end'` — `isReplaying: false`. With `messages`: full snapshot replace (used after `getSession` rebuild). Without: just clear the flag.
- `'session-update'` — full notification dispatch (see below).
- `'reset'` — reset everything except `availableCommands` / `mcpStates` empties (preserve frozen identities).

The `'session-update'` path (`applySessionUpdate`, `:129`):

1. **MCP meta** — if `_meta.bodhi.mcp` set via
   `extractMcpMeta`, route into `state.mcpStates`. Bypasses
   the replay guard.
2. **`available_commands_update`** — replace
   `state.availableCommands`. Bypasses the replay guard so
   the freshest list always wins.
3. **Replay guard** — `if (state.isReplaying) return state` —
   live updates during `loadSession` replay are dropped on
   the floor; the reducer relies on the `'load-end'` action
   to deliver the rebuilt snapshot.
4. **`agent_message_chunk`** — accumulate per-`messageId`. The
   delta-vs-cumulative contract is documented in
   [`../web-acp-agent/acp.md`](../web-acp-agent/acp.md) §
   prompt-driver. Snippet:

```ts
// streaming-reducer.ts:162–185
if (update.sessionUpdate === 'agent_message_chunk') {
    const content = update.content;
    if (!content || content.type !== 'text') return state;
    const delta = content.text ?? '';
    if (!delta) return state;

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

5. **`tool_call`** — insert into `toolCalls` keyed by
   `toolCallId` with `status: 'in_progress'` (or `'pending'`
   when ACP says so).
6. **`tool_call_update`** — patch the existing entry's status
   + `text` (rendered via `toolCallContentText`) +
   `rawOutput`.

`useAcpStreaming` is the single place driving the reducer
with these actions; see [`hooks.md`](./hooks.md).

## `dispatchBuiltinAction` — `acp/builtin-dispatch.ts:43`

Host-side dispatcher for the optional `action` carried on a
built-in's reply (`_meta.bodhi.builtin.action`). Switches on
`action.kind`:

| Kind | Behaviour |
| --- | --- |
| `'copy'` | `dispatchCopyAction(messages)` — `renderConversationMarkdown(messages)` (skips builtin entries) → `navigator.clipboard.writeText`. Toast on success / failure. |
| `'mcp-add'` | `addRequestedMcp(action.params.url)` (`mcp/requested-mcps-store.ts`) — IDB write. On `canonical === null` → toast error. On `!added` → toast info "already requested". On success → `triggerLogin(list)` to re-trigger Bodhi auth with the updated list. |
| `'mcp-remove'` | Symmetric: `removeRequestedMcp(url)`. |

`triggerLogin` is a `LoginTrigger = (urls: string[]) =>
Promise<void>`. The host hook closes over `useBodhi`'s
`login` / `logout` pair and injects the trigger so the
dispatcher stays React-free + testable.

## `buildFsHandlers` — `acp/fs-handlers.ts:55`

Host-side handlers for ACP's `fs/readTextFile` and
`fs/writeTextFile`. Advertised in M2.3 as the
**IDE-integration seam**: the built-in `bash` tool never
calls these (it talks to the agent's `VolumeFileSystem`
directly); the handlers exist for *external* ACP agents that
want to reach the same mounted bytes through the protocol.

Path safety (mirrors OS-level checks):

1. **Absolute under `/mnt/`.** Anything else rejects.
2. **Mount membership.** First segment after `/mnt/` must
   match a registered mount.
3. **POSIX normalisation.** `..` resolved against the mount
   root; reject if the result escapes the mount.
4. **Symlink canonicalisation.** `fs.promises.realpath`
   collapses symlinks; reject if the canonical path leaves
   the mount.

Deps: `view: VolumeRegistryView` (a `list()` projection of
the mount registry) and an injectable `fsImpl: FsLike`
(defaults to the shared `@zenfs/core` module singleton —
the `MainZenfs` mirror).

Returns `Required<Pick<Client, 'readTextFile' |
'writeTextFile'>>` — the handler pair `ensureRuntime` plugs
into the SDK's `Client` callback.

## `permissions.ts:requestPermissionStub`

Mirrors the agent-side stub; co-located so the host can
inject it directly into the `Client` callback without an
extra import path. Returns `{ outcome: { allow: true } }`
unconditionally — see [`../web-acp-agent/acp.md`](../web-acp-agent/acp.md)
§ permissions for the deferred plan.

## Constants + types — `acp/index.ts`, `acp/methods.ts`

`acp/index.ts` re-exports the SDK constants the host needs
(`Agent`, `Client`, `AvailableCommand`, `LoadSessionRequest`,
`LoadSessionResponse`, etc.) and **duplicates** every
Bodhi-specific wire constant + type already exported from
`@bodhiapp/web-acp-agent/wire`:

- Method names: `BODHI_AUTH_METHOD_ID`,
  `BODHI_LIST_MODELS_METHOD`, `BODHI_LIST_SESSIONS_METHOD`,
  `BODHI_GET_SESSION_METHOD`, `BODHI_VOLUMES_LIST_METHOD`,
  `BODHI_FEATURES_LIST_METHOD`,
  `BODHI_FEATURES_SET_METHOD`,
  `BODHI_MCP_TOGGLES_SET_METHOD`,
  `BODHI_SESSIONS_DELETE_METHOD`.
- Request / response shapes: `BodhiAuthenticateMeta`,
  `BodhiModelDescriptor`, `BodhiListModelsResponse`,
  `BodhiSessionSummary`, `BodhiListSessionsResponse`,
  `BodhiGetSessionRequest/Response`,
  `BodhiVolumesListResponse`,
  `BodhiFeaturesListResponse`,
  `BodhiFeaturesSetRequest/Response`,
  `BodhiMcpToggleSnapshot`,
  `BodhiMcpTogglesSetRequest/Response`,
  `BodhiSessionsDeleteRequest/Response`.
- Discriminated-union family:
  `BodhiBuiltinAction<K, P>`, `BodhiBuiltinCopyAction`,
  `BodhiBuiltinMcpAddAction`, `BodhiBuiltinMcpRemoveAction`,
  `AnyBodhiBuiltinAction`, `BodhiBuiltinMeta`,
  `BodhiBuiltinTag`.
- `BodhiMcpInstanceDescriptor`, `BodhiSessionMeta`.

**Note:** this duplication is benign tech debt — both copies
are identical and will collapse into a re-export from the
agent package as a follow-up cleanup. The host module names
the constants locally so downstream consumers depending on
`@/acp` don't have to know about the agent package boundary
yet.

`acp/methods.ts` exists as a slimmer re-export barrel; not
all consumers need the full `index.ts` payload.

## Wire helpers — `acp/wire-utils.ts`, `message-shape.ts`, `session-meta.ts`

Pure functions for shaping wire payloads + composing helpers
the React layer consumes. Notable exports:

- `wire-utils.ts:extractSessionMeta` (mirrors agent-side; used
  when constructing a host-side session reload).
- `wire-utils.ts:filterHttpServers` (host re-export of the
  same helper — keeps the host independent of the agent
  package).
- `wire-utils.ts:toAvailableCommand` — `CommandDef →
  AvailableCommand`.
- `wire-utils.ts:makeBuiltinUserMessage` /
  `makeBuiltinAssistantMessage` — construct the in-memory
  AgentMessage with `_builtin` metadata for `getSession` replay.
- `message-shape.ts:emptyAssistantMessage`,
  `getAssistantText`, `withAssistantText` — drive the
  streaming-reducer accumulation.
- `message-shape.ts:extractMcpMeta`, `mapToolStatus`,
  `toolCallContentText` — `session/update` decode helpers.
- `session-meta.ts:authKeyOf({ token, baseUrl })` — stable
  cache key for token-rotation detection.
- `session-meta.ts:toBodhiModelInfo` — wire descriptor →
  internal model info shape.
- `session-meta.ts:composeSessionMeta(requestedMcpUrls,
  mcpInstances)` — builds the `_meta.bodhi` envelope passed
  on `newSession` / `loadSession`.

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
