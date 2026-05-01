# acp

**Source of truth:**
`packages/web-acp-agent/src/acp/` — agent-side wire shim
(`agent-adapter.ts`), engine layer (`engine/{services,session-runtime,
prompt-driver,builtin-dispatch,types}.ts` + `engine/ext-methods/*.ts`),
`permissions.ts`, and `wire-utils.ts`.
`packages/web-acp/src/acp/` — browser host's wire/engine split
(`runtime.ts`, `streaming-reducer.ts`, `builtin-dispatch.ts`,
`fs-handlers.ts`, `permissions.ts`, `client.ts`, `agent-adapter.ts`
re-export shim during transition, `message-shape.ts`, `methods.ts`,
`session-meta.ts`).
`packages/cli-acp-client/src/acp/` — Node host's equivalent
(`embedded-host.ts` boot, `client.ts` mirroring the browser's
`AcpClient`, `duplex.ts` in-memory byte-stream pair).

**Parent:** [`./index.md`](./index.md)

> **Note (post agent-package extraction).** When this file says
> e.g. "the adapter does X" or cites `agent-adapter.ts` /
> `engine/...`, those files live in
> `packages/web-acp-agent/src/acp/`. Host-side files
> (`runtime.ts`, `streaming-reducer.ts`, etc.) live in
> `packages/web-acp/src/acp/`. The wire surface is identical
> across hosts.

## Functional scope

The `src/acp/` subtree holds the ACP wire surface and the
Bodhi-specific extensions layered on top of the
`@agentclientprotocol/sdk@0.17.0` primitives. After the engine-split
refactor the layout is:

- **`index.ts`** — SDK re-exports + the Bodhi-specific constants
  (`BODHI_AUTH_METHOD_ID`, `BODHI_LIST_MODELS_METHOD`,
  `BODHI_LIST_SESSIONS_METHOD`, `BODHI_GET_SESSION_METHOD`,
  `BODHI_VOLUMES_LIST_METHOD`, `BODHI_FEATURES_*`,
  `BODHI_MCP_TOGGLES_SET_METHOD`, `BODHI_SESSIONS_DELETE_METHOD`) +
  the `_meta` shapes that travel alongside ACP's standard payloads.
- **`client.ts`** — `AcpClient`, a thin wrapper over
  `ClientSideConnection` that `useAcp` consumes on the main thread.
- **`agent-adapter.ts`** — `AcpAgentAdapter`, the
  `Agent`-interface implementation that runs inside the Web
  Worker. **Wire shim only** (~245 LoC); every method body
  delegates into the engine layer.
- **`wire-utils.ts`** — pure functions that translate between ACP
  wire shapes and internal types: `extractSessionMeta`,
  `filterHttpServers`, `toWireMcpToggles`, `toAvailableCommand`,
  `toolTitle`, `toToolCallContent`, `extractAssistantText`,
  `extractMessageId`, `makeBuiltinUserMessage`,
  `makeBuiltinAssistantMessage`. No class state, no I/O.
- **`engine/`** — the engine layer (services / runtime / driver /
  dispatch). See "Engine layer" subsection below.
- **`fs-handlers.ts`** — main-thread `fs/readTextFile` /
  `fs/writeTextFile` handlers used by the IDE-integration seam (M2).
  Not part of the engine layer; covered in [`./vault.md`](./vault.md).

Scope invariants:

- **ACP is the only wire protocol.** The adapter's deviations
  from stock ACP are the `bodhi-token` auth method (advertised via
  the standard `authMethods` response array) and the three
  extension methods `bodhi/listModels` + `bodhi/listSessions` +
  `bodhi/getSession` (served via `Agent.extMethod`, a standard SDK
  escape hatch). Session-scoped `_meta` on `session/prompt`
  carries the selected model id. `bodhi/listSessions` is used in
  preference to the upstream `session/list` because the latter
  lives under the SDK's `schema.unstable.json` surface; this repo
  only consumes the stable schema (see [`./index.md`](./index.md)).
  `bodhi/getSession` is a condensed "snapshot" sibling to the
  stable `session/load` request — `session/load` streams stored
  notifications back verbatim (per ACP) while `bodhi/getSession`
  returns the collapsed last-turn transcript + `lastModelId` in a
  single reply, which is what the UI actually needs to rehydrate
  the React state tree. Both paths read from the same
  `SessionStore`, so they cannot disagree. M2 adds three more
  extension methods under the spec-blessed `_`-prefix:
  `_bodhi/volumes/list`, `_bodhi/features/list`, and
  `_bodhi/features/set`. The older `bodhi/*` methods keep the
  pre-spec prefix so the M0/M1 client contracts don't churn; a
  unified rename is tracked as a deferred cleanup item.
