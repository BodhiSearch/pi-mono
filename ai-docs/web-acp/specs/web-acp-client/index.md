# web-acp-client

**Source of truth:** `packages/web-acp/src/`.

**Status:** living document — update as part of any plan that
changes the source folder. The browser host shipped post-M4
phase B as the **reference application** for
`@bodhiapp/web-acp-agent`: a Vite + React + Web Worker bundle
that mounts the agent inside a worker, renders the chat UI,
and persists per-tab state to IndexedDB / FSA.

The package is the future extraction target for a host-runtime
library (working name `@bodhiapp/bodhi-web-acp` — settled at
M8). Today it ships as the reference app.

## Purpose

`packages/web-acp/` is the browser half of the split. It owns:

- **The Vite entry + React app** (`App.tsx`, `main.tsx`, the
  `components/` tree).
- **The host-side ACP wire layer** at `acp/` — `AcpClient`
  (main-thread `ClientSideConnection` wrapper), the per-tab
  `AcpRuntime` singleton, the pure `streamingReducer`, the new
  `panelsReducer` for cross-turn UI state (commands, MCP
  state, configOptions), the host-side `dispatchBuiltinAction`,
  plus the frozen empty sentinels and the feature-key ↔ configId
  mapping. The deferred permission stub and the `fs/*`
  IDE-integration handlers were removed in the "adaptive plum"
  simplification — see
  `ai-docs/plans/some-thoughts-on-the-adaptive-plum.md`.
- **The Worker boot shim** at `agent/agent-worker.ts` — opens
  Dexie, builds the FSA volume registry, constructs the
  `BodhiProvider` + inline agent + Dexie stores, and calls
  `startAcpAgent` from the agent package.
- **The host-runtime adapters** under `runtime/`:
  - `runtime/storage-dexie/` — Dexie/IndexedDB implementations
    of the agent's `SessionStore`, `FeatureStore`,
    `McpToggleStore` interfaces.
  - `runtime/transport/worker-stream.ts` — `MessagePort` ↔
    `ReadableStream`/`WritableStream` byte-stream bridge.
  - `runtime/volumes-fsa/` — `HostVolumeInit` (FSA handle |
    seed) → agent's `VolumeInit` conversion via
    `toAgentVolumeInit`, plus the worker-side
    `attachVolumeChannel` listener and the main-thread
    `createVolumeControl` client for the volume-control
    raw-postMessage sidechannel.
- **The vault layer** at `vault/` — `idb-keyval`-backed FSA
  handle persistence. The duplicate main-thread `MainZenfs`
  mount was removed when `fs/*` was dropped.
- **The MCP main-thread surface** at `mcp/` — Bodhi catalog
  fetching (`useMcpInstances`), the pure
  `compose-mcp-servers` join, the requested-MCPs IDB
  wishlist, the `McpPanel` UI, and the URL canonicaliser.
- **The React hook layer** at `hooks/` — `useAcp` (thin
  facade) + seven per-concern slice hooks
  (`useAcp{Runtime,Auth,Models,Mcp,Session,Streaming}`,
  `useVolumes`). The per-session feature toggles are read
  inline inside `useAcp` from `panelsState.configOptions`;
  there is **no** dedicated `useAcpFeatures` slice anymore.

## Hard constraints

- **Consumes the agent package; does not re-implement the
  engine.** No copies of `AcpAgentAdapter`,
  `assembleServices`, `BodhiProvider`, `InlineAgent`,
  `createBashTool`, vault command code, MCP runtime code, the
  per-session feature config registry, `McpConnectionPool`,
  ZenFS volume registry, or the engine layer. Anything
  host-neutral lives in `@bodhiapp/web-acp-agent`. CI grep
  guards: every legacy path (`@/agent/session-store`,
  `@/agent/bodhi-provider`, `@/acp/engine`, `@/agent/commands`,
  `@/agent/mcp`, `@/features/*`, `@/transport/*`) must return
  zero hits.
- **No direct Bodhi auth-server contact.** OAuth 2.1 + PKCE +
  token rotation are owned by `@bodhiapp/bodhi-js-react`; the
  client observes `auth.accessToken` + `bodhiClient.getState()`
  and passes credentials to the worker via
  `client.authenticate({ token, baseUrl })`.
- **Browser-only deps allowed.** `@zenfs/dom` (FSA backend),
  `dexie` + `dexie-react-hooks`, `idb-keyval`, `react`,
  `radix-ui` + shadcn/ui, etc. The worker bundle is a
  Vite-generated module Worker.
- **One worker per tab.** `acp/runtime.ts:ensureRuntime` holds
  the singleton at module scope; React StrictMode and HMR
  re-enter the effect but never spawn a second worker.

