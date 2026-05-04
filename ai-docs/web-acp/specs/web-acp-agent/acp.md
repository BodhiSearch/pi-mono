# ACP wire shim + handlers + engine layer

**Source of truth (agent package):** `packages/web-acp-agent/src/acp/`.

## Purpose

The agent package implements ACP's `Agent` interface in
`acp/agent-adapter.ts:AcpAgentAdapter`. The adapter is a thin
dispatch shim with **no business logic**: every standard ACP
method delegates to a per-concern file under `acp/handlers/`,
the per-session lifecycle lives under `acp/engine/`, and the
small `_bodhi/*` extension surface dispatches through
`acp/engine/ext-methods/`. Every per-handler file is a function
that accepts an `AcpAdapterContext` (shared bag of services +
runtime + driver + build flags) so the handlers stay independent
of the adapter class. Mirrors coding-agent's
`modes/rpc/rpc-mode.ts` posture.

The `bootstrap.ts:startAcpAgent(transport, services, options)`
function is the only public entry point hosts use. It wraps
`transport` in `ndJsonStream`, constructs an
`AgentSideConnection`, and inside the connection's `toAgent`
factory builds an `AcpAgentAdapter(conn, services, options)`.

## Wire shim — `acp/agent-adapter.ts`

`acp/agent-adapter.ts:AcpAgentAdapter` (`:57`) implements the
SDK `Agent` interface. Constructor (`:63`) takes three
arguments:

- `conn: AgentSideConnection` — supplied by the SDK on inbound
  attach; used by the engine for `sessionUpdate` emission and by
  `extNotification` for the two `_bodhi/*` notifications.