- **The Bodhi constants are defined once.** `acp/index.ts` is the
  single source; `client.ts` and `agent-adapter.ts` import from it.
  `useAcp` never inlines any of the string literals.
- **No framing here.** Byte-stream plumbing lives in
  [`./transport.md`](./transport.md). Worker spawn lives in
  [`./agent.md`](./agent.md).

## Technical reference

### `acp/index.ts`

Public surface:

- `AgentSideConnection`, `ClientSideConnection`, `ndJsonStream`
  — re-exported from the SDK so every other module imports them
  through the same path.
- Type re-exports: `Agent`, `Client`, `AuthenticateRequest`,
  `AuthenticateResponse`, `CancelNotification`,
  `InitializeRequest`, `InitializeResponse`, `NewSessionRequest`,
  `NewSessionResponse`, `PromptRequest`, `PromptResponse`,
  `SessionNotification`, `StopReason`.
- `BODHI_AUTH_METHOD_ID = 'bodhi-token'` — the auth method id
  advertised in `initialize` and echoed back in
  `AuthenticateRequest.methodId`.
- `BODHI_LIST_MODELS_METHOD = 'bodhi/listModels'` — the extension
  method id consumed by `conn.extMethod(...)`.
- `BODHI_LIST_SESSIONS_METHOD = 'bodhi/listSessions'` — the
  extension method id for picker feed (M1).
- `BODHI_GET_SESSION_METHOD = 'bodhi/getSession'` — the extension
  method id for the snapshot read consumed by `useAcp.loadSession`
  after a successful `session/load` (M1).
- `BODHI_VOLUMES_LIST_METHOD = '_bodhi/volumes/list'` — read-only
  introspection of the worker-side `VolumeRegistry`. Covered in
  [`./vault.md`](./vault.md).
- `BODHI_FEATURES_LIST_METHOD = '_bodhi/features/list'` and
  `BODHI_FEATURES_SET_METHOD = '_bodhi/features/set'` — per-session
  feature-toggle surface. Covered in [`./features.md`](./features.md).
- `BodhiAuthenticateMeta = { token: string; baseUrl: string }` —
  the `_meta` shape on `authenticate`.
- `BodhiModelDescriptor = { id: string; apiFormat: string }` —
  the lossy summary surfaced to the main thread (the worker keeps
  the full `Model<Api>`; see [`./agent.md`](./agent.md)).
- `BodhiListModelsResponse extends Record<string, unknown>` with
  `models: BodhiModelDescriptor[]` — the return shape of
  `bodhi/listModels`.
- `BodhiSessionSummary = { id, title, createdAt, updatedAt,
  turnCount, lastModelId }` — picker row shape; mirrors
  `SessionSummary` from `agent/session-store` but is the wire
  contract, kept independent so store internals can evolve
  without breaking clients.
- `BodhiListSessionsResponse extends Record<string, unknown>` with
  `sessions: BodhiSessionSummary[]` — return shape of
  `bodhi/listSessions`.
- `BodhiGetSessionRequest extends Record<string, unknown>` with
  `sessionId: string` — params shape of `bodhi/getSession`.
- `BodhiGetSessionResponse extends Record<string, unknown>` with
  `sessionId, messages: unknown[], lastModelId: string | null,
  title: string | null` — return shape of `bodhi/getSession`.
  `messages` is typed as `unknown[]` on the wire because the
  canonical shape is `pi-agent-core`'s `AgentMessage[]`, which is
  a moving internal type; the client casts on receipt. M4 phase B
  attaches a `_builtin` field (shape: `BodhiBuiltinTag`) on user
  and assistant entries reconstructed from `'builtin'` session
  store rows so the client can render them muted with a "not sent
  to LLM" badge — see [`./commands.md`](./commands.md).