## Public surface

`web-acp` does not yet export a public barrel — it is still
the reference app embedding the agent package. The files that
will form the **host-runtime** library boundary when this
package is extracted (M8) are:

### `acp/index.ts` (host-side wire barrel)

`acp/index.ts` holds explicit re-exports (no wildcards). The
host has one canonical source of truth for the Bodhi wire
surface — every other file in the host imports through this
barrel rather than directly from `@bodhiapp/web-acp-agent`.

- **Local frozen empty sentinels** (defined in
  `acp/empty-sentinels.ts`) — `EMPTY_AVAILABLE_COMMANDS`,
  `EMPTY_CONFIG_OPTIONS`, `EMPTY_MCP_STATES`,
  `EMPTY_MCP_TOGGLES`. Identity equality (`===`) is the
  contract so React reducers + memo selectors bail out when a
  slice hasn't changed.
- **Re-exports from `@bodhiapp/web-acp-agent`** (constants):
  `BODHI_AUTH_METHOD_ID`,
  `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`,
  `BODHI_FEATURE_BASH_ENABLED_CONFIG_ID`,
  `BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID`,
  `BODHI_MCP_STATE_NOTIFICATION_METHOD`,
  `BODHI_MCP_TOGGLES_SET_METHOD`,
  `BODHI_SESSIONS_DELETE_METHOD`.
- **Re-exports from `@bodhiapp/web-acp-agent`** (types):
  `BodhiAuthenticateMeta`, `AnyBodhiBuiltinAction`,
  `BodhiBuiltinTag`, `BodhiLoadSessionMeta`,
  `BodhiMcpInstanceDescriptor`, `BodhiMcpTogglesSetResponse`,
  `BodhiSessionInfoMeta`, `BodhiSessionMeta`,
  `BodhiSessionsDeleteResponse`.
- **Local view shape** (defined here):
  `SessionInfoView { id, title, createdAt, updatedAt,
  turnCount, lastModelId }` — the flattened
  `SessionInfo + _meta.bodhi` projection with numeric
  timestamps, returned by `AcpClient.listSessions`.
- **Not re-exported.** Legacy constants
  (`BODHI_LIST_MODELS_METHOD`, `BODHI_LIST_SESSIONS_METHOD`,
  `BODHI_FEATURES_LIST_METHOD`, `BODHI_FEATURES_SET_METHOD`,
  `BODHI_FEATURE_CONFIG_CATEGORY` —
  the latter is consumed only by the agent package). Legacy
  types (`BodhiListModelsResponse`, `BodhiModelDescriptor`,
  `BodhiListSessionsResponse`, `BodhiFeatureBag`,
  `BodhiFeaturesListResponse`, `BodhiFeaturesSetRequest`,
  `BodhiFeaturesSetResponse`, `BodhiBuiltinMeta`). Most SDK
  types — call sites import directly from
  `@agentclientprotocol/sdk`. The barrel does **not** re-export
  `AgentSideConnection`, `ClientSideConnection`,
  `ndJsonStream`, or the SDK request/response shapes.

### Other host-runtime modules

- `acp/client.ts` — `AcpClient`.
- `acp/runtime.ts` — `AcpRuntime`, `ensureRuntime`, plus
  per-tab session/auth/model-update accessors (`getSession`,
  `setSession`, `subscribeToSession`, `getSessionPromise`,
  `setSessionPromise`, `getAuthKey`, `setAuthKey`,
  `getAuthPromise`, `setAuthPromise`,
  `getModelUpdatePromise`, `setModelUpdatePromise`,
  `getInitResponse`). The `_modelUpdatePromise` slot is the
  "model-swap before next prompt" mutex
  `useAcpStreaming.sendMessage` awaits before issuing
  `prompt`. There is **no** `getAuthModels`/`setAuthModels`
  accessor — the catalog ships back via
  `NewSessionResponse.models` /
  `LoadSessionResponse.models` instead.
- `acp/streaming-reducer.ts` — `streamingReducer`,
  `StreamingState`, `StreamingAction`, plus the
  `initialStreamingState` constant (a single frozen object).
  Owns per-turn slices only: `messages`, `selectedModel`,
  `streamCursor`, `streamingMessageId`, `inFlight`, `error`.
- `acp/panels-reducer.ts` — **NEW.** `panelsReducer`,
  `PanelsState`, `PanelsAction`, `initialPanelsState`. Owns
  cross-turn slices: `availableCommands`, `mcpStates`,
  `configOptions`. Defaults are the frozen empty sentinels
  for stable React identity.