- `services: AcpAdapterServices` — host-supplied infrastructure
  bag (see [services](#services--acpengineservicests)).
- `options: AcpAgentAdapterOptions` (`:41`) — `{ isDev: boolean,
  buildVersion: string, acpSdkVersion: string }`. Hosts read
  these from build-tool defines and forward them across the
  package boundary.

Owned members (`:58–61`):

- `#services: AcpAdapterServices`.
- `#runtime: AcpSessionRuntime` — lifecycle owner.
- `#driver: PromptTurnDriver` — single prompt-turn engine.
- `#ctx: AcpAdapterContext` — shared bag handlers receive.

ACP method implementations:

| Method | Adapter line | Delegates to | Behaviour |
| --- | --- | --- | --- |
| `initialize` | `:87` | `handlers/initialize.ts:handleInitialize` | Negotiates `protocolVersion` against `PROTOCOL_VERSION` from the SDK; advertises `agentInfo`, `agentCapabilities` (loadSession iff `services.store`, `mcpCapabilities.http=true/sse=false`, `promptCapabilities` all false, `sessionCapabilities.list = {}` iff store / `close = {}`), the single auth method `bodhi-token`. |
| `authenticate` | `:91` | `handlers/initialize.ts:handleAuthenticate` | Validates `methodId === BODHI_AUTH_METHOD_ID`; reads `_meta` as `BodhiAuthenticateMeta { token, baseUrl }`; calls `services.bodhi.setAuthToken({ provider: 'bodhi', token, baseUrl })`. Resets `runtime.setModels([])` and `services.inline.clearMessages()` so the next session lazy-reloads under the new credential. |
| `newSession` | `:95` | `handlers/session-crud.ts:handleNewSession` | Mints `sessionId = bodhi-${crypto.randomUUID()}`, filters MCP servers via `wire-utils.ts:filterHttpServers`, extracts `requestedMcpUrls` + `mcpInstances` via `wire-utils.ts:extractSessionMeta`, populates runtime state (with `currentModelId: null`), creates the store row, marks the inline session active, acquires MCP connections, refreshes the available-commands cache, lazy-loads models via `tryEnsureModels`, seeds `currentModelId` to the catalog's first id, and returns `{ sessionId, models?, configOptions }`. |
| `loadSession` | `:99` | `handlers/session-crud.ts:handleLoadSession` | Validates the row exists, releases prior MCP connections under the old config (so the pool can re-key under new headers), reseeds `SessionState` with the row's `lastModelId` as `currentModelId`, replays persisted entries via `walkEntries` (notifications re-emitted through `runtime.sendRawNotification`; turn entries' `finalMessages` capture for inline reseed; built-in entries deferred to `bodhi/getSession` round-trip — see TODO in `session-crud.ts:93`), seeds inline history, acquires MCP connections, refreshes commands, ensures models, resolves the seeded model id (`resolveSeededModelId`), and returns `{ models?, configOptions, _meta.bodhi: { title, mcpToggles } }`. |
| `listSessions` | `:103` | `handlers/session-crud.ts:handleListSessions` | Calls `store.listSummaries`; maps each row to `SessionInfo { sessionId, cwd: '/', title, updatedAt: ISO, _meta.bodhi: { turnCount, lastModelId, createdAt } }`. Unpaginated. |
| `closeSession` | `:107` | `handlers/session-crud.ts:handleCloseSession` | Calls `runtime.tearDownSession(sessionId, { persistRow: true, abortPromptIfActive: id => driver.abortIfActive(id) })`. Keeps the row. |
| `unstable_setSessionModel` | `:111` | `handlers/session-crud.ts:handleSetSessionModel` | Validates session + lazy-loads catalog + validates model id is in catalog; sets `SessionState.currentModelId`. Returns `{}`. |
| `setSessionConfigOption` | `:115` | `handlers/session-crud.ts:handleSetSessionConfigOption` | Maps `configId` → feature key via `feature-config.ts:configIdToFeatureKey`. Throws on unknown id; throws JSON-RPC `-32004` if `forceToolCall` and `!isDev`. Accepts `value: 'on' \| 'off' \| boolean` (legacy). Calls `services.features.set`, rebuilds `SessionConfigOption[]` via `buildFeatureConfigOptions`, fires `runtime.emitConfigOptionUpdate(sessionId, options)`, returns `{ configOptions: options }`. See [`features.md`](./features.md). |
| `prompt` | `:121` | `#driver.run(params)` directly (not a handler module) | Single-line passthrough. |
| `cancel` | `:125` | `handlers/session-crud.ts:handleCancel` | Calls `driver.abortIfActive(params.sessionId)` — guards against aborting an unrelated session's turn (the driver is single-instance for the worker). |
| `extMethod` | `:129` | `dispatchExtMethod(method, params, this.#extMethodHost())` | Routes the small `_bodhi/*` surface; see [ext-methods](#ext-methods--acpengineext-methods). |
| `dispose` | `:163` | `#runtime.dispose()` | Releases MCP refcounts + clears in-memory session map. Idempotent. Does NOT abort in-flight turns — host must cancel first. |

`#extMethodHost()` (`:135`) builds the narrow facade
ext-method handlers consume — see
`acp/engine/types.ts:ExtMethodHost`.

## Adapter context — `acp/handlers/adapter-context.ts`

`acp/handlers/adapter-context.ts:AcpAdapterContext` (`:6`) is
the shared bag every handler receives. Frozen-shape interface
holding `services`, `runtime`, `driver`, `isDev`,
`buildVersion`. The two model helpers in this file are used by
both `newSession` and `loadSession`:

- `tryEnsureModels(ctx)` (`:15`) — wraps
  `runtime.ensureModelsLoaded()` in try/catch so session
  creation still succeeds even when the catalog fetch fails
  (e.g. before `authenticate` lands). Logs and returns `[]`.
- `buildModelState(models, currentModelId)` (`:25`) — converts
  the loaded catalog to ACP's `SessionModelState` shape
  (`{ availableModels, currentModelId }`); returns `undefined`
  for an empty catalog (the SDK schema requires ≥1 entry when
  the field is present).
- `resolveSeededModelId(models, lastModelId)` (`:38`) — picks
  `lastModelId` if it's still in the catalog, else the
  catalog's first id, else `null`. Used by `loadSession`.

## Services — `acp/engine/services.ts`

`acp/engine/services.ts` defines the deps bag the adapter
consumes:

- **`StreamOverridesRef`** (`:14`) — per-turn override holder
  threaded between the driver and the stream function. The
  driver pushes `toolChoice` into `current` before each turn;
  the stream function (`agent/stream-fn.ts`) reads-and-clears
  so only the first LLM call of the turn sees the override.
- **`AcpAdapterServices`** (`:21`) — required:
  `inline: InlineAgent`, `bodhi: BodhiProvider`,
  `mcpPool: McpConnectionPool`, `commandsFs: CommandsFs`.
  Optional (gates features): `store?: SessionStore`,
  `registry?: VolumeRegistry`, `features?: FeatureStore`,
  `mcpToggles?: McpToggleStore`, `streamOverrides?:
  StreamOverridesRef`.
- **`AssembleServicesOptions`** (`:33`) — host-facing shape;
  same fields as `AcpAdapterServices` but with `mcpPool` and
  `commandsFs` optional.
- **`assembleServices(opts)`** (`:45`) — defaults `mcpPool` to
  `new McpConnectionPool()` and `commandsFs` to
  `createZenfsCommandsFs()`. Both browser and CLI hosts call
  this identically (see
  `packages/cli-acp-client/src/services/assemble.ts`).

## Engine layer — `acp/engine/`

### `acp/engine/types.ts`

Defines two interfaces:

- **`SessionState`** (`:12`) — per-session in-memory record:
  `id`, `mcpServers`, `requestedMcpUrls`, `mcpInstances`,
  `currentModelId`. The `currentModelId` field is the source
  of truth the prompt-driver reads on each turn (replacing the
  legacy `_meta.bodhi.modelId` on every prompt).
- **`ExtMethodHost`** (`:23`) — the narrow facade
  `dispatchExtMethod` receives. Exposes `bodhi`, `store`,
  `registry`, `features`, `mcpToggles`, `mcpPool`, `inline`,
  `sessions: Map<string, SessionState>`, `isDev`, plus
  accessors `getModels`/`setModels`,
  `getActiveInlineSessionId`/`setActiveInlineSessionId`,
  `readFeatures(sessionId)`, `readMcpToggles(sessionId)`,
  `tearDownSession(sessionId, opts?)`,
  `abortPromptIfActive(sessionId)`.

### `acp/engine/replay.ts`

`acp/engine/replay.ts:walkEntries(entries, walkers)` (`:13`) —
the shared session-entry walker. Three optional callbacks
(`notification`, `turn`, `builtin`); absent callbacks skip that
kind silently. Sequential dispatch preserves persisted `seq`
order, which `loadSession` relies on for replay determinism.
Three call sites:

- `handlers/session-crud.ts:handleLoadSession` — notifications
  + turns (re-emit + capture last-turn messages).
- `engine/session-runtime.ts:rehydrateInlineFromStore` — turns
  only.
- `engine/ext-methods/get-session.ts:getSession` — turns +
  built-ins (interleave by seq order).

### `acp/engine/session-runtime.ts:AcpSessionRuntime`

Lifecycle orchestrator. Owns:

- **Per-session map** (`#sessions`, `:38`) — keyed by `sessionId`.
- **Active inline session id** (`#activeInlineSessionId`,
  `:44`) — the `InlineAgent` carries one history at a time;
  this remembers which session's history is currently loaded so
  a `prompt` for a different session triggers
  `rehydrateInlineFromStore` rather than splicing contexts.
- **Cached vault command list** (`#availableCommands`, `:39`)
  — shared across sessions because the vault is per-worker.
- **LLM model catalog** (`#models`, `:40`) — populated by
  `ensureModelsLoaded` and reset by `authenticate`.
- **MCP pool subscription** — the constructor (`:46`) calls
  `services.mcpPool.subscribe((event) => { void
  this.broadcastMcpPoolEvent(event); })`; the unsubscribe
  handle is released in `dispose()`.

Notable methods (cite when extending):

- `getSession`/`setSession`/`deleteSessionEntry`/`sessions`
  (getter) (`:54–68`).
- `setModels`/`getModels` (`:78`/`:82`).
- `ensureModelsLoaded()` (`:88`) — lazy + cached. Returns the
  cached list if non-empty; otherwise calls
  `services.bodhi.getAvailableModels()` and stores it. Cleared
  by `authenticate` so a fresh token re-fetches under the new
  credential.
- `setSessionModel(sessionId, modelId)` (`:95`) — writes
  `SessionState.currentModelId`. Called from
  `handleNewSession` (default seeded), `handleLoadSession`
  (resolved from row + catalog), `handleSetSessionModel` (user
  pick).
- `tearDownSession(sessionId, opts)` (`:107`) — unified
  teardown for `closeSession` + `_bodhi/sessions/delete`. Aborts
  the matching in-flight turn (if `abortPromptIfActive` provided
  and the prompt sessionId matches), releases all MCP refcounts
  for the session, drops the in-memory record, detaches the
  inline runtime if active. When `persistRow: false` and a
  store is configured, also calls `store.deleteSession`.
  Idempotent.
- `acquireMcpConnections(sessionId, servers)` (`:155`),
  `releaseMcpConnections` (`:167`).
- `mcpToolsForSession(session, toggles)` (`:173`) — builds the
  per-turn MCP tool list, filtered by per-tool toggles
  (server-level filtering already happened upstream in
  `compose-mcp-servers`).
- `broadcastMcpPoolEvent(event)` (`:191`) — fans pool events
  to every affected session as
  `extNotification(BODHI_MCP_STATE_NOTIFICATION_METHOD, …)`
  with shape `BodhiMcpStateNotificationParams`. **Transient —
  does not persist.** Rationale: the pool rebuilds on every
  `loadSession` so persisting these would replay stale state.
- `rehydrateInlineFromStore(sessionId)` (`:216`) — reseeds the
  inline agent's history from the last `'turn'` entry via
  `walkEntries`. Falls back to `clearMessages` when no turn
  entry exists.
- `refreshAvailableCommands(sessionId)` (`:243`) — reloads
  vault commands + prompt templates from
  `services.commandsFs`, deduplicates (commands win on
  canonical-name collision; prompts losing get a `[prompts]`
  warning), merges with `builtinAvailableCommands()`, emits
  `available_commands_update`. Called once per `newSession`
  and per `loadSession`.
- `emit(notification)` (`:322`) — single exit point for every
  **persisted** `session/update`. Emits to client AND records
  via `services.store.recordNotification`.
- `sendRawNotification` (`:335`) — emits without persisting.
  Used by built-in replies (which persist as `'builtin'`
  entries instead) and `loadSession` replay (where the store
  already has the row).
- `emitConfigOptionUpdate(sessionId, options)` (`:341`) —
  fires the standard `config_option_update` SessionUpdate so
  the host's reducer can refresh its options slice. Transient
  (feature state is reconstructed from the persisted row on
  every `loadSession`).
- `sessionStatsFor`, `mcpConnectedFor` — helpers feeding the
  built-in handler context.

### `acp/engine/prompt-driver.ts:PromptTurnDriver`

Single prompt-turn loop. Owns per-turn state
(`#cancelled: boolean`, `#turnAbort: AbortController`,
`#promptSessionId`, `#inflightBySession: Map<sessionId,
Promise>`). The map is a per-session mutex — a second
concurrent `prompt` for the same session rejects with JSON-RPC
`-32011` rather than interleaving streams.

`run(params)` (`:71`) wraps `#runTurn` in the inflight-mutex
guard. `#runTurn` (`:93`) does:

1. **Built-in early return** — if the prompt is a built-in
   slash command (`tryHandleBuiltin`, see
   [builtin-dispatch](#acpenginebuiltin-dispatchts)), the
   driver emits the muted reply, persists a `'builtin'` entry,
   and returns without touching the inline agent.
2. **Model resolution** — `#resolveModel(sessionId)` (`:209`)
   reads `SessionState.currentModelId` and looks it up in
   `runtime.getModels()`. Throws `'No model selected: call
   unstable_setSessionModel first'` if absent.
3. **Slash-command expansion** —
   `#applySlashCommandExpansion(params)` (`:249`) feeds the
   last text block through
   `agent/commands/expander.ts:expandCommand` against the
   cached command list; the block's text is replaced in-place
   if matched.
4. **History attach guard** — if
   `runtime.getActiveInlineSessionId() !== sessionId`, calls
   `runtime.rehydrateInlineFromStore(sessionId)`.
5. **Per-turn tool list** — bash tool (gated on
   `featureSnapshot.bashEnabled && registry.list().length > 0
   && services.registry`) plus enabled MCP tools. Each tool is
   wrapped via the local `bindAbortSignal` helper (`:350`) so
   `session/cancel` short-circuits the running `execute` call.
6. **System prompt** — `composeSystemPrompt(volumes)` —
   includes per-volume descriptors so the LLM knows each mount.
7. **Stream override push** — when `featureSnapshot.forceToolCall
   && isDev && tools.length > 0`, sets
   `streamOverrides.current = { toolChoice: 'required' }`.
8. **Stream subscribe + prompt** — installs
   `services.inline.subscribe(forwardEvent)` (catching
   listener throws so pi-agent-core doesn't poison the
   subscription) and awaits `services.inline.prompt(text)`.
9. **Persist** — on success, `services.store.recordTurn(
   sessionId, text, services.inline.getMessages(), model.id)`.
10. **Cleanup** — unsubscribe, clear stream overrides, drop
    the abort controller. Returns `{ stopReason: 'end_turn' }`
    or `'cancelled'`.

`abort()` (`:195`) sets `#cancelled = true`, aborts the
per-turn signal, and calls `services.inline.cancel()`.
`abortIfActive(sessionId)` (`:203`) only aborts when
`#promptSessionId === sessionId`.

`#extractPromptText(params)` (`:219`) flattens text blocks +
`resource_link` blocks into a single string. Other prompt
block kinds are gated off by `promptCapabilities` advertised
in `initialize`.

`#forwardEvent(sessionId, event, cursor, toolState)` (`:267`)
translates inline-agent events to ACP `session/update`
notifications. The streaming-text path is the one place the
delta logic earns a snippet:

```ts
// prompt-driver.ts:273–296 (extract)
if (event.type === 'message_update') {
    const msg = event.message;
    if (msg.role !== 'assistant') return;

    const messageId = extractMessageId(msg);
    if (messageId !== cursor.messageId) {
        cursor.messageId = messageId;
        cursor.emittedLength = 0;
    }

    const text = extractAssistantText(msg);
    if (text.length <= cursor.emittedLength) return;
    const delta = text.slice(cursor.emittedLength);
    cursor.emittedLength = text.length;

    await this.#runtime.emit({
        sessionId,
        update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: delta },
            ...(messageId ? { messageId } : {}),
        },
    });
    return;
}
```

The wire emits **deltas only** — every chunk after the first
of a given `messageId` carries `text.slice(emittedLength)`.
Hosts accumulate per-`messageId` (web-acp's
`acp/streaming-reducer.ts` and cli-acp-client's
`commands/prompt.ts` both follow this contract). When the
inline-agent message changes (`messageId` differs), the cursor
resets and the next delta is the full new text.

`tool_execution_start` → `session/update (tool_call)`,
`tool_execution_update` → `tool_call_update (in_progress)`,
`tool_execution_end` → `tool_call_update (completed | failed)`.
Helper translations live in `acp/wire-utils.ts:toolTitle` and
`toToolCallContent`.

### `acp/engine/builtin-dispatch.ts:tryHandleBuiltin`

Entry point for the agent-handled built-in contract. Returns
`PromptResponse | null`:

- `null` → input wasn't a built-in; caller falls through to the
  LLM path.
- `{ stopReason: 'end_turn' }` → input matched; the chunk is
  emitted, the optional action notification is fired, and the
  `'builtin'` store entry is written before this returns.

Built-in detection: `findBuiltin(rawText)` from
`agent/commands/builtins/index.ts`. The handler context
(`BuiltinHandlerCtx`) is assembled from runtime accessors:
`sessionId`, `modelId` (from `SessionState.currentModelId`),
`serverUrl` (from `services.bodhi.getBaseUrl()`),
`sessionStats`, `mcpServersConnected`, `mcpInstances`,
`requestedMcpUrls`, `advertisedCommands` (builtins + vault
commands), `inlineMessages`, plus `buildVersion` /
`acpSdkVersion`.

The reply rides `agent_message_chunk` with
`_meta.bodhi.builtin = { command }`. The optional `action`
ships **separately** as
`extNotification(BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
{ sessionId, command, action })` (shape
`BodhiBuiltinActionNotificationParams`) immediately after the
chunk. Persistence rides through
`store.recordBuiltin(sessionId, { command, userText, replyText,
action? })`. Built-in replies emit directly via
`conn.sessionUpdate(...)` and `conn.extNotification(...)` —
they do **not** route through `runtime.sendRawNotification` and
do **not** double-persist as `'notification'` entries; the
`'builtin'` entry is the source of truth for replay.

### `acp/engine/ext-methods/`

Five extension methods total. The registry at
`ext-methods/index.ts:HANDLERS` (`:21`) maps method names to
handlers and the public dispatcher
`dispatchExtMethod(method, params, host)` (`:31`) resolves
each call. Missing method → JSON-RPC `-32601`. Listed methods
optionally pass through `EXT_METHOD_SCHEMAS` (Zod) at
`ext-methods/schemas.ts` before reaching the handler; bad
params throw `-32602`.

| Handler | Method constant | Wire method | Behaviour |
| --- | --- | --- | --- |
| `volumes-list.ts:volumesList` | `BODHI_VOLUMES_LIST_METHOD` | `_bodhi/volumes/list` | Returns `{ volumes: host.registry?.list() }` mapped to `BodhiVolumeDescriptor`. |
| `get-session.ts:getSession` | `BODHI_GET_SESSION_METHOD` (also legacy alias `BODHI_GET_SESSION_METHOD_LEGACY = bodhi/getSession`, warned-once on first use) | `_bodhi/session/get` (+ legacy `bodhi/getSession`) | Validates the row exists; returns the rebuilt snapshot (`messages`, `lastModelId`, `title`, `mcpToggles`) by walking entries via `walkEntries(turn + builtin)`. Built-in entries are stamped as a tagged user/assistant pair via `makeBuiltinUserMessage` / `makeBuiltinAssistantMessage` so the host renders the muted-builtin badge in the right chronological slot. |
| `mcp-toggles-set.ts:mcpTogglesSet` | `BODHI_MCP_TOGGLES_SET_METHOD` | `_bodhi/mcp/toggles/set` | Validates the params shape; dispatches to `mcpToggles.setServer` or `mcpToggles.setTool` based on whether `toolName` is present. **Server-off forces pool eviction across refcounts** via `mcpPool.evictBySlug(serverSlug, deriveSlugFromUrl)` — forgotten sessions can hold stale refs that keep the connection alive globally. Per-tool toggles only filter the tool list and never touch the pool. Returns the wire snapshot via `wire-utils.ts:toWireMcpToggles`. |
| `sessions-delete.ts:sessionsDelete` | `BODHI_SESSIONS_DELETE_METHOD` | `_bodhi/sessions/delete` | Idempotent: returns `{ deleted: false }` when the row is unknown. Delegates to `host.tearDownSession(sessionId, { persistRow: false, abortPromptIfActive: host.abortPromptIfActive })` — the runtime enforces teardown order (abort matching prompt → release MCP refs → drop in-memory state → delete persisted row). |

The `_bodhi/features/list`, `_bodhi/features/set`,
`bodhi/listModels`, and `bodhi/listSessions` extension methods
have been **removed**. Per-session feature toggles ride
`Agent.setSessionConfigOption` (see
[`features.md`](./features.md)); session listing rides
`Agent.listSessions`; model selection rides
`Agent.unstable_setSessionModel`; the model catalog is
lazy-loaded on the agent side via `ensureModelsLoaded` and
shipped to the host on `NewSessionResponse.models` /
`LoadSessionResponse.models`.

When upstream ACP adds a stable verb for `_bodhi/session/get`
or `_bodhi/sessions/delete`, the migration is the two-step
capability-gated swap documented in
`steering/04-principles.md` § 15.

## Permissions — `acp/permissions.ts`

`permissions.ts:requestPermissionStub` (`:14`) is the deferred
bridge for `session/request_permission`. **Returns**
`{ outcome: { outcome: 'cancelled' } }` per ACP's
`tool-calls.mdx` spec — gives an externally-connected ACP
agent speaking the same wire surface a spec-conforming refusal
instead of an opaque JSON-RPC error. The M0 permission bridge
itself (just-bash transform plugin classifier + persistent
allow-always semantics) is not implemented; the bash tool runs
without invoking it. Tracked in `milestones/deferred.md` and
re-enters at a post-M2 milestone kickoff. The stub is exported
from the public barrel so hosts that want to wire their own
permission UI can replace it when handing the runtime to
`ClientSideConnection`.

## Wire helpers — `acp/wire-utils.ts`

Pure functions (no side effects, no `this`). Called from the
adapter, the engine, and host code:

| Function | Line | Purpose |
| --- | --- | --- |
| `extractSessionMeta(meta)` | `:19` | Defensively coerces `_meta.bodhi` from `session/new` / `session/load` requests into `BodhiSessionMeta { requestedMcpUrls, mcpInstances }`. |
| `filterHttpServers(servers)` | `:46` | Drops anything that isn't an `McpServerHttp` from `params.mcpServers` (web-acp advertises `mcpCapabilities.http = true` only). |
| `toWireMcpToggles(snapshot)` | `:63` | `McpToggleSnapshot` (worker shape) → `BodhiMcpToggleSnapshot` (wire shape). Spreads to plain objects so JSON-RPC serialisation doesn't drag unexpected keys. |
| `toAvailableCommand(def)` | `:72` | `CommandDef` → ACP `AvailableCommand` (the picker wire shape). |
| `toolTitle(toolName, args)` | `:83` | Renders the `bash:` prefix + first-line preview for `tool_call.title`. |
| `toToolCallContent(content)` | `:95` | pi-agent-core tool-result content array → ACP `tool_call_update.content`. |
| `extractAssistantText(msg)` | `:110` | Joins all `text` parts of a pi-agent-core assistant message. |
| `extractMessageId(msg)` | `:128` | Returns `msg.id` when it's a string. |
| `BuiltinTagShape` | `:133` | `{ command, action? }` — shape stamped onto messages by `make…BuiltinMessage`. |
| `makeBuiltinUserMessage(text, tag)` | `:140` | Constructs the in-memory `AgentMessage` shape stamped with `_builtin: BuiltinTagShape` for `bodhi/getSession` replay. |
| `makeBuiltinAssistantMessage(text, tag)` | `:148` | Symmetric. |

## Cross-references

- Host-side ACP wire half:
  [`../web-acp-client/acp.md`](../web-acp-client/acp.md)
  (`AcpClient`, `streamingReducer`, `panelsReducer`,
  `dispatchBuiltinAction`, `fs/*` handlers).
- Per-session feature toggle flow (handler +
  `feature-config.ts` + `FeatureStore`):
  [`features.md`](./features.md).
- LLM provider + inline runtime: [`agent.md`](./agent.md).
- Storage interfaces:
  [`sessions.md`](./sessions.md),
  [`mcp.md`](./mcp.md).
- Volumes registry: [`volumes.md`](./volumes.md).
- Tools: [`tools.md`](./tools.md).
- Commands + built-ins: [`commands.md`](./commands.md).
- Boot flow:
  [`startup-sequence.md`](./startup-sequence.md).
- CLI host's adapter setup:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