- `BodhiBuiltinAction = { kind: string }` — open-ended client-side
  action discriminator carried under `_meta.bodhi.builtin.action`
  on `session/update` notifications. The only kind today is
  `'copy'`; future kinds (`'share'`, `'export-html'`, …) plug in
  on the client without a wire change. The action **payload** is
  never carried on the wire — `/copy` builds the markdown from the
  client's own `messages` state at dispatch time so persistence
  and the wire stay minimal.
- `BodhiBuiltinMeta = { command: string; action?: BodhiBuiltinAction }` —
  the `_meta.bodhi.builtin` envelope carried on built-in
  `agent_message_chunk` notifications. Same posture as
  `_meta.bodhi.mcp` for MCP lifecycle: an extension sub-key under
  `_meta.bodhi.*` rather than a new method or notification type.
- `BodhiBuiltinTag = BodhiBuiltinMeta` — the client-side in-memory
  marker (attached as `_builtin` on `AgentMessage` envelopes
  returned from `bodhi/getSession` and on local user-message
  envelopes tagged at send time in `useAcp`). Same shape as the
  wire envelope; kept as a distinct alias so a future divergence
  (e.g. an extra "rendered locally?" hint) doesn't churn the wire
  contract.

### `acp/client.ts`

`AcpClient` is a narrow typed facade:

- **Ownership.** Constructed once per worker (by
  `useAcp.ensureRuntime`) and stored at module scope. Holds
  `readonly #conn: ClientSideConnection` plus `readonly
  #listeners: Set<SessionUpdateListener>`.
- **`signal`.** Passthrough to `#conn.signal` — the SDK's
  transport-level abort signal. Consumers can watch it to react
  to the underlying stream closing.
- **`closed`.** Passthrough to `#conn.closed` — the SDK's
  close-promise.
- **`initialize()`.**
  ```
  return this.#conn.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true }
    }
  });
  ```
  The response carries the agent's capabilities + `authMethods`
  array. M0 does not use the response beyond ordering; `useAcp`
  awaits the resulting promise before issuing other calls. M2.3
  flips the `fs` capabilities to `true`; the built-in `bash` tool
  never calls `fs/*` — the handlers live on the main thread as an
  IDE-integration seam for external ACP agents (see `vault.md`).
- **`authenticate(args: BodhiAuthenticateMeta)`.**
  ```
  await this.#conn.authenticate({
    methodId: BODHI_AUTH_METHOD_ID,
    _meta: { token: args.token, baseUrl: args.baseUrl }
  });
  ```
  Returns `void`; errors propagate from the adapter (invalid
  method id, missing `_meta` fields).
- **`listModels()`.**
  ```
  const raw = await this.#conn.extMethod(BODHI_LIST_MODELS_METHOD, {});
  return (raw as BodhiListModelsResponse).models ?? [];
  ```
- **`listSessions()`.**
  ```
  const raw = await this.#conn.extMethod(BODHI_LIST_SESSIONS_METHOD, {});
  return (raw as BodhiListSessionsResponse).sessions ?? [];
  ```
  Returns picker-ready rows ordered by `updatedAt DESC` (the
  adapter delegates to `SessionStore.listSummaries`).
- **`loadSession(sessionId)`.** Calls
  `this.#conn.loadSession({sessionId, cwd: '/', mcpServers: []})`
  — the stable SDK method. The agent replays stored
  `session/update` notifications verbatim during this call; the
  hook silences the live handler via an `isReplayingRef` so
  those deltas don't touch the UI (the snapshot path does the
  rehydration instead).
- **`getSession(sessionId)`.** `return await
  this.#conn.extMethod(BODHI_GET_SESSION_METHOD, {sessionId}) as
  BodhiGetSessionResponse`. Used immediately after
  `loadSession` by `useAcp` to obtain the last turn's
  `finalMessages` + `lastModelId` + `title` in one hop.