- `acp/empty-sentinels.ts` — **NEW.** Frozen empty defaults
  re-exported from `acp/index.ts`.
- `acp/feature-keys.ts` — **NEW.**
  `FEATURE_KEY_BY_CONFIG_ID` /
  `FEATURE_KEY_TO_CONFIG_ID` mapping helpers and the
  `FeatureBag = Record<string, boolean>` alias used by the
  inline `useAcp` features slice.
- `acp/builtin-dispatch.ts` — `dispatchBuiltinAction`,
  `dispatchCopyAction`.
- `acp/{message-shape,session-meta}.ts` —
  host-side helpers (one-liners listed in
  [`acp.md`](./acp.md)). Lower-level wire helpers come from
  `@bodhiapp/web-acp-agent`; there is no host-side
  `wire-utils.ts` and no longer a host-side `methods.ts`
  (constants ride `acp/index.ts` directly).
- `agent/agent-worker.ts` — `AgentWorkerInitMessage` + the
  Worker boot shim that calls `startAcpAgent` from the agent
  package.
- `runtime/storage-dexie/` — Dexie-backed `SessionStore` /
  `FeatureStore` / `McpToggleStore` impls satisfying the
  agent package's interfaces, plus the `SessionStoreDb` Dexie
  v3 schema.
- `runtime/volumes-fsa/` — `HostVolumeInit`, `VolumeSeed`,
  `toAgentVolumeInit`, `attachVolumeChannel`,
  `createVolumeControl` (and the volume-control wire types).
- `runtime/transport/worker-stream.ts` —
  `createMessagePortStream`, `PortByteStream`.

## Folder layout