- **`newSession()`.** `return this.#conn.newSession({cwd: '/',
  mcpServers: []})`. `cwd` and `mcpServers` are stubs — M0's
  adapter ignores both. They're present because the SDK types
  require them; M2 gives `cwd` semantic meaning (see
  [`../../milestones/m2-tools.md`](../../milestones/m2-tools.md)).
- **`prompt(sessionId, text, modelId)`.**
  ```
  return this.#conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text }],
    _meta: { bodhi: { modelId } }
  });
  ```
- **`cancel(sessionId)`.** `this.#conn.cancel({sessionId})`; the
  SDK dispatches this as a JSON-RPC notification.
- **`listVolumes()` / `listFeatures(sessionId)` / `setFeature(sessionId, key, value)`.**
  Thin wrappers over the M2 extension methods
  (`_bodhi/volumes/list`, `_bodhi/features/list`,
  `_bodhi/features/set`). Detail in [`./vault.md`](./vault.md) and
  [`./features.md`](./features.md).
- **`onSessionUpdate(listener)`.** Adds the listener to
  `#listeners`; returns an unsubscribe closure. **Not** a
  passthrough to the SDK — `ClientSideConnection` only carries
  notifications if the `Client` handler picks them up. That
  plumbing lives in `useAcp.ensureRuntime`, which installs a
  `Client.sessionUpdate` method that forwards into
  `dispatchSessionUpdate` below.
- **`dispatchSessionUpdate(notification)`.** Iterates
  `#listeners` and invokes each with the notification. Listener
  throws are caught and logged so a bad listener cannot break
  the transport.

`buildClientHandler(client)` is exported but unused today (it
was used by an earlier phase-C scaffold; `useAcp` now inlines the
handler to add `requestPermission`). Kept for reference — when we
grow the handler surface at M1, this function is the natural home
for it.

### `acp/agent-adapter.ts`

`AcpAgentAdapter` implements `Agent` from the SDK. After the
engine-split refactor it is a **thin wire shim** (~245 LoC) that
delegates every method into the engine layer. Mirrors
coding-agent's `modes/rpc/rpc-mode.ts` posture: dispatch only, no
business logic.

#### State (post-refactor)

- `readonly #services: AcpAdapterServices` — the deps bag
  (`acp/engine/services.ts`).
- `readonly #runtime: AcpSessionRuntime` — lifecycle owner; holds
  per-session state (`acp/engine/session-runtime.ts`).
- `readonly #driver: PromptTurnDriver` — the turn engine
  (`acp/engine/prompt-driver.ts`).

The adapter holds **no** per-session state of its own. All session
maps, MCP subscriptions, model caches, and per-turn flags live in
the engine layer.

#### Methods

- **`initialize(_params: InitializeRequest): Promise<InitializeResponse>`.**
  Returns the static response shown in
  [`./startup-sequence.md`](./startup-sequence.md#initialize-payload-exchange):
  `protocolVersion: 1`,
  `agentCapabilities: { loadSession: <store-configured>,
  promptCapabilities: { image: false, audio: false,
  embeddedContext: false } }`,
  `authMethods: [{id: BODHI_AUTH_METHOD_ID, name, description}]`.
  `loadSession` is advertised as `true` whenever a
  `SessionStore` is wired into the adapter — which, in
  production, is always, because `agent-worker.ts` always
  instantiates one. Unit tests that construct the adapter
  without a store get `loadSession: false` and no resume
  surface, as expected. No MCP capabilities advertised (see
  [`../../milestones/m2-tools.md`](../../milestones/m2-tools.md)
  § M2.3).

- **`authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse>`.**
  1. Throws `"Unsupported auth method: <id>"` if `params.methodId
     !== BODHI_AUTH_METHOD_ID`.
  2. Casts `params._meta` to `Partial<BodhiAuthenticateMeta>`;
     throws `"authenticate: _meta must include { token, baseUrl
     }"` if either is missing or falsy.
  3. `this.#bodhi.setAuthToken({provider: 'bodhi', token,
     baseUrl})`.
  4. Resets `this.#models = []` so a stale catalog can't cross
     an auth boundary.
  5. `this.#inline.clearMessages()` — discards any previous
     turn's transcript. M1 revisits this; for M0 it prevents a
     pre-auth message leaking into a post-auth turn.
  6. Returns `{}` (the SDK's minimal `AuthenticateResponse`).

- **`newSession(_params: NewSessionRequest): Promise<NewSessionResponse>`.**
  Generates `sessionId = 'bodhi-' + crypto.randomUUID()`;
  registers it in `#sessions`; calls
  `await #store.createSession(sessionId)` when a store is
  configured; then `this.#inline.clearMessages()` and sets
  `#activeInlineSessionId = sessionId`. Clearing the inline
  runtime on every new session is what prevents the previous
  session's transcript from leaking into the next one's
  `finalMessages` (the "+ New chat → Anthropic prompt" case in
  `sessions-resume.spec.ts`). The `NewSessionRequest`
  (`{cwd, mcpServers}`) is ignored today — both are stubs; M2.1
  gives `cwd` semantic meaning.

- **`loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>`.**
  Requires `#store`. Flow:
  1. `store.getSession(sessionId)` — throws on unknown id.
  2. Register in `#sessions` so a subsequent `prompt` passes the
     existence check.
  3. `store.readEntries(sessionId)` — iterate in `seq` order.
     Every `notification` entry is re-emitted verbatim via
     `#conn.sessionUpdate(...)` (deliberately bypassing `#emit`
     to avoid double-persisting rows). Every `turn` entry
     overwrites `lastTurnMessages`.
  4. If `lastTurnMessages` is present,
     `inline.restoreMessages(lastTurnMessages)`; otherwise
     `inline.clearMessages()`.
  5. `#activeInlineSessionId = sessionId`.
  6. Returns `{}` — ACP's minimal `LoadSessionResponse`. Model
     restoration travels over the companion `bodhi/getSession`
     reply; ACP's stable `LoadSessionResponse` has no
     first-class field for "last model" yet.

- **`prompt(params: PromptRequest): Promise<PromptResponse>`.**
  One line: `return this.#driver.run(params)`. The full flow
  (built-in interception → model resolve → slash expansion →
  rehydrate guard → tool assembly → stream → record turn) lives
  in `acp/engine/prompt-driver.ts`. See "Engine layer" below.

- **`cancel(_params: CancelNotification): Promise<void>`.** One
  line: `this.#driver.abort()`. Sets the cancel flag, aborts
  the per-turn signal, and tells the inline runtime to stop
  streaming.

- **`extMethod(method, params)`.** One line:
  `return dispatchExtMethod(method, params, this.#extMethodHost())`.
  The dispatcher looks up the registered handler in
  `acp/engine/ext-methods/index.ts` and calls it with a narrow
  facade (`ExtMethodHost`) that the adapter assembles from
  services + runtime accessors. See "Engine layer" below.

- **`dispose(): Promise<void>`.** Delegates to
  `runtime.dispose()`, which unsubscribes the MCP pool listener
  and releases every connection.

#### `#extMethodHost()`

Builds the narrow facade `dispatchExtMethod` consumes. Bridges
`services` and `runtime` accessors so the per-handler files
under `acp/engine/ext-methods/` stay independent of the adapter
class. Defined in `acp/engine/types.ts` as `ExtMethodHost`.

### Engine layer (`acp/engine/`)

#### `engine/services.ts` (~75 LoC)

`AcpAdapterServices` — infrastructure bag the adapter consumes.
Required: `inline`, `bodhi`, `mcpPool`, `commandsFs`. Optional:
`store`, `registry`, `features`, `mcpToggles`, `streamOverrides`.

`assembleServices(opts)` — the factory. Defaults `mcpPool` to a
fresh `McpConnectionPool` and `commandsFs` to the ZenFS
implementation. Called once in `agent-worker.ts`.

#### `engine/session-runtime.ts` (~410 LoC)

`AcpSessionRuntime` — lifecycle orchestrator. Mirrors
coding-agent's `agent-session-runtime.ts`. Owns:

- `#sessions: Map<string, SessionState>` — per-session in-memory
  state.
- `#availableCommands: CommandDef[]` — vault command cache.
- `#models: Model<Api>[]` — LLM catalog cache.
- `#activeInlineSessionId: string | null` — which session's
  history is loaded into the inline runtime.
- `#mcpSubscription: () => void` — pool-event subscription handle.

Public surface (consumed by adapter, driver, ext-method
handlers, and builtin-dispatch):

- Session map: `getSession(id)`, `setSession(id, state)`,
  `deleteSessionEntry(id)`, `sessions` (read-only Map view).
- Inline attach: `getActiveInlineSessionId()`,
  `setActiveInlineSessionId(id)`.
- Caches: `getModels()`, `setModels(m)`, `getAvailableCommands()`.
- Stores (with safe-default fallbacks): `readFeatures(sessionId)`,
  `readMcpToggles(sessionId)`.
- MCP: `acquireMcpConnections(sessionId, servers)`,
  `releaseMcpConnections(sessionId, servers)`,
  `mcpToolsForSession(session, toggles)`,
  `broadcastMcpPoolEvent(event)`.
- Inline: `rehydrateInlineFromStore(sessionId)`.
- Commands: `refreshAvailableCommands(sessionId)`.
- Builtin context: `sessionStatsFor(sessionId)`,
  `mcpConnectedFor(sessionId)`.
- Wire helpers: `emit(notification)` — persisted; the single
  exit point for `session/update` events that should survive
  reload. `sendRawNotification(notification)` — direct conn
  passthrough for replay + builtin replies (which persist via
  `recordBuiltin` instead).
- Teardown: `dispose()`.

#### `engine/prompt-driver.ts` (~370 LoC)

`PromptTurnDriver` — runs one `session/prompt` turn end-to-end.
Mirrors coding-agent's `agent-session.ts` turn loop, scaled down.
Owns per-turn state (`#turnAbort`, `#cancelled`); these reset on
each `run()`.

`run(params)` flow:

1. Session lookup (throws on miss).
2. Built-in interception via `tryHandleBuiltin(...)` — see
   `engine/builtin-dispatch.ts`. Returns early on match without
   touching the inline runtime.
3. Model resolution from `_meta.bodhi.modelId` against the
   runtime's catalog cache.
4. Slash-command expansion (vault commands).
5. Rehydrate inline runtime if the cached active session ≠ the
   prompt's session.
6. Read features + MCP toggles, list volumes, build tool list
   (bash + MCP) wrapped with the per-turn abort signal.
7. Compose system prompt; install model + tools on the inline
   runtime.
8. Push per-turn stream overrides (DEV-only `forceToolCall`).
9. Subscribe → `inline.prompt(text)` → forward stream events as
   `agent_message_chunk` / `tool_call` / `tool_call_update`.
10. `recordTurn` on success.

`abort()` — sets `#cancelled`, aborts the per-turn signal, calls
`inline.cancel()`. The driver's only public API beyond `run()`.

The `bindAbortSignal()` helper (chains the per-turn abort with
the LLM-stream abort signal pi-agent-core passes into `execute`)
lives at module scope in this file as a non-exported helper.

#### `engine/builtin-dispatch.ts` (~115 LoC)

`tryHandleBuiltin(args)` — free function lifted out of the
driver. Recognises a registered built-in, runs the handler,
emits the reply via the **raw connection** (NOT
`runtime.emit`) stamped with `_meta.bodhi.builtin = { command,
action? }`, and persists a `'builtin'` `SessionEntry`.

The raw-connection emission is deliberate: built-in chunks must
not be persisted as `'notification'` rows because the
`'builtin'` entry plus the `bodhi/getSession` interleaving on
reload is the single source of truth for replay (see
[`./commands.md`](./commands.md) and
[`./sessions.md`](./sessions.md)).

The actual command implementations stay in
`agent/commands/builtins/` — that boundary doesn't move.

#### `engine/ext-methods/`

Per-file handlers for `_bodhi/*` extension methods, registered
in `engine/ext-methods/index.ts` via a `Record<method, handler>`.
Each handler is a free function `(params, host: ExtMethodHost) =>
Promise<Record<string, unknown>>`:

- `list-models.ts` — `bodhi/listModels` (refreshes model catalog
  cache, returns `{id, apiFormat}` descriptors).
- `list-sessions.ts` — `bodhi/listSessions` (returns store
  summaries, empty array when no store).
- `volumes-list.ts` — `_bodhi/volumes/list` (volume registry
  introspection).
- `features-list.ts` — `_bodhi/features/list` (per-session
  feature snapshot + defaults).
- `features-set.ts` — `_bodhi/features/set` (validates key,
  enforces DEV-only `forceToolCall` gate, persists override).
- `get-session.ts` — `bodhi/getSession` (transcript rebuild from
  store entries, interleaves `'turn'` deltas + `'builtin'` pairs;
  the heaviest handler at ~70 LoC, kept cohesive — it's one
  algorithm).
- `mcp-toggles-set.ts` — `_bodhi/mcp/toggles/set` (per-session
  per-server / per-tool toggle override).
- `sessions-delete.ts` — `_bodhi/sessions/delete` (idempotent
  removal: in-memory state first, then store).

Adding a new `_bodhi/*` method is "create a file + register it"
— no edits to a switch statement. M5 extensions / M6 fork / M7
compaction land cleanly in this directory.

#### Module-private functions

Pure functions in `acp/wire-utils.ts`:

- `extractAssistantText(msg)` — handles both `string` and
  `ContentBlock[]`-shaped `content` fields.
- `extractMessageId(msg)` — reads `msg.id` if string.
- `extractSessionMeta(meta)` — defensively coerces
  `_meta.bodhi.{requestedMcpUrls, mcpInstances}`.
- `filterHttpServers(servers)` — drops non-http MCP entries.
- `toWireMcpToggles(snapshot)` — internal → wire shape.
- `toAvailableCommand(def)` — `CommandDef` → `AvailableCommand`.
- `toolTitle(name, args)` — bash title formatting for UI.
- `toToolCallContent(content)` — pi-agent-core content blocks
  → ACP `ToolCallUpdate.content` shape.
- `makeBuiltinUserMessage(text, tag)` /
  `makeBuiltinAssistantMessage(text, tag)` — synthetic builtin
  message factories used by `bodhi/getSession`.

## Tests

No module-level tests ship with the adapter yet. Coverage today:

- **Main-thread e2e.** `packages/web-acp/e2e/chat.spec.ts` drives
  `ChatDemo` through a real Bodhi OAuth + prompt cycle; if any
  method above breaks, the spec fails.
- **Type-check.** `AcpAgentAdapter implements Agent` catches
  any SDK-shape regression at build time.

M1 plan adds vitest coverage of at least:

- `authenticate` rejecting unknown method ids and missing
  `_meta`.
- `prompt` rejecting unknown sessions / unknown models.
- `#forwardEvent` delta computation (new message id resets
  cursor).

## Constraints

- The Bodhi constants must not be inlined elsewhere; grep
  `'bodhi-token'`, `'bodhi/listModels'`, `'bodhi/listSessions'`,
  and `'bodhi/getSession'` across `src/` to enforce.
- The `Agent` interface is the extraction boundary. If a future
  milestone wants a non-SDK hook (e.g., direct event emission
  into the worker-main channel), add it **outside** the
  `Agent`-shape methods; don't pollute the standard surface.
- `#conn.sessionUpdate(...)` is the only allowed path for agent
  → client notifications. Adding new notification types is a
  plan-level decision because each one is an ACP extension point.

## Change procedure

Any plan that edits files under `packages/web-acp/src/acp/` must
update this file in the same commit. When adding a new ACP
surface (new `Agent` method, new `Client` method, new extension
method or auth method):

1. Add the constant to `acp/index.ts` if it's a new id.
2. Add the method to `AcpClient` (main-thread) and/or
   `AcpAgentAdapter` (worker) as required.
3. Document the wire shape in this file.
4. Update [`./startup-sequence.md`](./startup-sequence.md) if the
   change affects boot / auth / prompt ordering.

See [`./index.md` § Change procedure](./index.md#change-procedure).