```
packages/web-acp/src/
├── App.tsx, App.test.tsx, App.css, main.tsx, env.ts, index.css, vite-env.d.ts
├── acp/                       # Host-side ACP wire layer
│   ├── index.ts               # explicit barrel: empty sentinels + Bodhi constants/types + SessionInfoView
│   ├── client.ts              # AcpClient — main-thread ClientSideConnection wrapper
│   ├── runtime.ts             # AcpRuntime singleton + per-tab session/auth/model-update state
│   ├── empty-sentinels.ts     # frozen EMPTY_* defaults (===-stable for React)
│   ├── feature-keys.ts        # FEATURE_KEY_BY_CONFIG_ID / *_TO_CONFIG_ID + FeatureBag alias
│   ├── streaming-reducer.ts   # per-turn reducer (messages, cursor, selectedModel, inFlight)
│   ├── panels-reducer.ts      # cross-turn reducer (availableCommands, mcpStates, configOptions)
│   ├── builtin-dispatch.ts    # dispatchBuiltinAction (copy / mcp-add / mcp-remove) + dispatchCopyAction
│   ├── message-shape.ts       # parseMcpStateParams, parseBuiltinActionParams, message helpers
│   └── session-meta.ts        # authKeyOf, composeSessionMeta
│                                # (lower-level wire helpers come from @bodhiapp/web-acp-agent — no host-side wire-utils.ts / methods.ts)
├── agent/
│   └── agent-worker.ts        # Web Worker entry — calls startAcpAgent from agent package
├── runtime/                   # Host adapters satisfying agent-package interfaces
│   ├── storage-dexie/         # Dexie/IndexedDB SessionStore/FeatureStore/McpToggleStore impls
│   │   ├── db.ts              # SessionStoreDb (v3 schema)
│   │   ├── session-store.ts   # createSessionStore / createStoreFromDb
│   │   ├── feature-store.ts   # createFeatureStore
│   │   ├── mcp-toggle-store.ts # createMcpToggleStore
│   │   └── index.ts           # barrel
│   ├── volumes-fsa/           # FSA-backed volume host (handle ↔ agent VolumeInit)
│   │   ├── types.ts           # HostVolumeInit + VolumeSeed
│   │   ├── backends.ts        # toAgentVolumeInit() — host shape → agent VolumeInit
│   │   ├── volume-channel.ts  # worker-side raw-postMessage mount/unmount listener
│   │   ├── volume-control.ts  # main-thread client for the volume-control channel
│   │   └── index.ts           # barrel
│   └── transport/
│       └── worker-stream.ts   # MessagePort ↔ ReadableStream/WritableStream bridge
├── mcp/                       # Main-thread MCP surface
│   ├── types.ts               # McpInstanceView, McpConnectionState, McpConnectionMeta
│   ├── useMcpInstances.ts     # React hook over bodhiClient.mcps.list()
│   ├── compose-mcp-servers.ts # pure compose(instances, jwt, baseUrl, toggles?)
│   ├── requested-mcps-store.ts # IndexedDB-backed wishlist of requested MCP URLs
│   ├── url-canonical.ts       # canonicalizeMcpUrl helper (mirrors agent package)
│   └── McpPanel.tsx           # status chips + per-server/per-tool toggle UI (checkboxes)
├── vault/
│   ├── fsa-handle-store.ts    # idb-keyval-backed FSA handle persistence + permission re-grant
├── hooks/
│   ├── useAcp.ts              # Thin facade composing the slice hooks + inline features memo
│   ├── useAcpRuntime.ts       # ensureRuntime + useVolumes wrapper
│   ├── useAcpAuth.ts          # Bodhi auth observation + token rotation (no model fetch)
│   ├── useAcpModels.ts        # selectedModel, ensureDefaultModel, applyLastModel via setSessionModel
│   ├── useAcpMcp.ts           # mcpToggles, composeCurrentMcpServers, dispatchAction
│   ├── useAcpSession.ts       # ensureSession, loadSession, clearMessages, deleteSession
│   ├── useAcpStreaming.ts     # session/update + extNotification listener + sendMessage/stop
│   └── useVolumes.ts          # FSA handle resolution + dev-seed merge + add/remove/restore
├── components/                # shadcn/ui (`ui/*` — 12 files) + Header/Layout/StatusIndicator + chat/{BashToolCall,ChatDemo,ChatInput,ChatMessages,CommandPicker,MessageBubble,ModelCombobox,SessionPicker}.tsx + volumes/{VolumeRow,VolumesPanel}.tsx + features/FeaturePanel.tsx + mcp/McpPanel.tsx
├── test/
│   └── setup.ts               # vitest setup script (no fake-indexeddb here — see storage-dexie.md § Test fixtures)
├── lib/
│   ├── bodhi-models.ts        # BodhiModelInfo { id } — apiFormat plumbing dropped
│   ├── agent-model.ts         # Model selection helpers
│   ├── builtin-format.ts      # Markdown rendering for /help, /version, /info, /mcp
│   └── utils.ts               # General utilities (cn, …)
└── types/
    └── chat.ts                # UI-level types (ChatMessage, etc.)
```

The split under `src/` is deliberate: `acp/` (host-side wire),
`agent/agent-worker.ts` (boot shim), and `runtime/` form the
host-runtime layer that wires `@bodhiapp/web-acp-agent` to the
browser. `hooks/`, `components/`, `lib/`, `mcp/`, `vault/`, and
`types/` are the reference-app surface that stays here when the
host-runtime becomes its own package at M8.

## Global guarantees & invariants

1. **One worker per tab.** `acp/runtime.ts:ensureRuntime`
   holds the worker, client, `volumeControl`, and `initialize`
   promise at module scope; StrictMode's double-mount and React
   fast-refresh both re-enter the effect but never spawn a
   second worker. Detail in [`hooks.md`](./hooks.md).
2. **One-shot `init`.** The worker accepts exactly one
   `{type: 'init', agentPort, volumes}` message; subsequent
   inits are logged and ignored. Detail in
   [`transport.md`](./transport.md).
3. **ACP-only across the agent boundary.** After the `init`
   transfer, the `MessageChannel` carries nothing but
   `ndJsonStream`-framed JSON-RPC. The volume-control channel
   uses raw `postMessage` on the worker global scope (FSA
   handles aren't JSON-serialisable) and is documented as a
   separate sidechannel.
4. **Bodhi specifics stay inside `@bodhiapp/web-acp-agent`'s
   `BodhiProvider` + `bodhi-token` auth method.** The host
   forwards tokens via `client.authenticate(...)` and never
   talks to an OAuth server itself.
5. **Structured-clone safety.** `MessagePort` payloads are
   `Uint8Array` chunks; `worker-stream.ts:createMessagePortStream`
   allocates a fresh buffer per chunk and transfers it.
6. **Reducer split.** Per-turn state lives in
   `streamingReducer`; cross-turn UI panel state
   (`availableCommands`, `mcpStates`, `configOptions`) lives in
   `panelsReducer`. Each reducer's defaults use the frozen
   `EMPTY_*` sentinels so React selectors can `===`-bail.
7. **Model swap mutex.** `useAcpModels.setSelectedModel` writes
   `_modelUpdatePromise` before issuing
   `client.setSessionModel`; `useAcpStreaming.sendMessage`
   awaits it before `client.prompt(sessionId, text)`. Without
   this, a quick model change followed by a send could prompt
   under the old session model.
8. **Chat UI contract is `data-test-state`-driven.** Every
   stateful component exposes a `data-testid` for selection
   and `data-test-state="…"` for state assertions
   (`mounted | mounting | error` on volumes,
   `running | completed | failed` on tool-call bubbles, etc.).
   Playwright never relies on `waitForTimeout`.

## Navigation

| File | Scope |
| --- | --- |
| [`transport.md`](./transport.md) | `runtime/transport/worker-stream.ts:createMessagePortStream` (MessagePort ↔ stream bridge) + the worker-control sidechannel rationale + `agent/agent-worker.ts` boot wiring. |
| [`acp.md`](./acp.md) | Host-side ACP wire/engine split — `acp/client.ts:AcpClient`, `acp/runtime.ts:ensureRuntime`, `acp/streaming-reducer.ts`, `acp/panels-reducer.ts`, `acp/empty-sentinels.ts`, `acp/feature-keys.ts`, `acp/builtin-dispatch.ts`, plus helpers under `acp/{message-shape,session-meta,index}.ts`. The `requestPermission` field on the `Client` handler is a one-line cancelled-outcome stub inlined in `runtime.ts` (no shared module). The `fs/*` IDE-integration seam was removed — `clientCapabilities: {}`. |
| [`hooks.md`](./hooks.md) | `hooks/useAcp.ts` (facade with inline features memo) + the seven slice hooks (`useAcp{Runtime,Auth,Models,Mcp,Session,Streaming}`, `useVolumes`). StrictMode/HMR invariants. |
| [`storage-dexie.md`](./storage-dexie.md) | `runtime/storage-dexie/db.ts:SessionStoreDb` + `createStoreFromDb`, `createFeatureStore`, `createMcpToggleStore`. Schema v3, migration discipline. |
| [`volumes.md`](./volumes.md) | `runtime/volumes-fsa/{types,backends,volume-channel,volume-control}.ts` + `vault/fsa-handle-store.ts` + `hooks/useVolumes.ts`. FSA handle ↔ agent `VolumeInit` conversion + worker-side mount/unmount sidechannel. The duplicate main-thread `MainZenfs` mount that mirrored the worker's ZenFS for `fs/*` was removed. Dev-seed test pattern unchanged. |
| [`mcp.md`](./mcp.md) | `mcp/{types,useMcpInstances,compose-mcp-servers,requested-mcps-store,url-canonical}.ts` + `mcp/McpPanel.tsx`. Main-thread catalog + composer + `_bodhi/mcp/state` extNotification routing + UI checkboxes. Worker-side runtime lives in the agent package. |
| [`commands.md`](./commands.md) | `components/chat/CommandPicker.tsx` (palette UI) + `lib/builtin-format.ts` (markdown rendering for built-in replies) + the `_meta.bodhi.builtin` envelope consumed in `streamingReducer` + the `_bodhi/builtin/action` extNotification → `dispatchBuiltinAction` route. |
| [`features.md`](./features.md) | The inline `useAcp` features memo over `panelsState.configOptions` + `setFeature` calling `client.setSessionConfigOption` + `components/features/FeaturePanel.tsx` (UI). DEV gate (`import.meta.env.DEV`) for `forceToolCall` paired with the agent-side `isDev` enforcement. |
| [`startup-sequence.md`](./startup-sequence.md) | Browser-host startup walk-through: React mount → `useAcpRuntime` → `ensureRuntime` (`useMemo`) → Worker spawn → MessageChannel → FSA volume resolution → `init` post → `startAcpAgent` (cross-link to agent's startup-sequence) → `useAcpAuth` token push → Phase 5 first prompt → reducer-driven streaming. |

## Sibling host runtime

The Node TTY CLI at `packages/cli-acp-client/` consumes the
same agent package but with an in-memory `TransformStream`
duplex transport, in-memory store implementations, and a
`PassthroughFS`-backed `$cwd` volume. Spec at
[`../cli-acp-client/index.md`](../cli-acp-client/index.md). The
agent code consumed by both hosts is byte-identical; only the
transport adapter and services bag differ.

## Change procedure

Any plan that modifies files under `packages/web-acp/src/`
MUST include an explicit task to update the matching topic
file(s) in this folder. State that task in the plan, not as a
follow-up. When the surface is unchanged (pure internal
refactor), state that explicitly in the plan rather than
skipping the check.

Editing checklist:

1. Identify which topic file(s) cover the affected code.
2. Update content in the same commit as the code change.
3. If a new module is added (e.g. an alternate transport, a
   new host-side hook), create a new topic file or extend the
   relevant one and link it from this `index.md`.
4. If a topic file becomes dead (a module is deleted), remove
   the file and update navigation.

See repo `CLAUDE.md § Functional specs` for the hard rule.
