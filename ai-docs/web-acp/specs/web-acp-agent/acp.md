# ACP wire shim + engine layer

**Source of truth (agent package):** `packages/web-acp-agent/src/acp/`.

> **ACP 0.21 migration delta.** The adapter additionally implements
> `Agent.listSessions`, `Agent.closeSession`,
> `Agent.unstable_setSessionModel`, and `Agent.setSessionConfigOption`
> (M1). `bodhi/listModels` (M4), `bodhi/listSessions` (M2), and the
> `_bodhi/features/*` ext-method pair (M3) have been removed.
> `bodhi/getSession` remains live (M5 deferred). MCP lifecycle and
> builtin actions emit via `extNotification` (`_bodhi/mcp/state`,
> `_bodhi/builtin/action`) per M6 instead of riding empty
> `agent_message_chunk` envelopes. See
> [`index.md`](./index.md) header note for the full delta.

## Purpose

The agent package implements ACP's `Agent` interface in
`acp/agent-adapter.ts:AcpAgentAdapter`. The adapter is a thin
dispatch shim with **no business logic**: every ACP method
(`initialize`, `authenticate`, `newSession`, `loadSession`,
`listSessions`, `closeSession`, `unstable_setSessionModel`,
`setSessionConfigOption`, `prompt`, `cancel`, `extMethod`) routes
into the engine layer under `acp/engine/`. Mirrors coding-agent's
`modes/rpc/rpc-mode.ts` posture.

The `bootstrap.ts:startAcpAgent(transport, services, options)`
function is the only public entry point hosts use. It wraps
`transport` in `ndJsonStream`, constructs an
`AgentSideConnection`, and inside the connection's `toAgent`
factory builds an `AcpAgentAdapter(conn, services, options)`.

## Wire shim — `acp/agent-adapter.ts`

`acp/agent-adapter.ts:AcpAgentAdapter` implements the `Agent`
interface from `@agentclientprotocol/sdk`. Constructor takes
three arguments:

- `conn: AgentSideConnection` — supplied by the SDK on inbound
  attach; used by the engine for `sessionUpdate` emission.
- `services: AcpAdapterServices` — host-supplied infrastructure
  bag (see [services](#services--acpengineservicests) below).
- `options: AcpAgentAdapterOptions` — `{ isDev: boolean,
  buildVersion: string, acpSdkVersion: string }`. Hosts read
  these from build-tool defines and forward them across the
  package boundary; the agent package can't reach Vite's
  `define` / Node's `process.env` directly.

Owned members:

- `#runtime: AcpSessionRuntime` — lifecycle owner.
- `#driver: PromptTurnDriver` — single-turn engine.
- `#isDev: boolean` — DEV-feature gate (forwarded into the
  ext-method host).

ACP method implementations:

| Method | `agent-adapter.ts` location | Behaviour |
| --- | --- | --- |
| `initialize` | `:73` | Returns `protocolVersion: 1`, advertises `agentCapabilities.loadSession = (services.store !== undefined)`, `mcpCapabilities.http = true / sse = false`, `promptCapabilities.{image,audio,embeddedContext} = false`, the single auth method `bodhi-token`. |
| `authenticate` | `:98` | Validates `methodId === BODHI_AUTH_METHOD_ID`; reads `_meta` as `BodhiAuthenticateMeta { token, baseUrl }`; calls `services.bodhi.setAuthToken({ provider: 'bodhi', token, baseUrl })`. Resets the runtime model cache (`#runtime.setModels([])`) and the inline agent's history (`services.inline.clearMessages()`) so the next `listModels` re-fetches under the new token. |
| `newSession` | `:117` | Mints `sessionId = bodhi-${crypto.randomUUID()}`, filters MCP servers via `wire-utils.ts:filterHttpServers`, extracts `requestedMcpUrls` + `mcpInstances` via `wire-utils.ts:extractSessionMeta`, populates `runtime.setSession`, calls `services.store?.createSession(sessionId)`, clears inline history, marks the inline session active, acquires MCP connections, and refreshes the available-commands cache. |
| `loadSession` | `:150` | Replays a persisted session: validates the row exists, re-acquires MCP connections under the request's headers (when an existing session record exists, releases only its previously-held servers via `releaseMcpConnections(sessionId, existing.mcpServers)` before re-acquiring; on first load there is nothing to release), reads every entry via `services.store.readEntries`, re-emits each `'notification'` entry verbatim through `runtime.sendRawNotification` (no double-persist; `'turn'` and `'builtin'` entries skip the wire path), and reseeds the inline agent's history from the last `'turn'` entry's `finalMessages`. |
| `prompt` | `:201` | Single-line passthrough to `#driver.run(params)`. |
| `cancel` | `:205` | Calls `#driver.abort()`. |
| `extMethod` | `:209` | Dispatches `_bodhi/*` and `bodhi/*` methods via `dispatchExtMethod(method, params, this.#extMethodHost())`. |
| `dispose` | `:244` | Releases MCP connections + clears session map via `#runtime.dispose()`. |

`#extMethodHost()` (`:218`) builds the narrow facade
ext-method handlers consume — see
`acp/engine/types.ts:ExtMethodHost`.

## Services — `acp/engine/services.ts`

`acp/engine/services.ts` defines the deps bag the adapter
consumes:

- **`AcpAdapterServices`** (`services.ts:32`) — required:
  `inline: InlineAgent`, `bodhi: BodhiProvider`,
  `mcpPool: McpConnectionPool`, `commandsFs: CommandsFs`.
  Optional (gates features): `store?: SessionStore`,
  `registry?: VolumeRegistry`, `features?: FeatureStore`,
  `mcpToggles?: McpToggleStore`, `streamOverrides?:
  StreamOverridesRef`.
- **`AssembleServicesOptions`** (`services.ts:44`) — host-facing
  shape; same fields as `AcpAdapterServices` but with
  `mcpPool` and `commandsFs` optional.
- **`assembleServices(opts)`** (`services.ts:62`) — defaults
  `mcpPool` to `new McpConnectionPool()` and `commandsFs` to
  `createZenfsCommandsFs()`. The browser worker host calls this;
  the CLI host calls it identically (see
  `packages/cli-acp-client/src/services/assemble.ts`).
- **`StreamOverridesRef`** (`services.ts:18`) — per-turn
  override holder threaded between the driver and the stream
  function. The driver pushes `toolChoice` into `current`
  before each turn; the stream function (`agent/stream-fn.ts`)
  reads-and-clears so only the first LLM call of the turn sees
  the override.

## Engine layer — `acp/engine/`

### `acp/engine/types.ts`

Defines `SessionState` (the per-session in-memory record:
`id`, `mcpServers`, `requestedMcpUrls`, `mcpInstances`) and
`ExtMethodHost` — the narrow facade `dispatchExtMethod`
receives. `ExtMethodHost` exposes `bodhi`, `store`,
`registry`, `features`, `mcpToggles`, `mcpPool`, `inline`,
`sessions: Map<string, SessionState>`, `isDev`, plus accessors
`getModels`/`setModels`, `getActiveInlineSessionId`/`setActiveInlineSessionId`,
`readFeatures(sessionId)`, `readMcpToggles(sessionId)`.

### `acp/engine/session-runtime.ts:AcpSessionRuntime`

Lifecycle orchestrator. Owns:

- **Per-session map** (`#sessions`) — keyed by `sessionId`.
- **Active inline session id** (`#activeInlineSessionId`) — the
  `InlineAgent` carries one history at a time; this remembers
  which session's history is currently loaded so a `prompt`
  for a different session triggers `rehydrateInlineFromStore`
  rather than splicing contexts.
- **Cached vault command list** (`#availableCommands`) — shared
  across sessions because the vault is per-worker.
- **LLM model catalog** (`#models`) — populated by `listModels`
  and reset by `authenticate`.
- **MCP pool subscription** — the constructor calls
  `services.mcpPool.subscribe((event) => { void
  this.broadcastMcpPoolEvent(event); })` (a wrapper closure
  that retains `this` binding); the unsubscribe handle is
  released in `dispose`.

Notable methods (cite when extending):

- `acquireMcpConnections(sessionId, servers)` (`:140`),
  `releaseMcpConnections` (`:152`).
- `mcpToolsForSession(session, toggles)` (`:164`) — builds the
  per-turn MCP tool list, filtered by per-tool toggles
  (server-level filtering already happened upstream in
  `compose-mcp-servers`).
- `broadcastMcpPoolEvent(event)` (`:193`) — fans pool events
  out to all affected sessions as `_meta.bodhi.mcp` riding an
  empty `agent_message_chunk`. **Transient — does not
  persist.** Rationale: the pool rebuilds on every
  `loadSession` so persisting these would replay stale state.
- `rehydrateInlineFromStore(sessionId)` (`:227`) — reseeds the
  inline agent's history from the last `'turn'` entry. Falls
  back to `clearMessages` when no turn entry exists.
- `refreshAvailableCommands(sessionId)` (`:271`) — reloads
  vault commands + prompt templates from
  `services.commandsFs`, deduplicates (commands win on
  canonical-name collision; prompts losing get a `[prompts]`
  warning), merges with `builtinAvailableCommands()`, emits
  `available_commands_update`. Called once per `newSession`
  and per `loadSession`.
- `emit(notification)` (`:358`) — single exit point for every
  **persisted** `session/update`. Emits to client AND records
  via `services.store.recordNotification`.
- `sendRawNotification` (`:377`) — emits without persisting.
  Used by built-in replies (which persist as `'builtin'`
  entries instead) and `loadSession` replay (where the store
  already has the row).
- `sessionStatsFor`, `mcpConnectedFor` — helpers feeding the
  built-in handler context.

### `acp/engine/prompt-driver.ts:PromptTurnDriver`

Single prompt-turn loop. Owns per-turn state
(`#turnAbort: AbortController`, `#cancelled: boolean`).
`run(params)` (`:76`) does:

1. **Built-in early return** — if the prompt is a built-in
   slash command (`tryHandleBuiltin`, see
   [builtin-dispatch](#acpengine--builtin-dispatchts) below),
   the driver emits the muted reply, persists a `'builtin'`
   entry, and returns without touching the inline agent.
2. **Model resolution** — reads `_meta.bodhi.modelId` and looks
   it up in `runtime.getModels()`. Throws `'No model
   selected: …'` if absent. Hosts must run `bodhi/listModels`
   before the first `prompt`.
3. **Slash-command expansion** — the last text block is fed
   through `agent/commands/expander.ts:expandCommand` against
   the cached command list; if matched, the block's text is
   replaced with the rendered template.
4. **History attach guard** — if
   `runtime.getActiveInlineSessionId() !== sessionId`, calls
   `runtime.rehydrateInlineFromStore(sessionId)`.
5. **Per-turn tool list** — bash tool (gated on
   `featureSnapshot.bashEnabled && registry.list().length > 0
   && services.registry`) plus enabled MCP tools. Each tool is
   wrapped via the local `bindAbortSignal` helper so
   `session/cancel` short-circuits the running `execute` call.
6. **System prompt** — `composeSystemPrompt(volumes)` —
   includes per-volume descriptors so the LLM knows each mount.
7. **Stream override push** — when `featureSnapshot.forceToolCall
   && isDev && tools.length > 0`, sets
   `streamOverrides.current = { toolChoice: 'required' }`.
8. **Stream subscribe + prompt** — installs
   `services.inline.subscribe(forwardEvent)` and awaits
   `services.inline.prompt(text)`.
9. **Persist** — on success, `services.store.recordTurn(
   sessionId, text, services.inline.getMessages(), model.id)`.
10. **Cleanup** — unsubscribe, clear stream overrides, drop
    the abort controller. Returns `{ stopReason: 'end_turn' }`
    or `'cancelled'`.

`abort()` (`:184`) sets `#cancelled = true`, aborts the
per-turn signal, and calls `services.inline.cancel()`.

`#forwardEvent(sessionId, event, cursor, toolState)` (`:237`)
translates inline-agent events to ACP `session/update`
notifications. The streaming-text path is the one place the
delta logic earns a snippet:

```ts
// prompt-driver.ts:243–266 (extract)
if (event.type === "message_update") {
    const msg = event.message;
    if (msg.role !== "assistant") return;

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
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: delta },
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

Entry point for the M4 phase B "agent-handled built-in"
contract. Returns `PromptResponse | null`:

- `null` → input wasn't a built-in; caller falls through to the
  LLM path.
- `{ stopReason: 'end_turn' }` → input matched; the chunk is
  emitted and the `'builtin'` store entry is written before
  this returns.

Built-in detection: `findBuiltin(rawText)` from
`agent/commands/builtins/index.ts`. The handler context
(`BuiltinHandlerCtx`) is assembled from runtime accessors:
`sessionId`, `modelId` (from `_meta.bodhi.modelId`),
`serverUrl`, `sessionStats`, `mcpServersConnected`,
`mcpInstances`, `requestedMcpUrls`, `advertisedCommands`
(builtins + vault commands), `inlineMessages`, plus
`buildVersion` / `acpSdkVersion`.

The reply rides `agent_message_chunk` with
`_meta.bodhi.builtin = { command, action? }`. Action shape is
the discriminated `BodhiBuiltinAction<K, P>` union (see
[commands.md](./commands.md)). Persistence rides through
`store.recordBuiltin(sessionId, { command, userText, replyText,
action? })`. Built-in replies emit directly via
`conn.sessionUpdate(...)` (the SDK call) inside
`builtin-dispatch.ts` — they do **not** route through
`runtime.sendRawNotification` and do **not** double-persist
as `'notification'` entries; the `'builtin'` entry is the
source of truth for replay.

### `acp/engine/ext-methods/`

One file per `_bodhi/*` / `bodhi/*` extension method. The
registry at `ext-methods/index.ts:HANDLERS` maps method names
to handlers and the public dispatcher
`dispatchExtMethod(method, params, host)` resolves it (throws
`'Unknown extension method: ...'` on miss).

| Handler | Method | Behaviour |
| --- | --- | --- |
| `list-models.ts:listModels` | `bodhi/listModels` | Calls `host.bodhi.getAvailableModels()`, caches result via `host.setModels(models)`, returns `{ models: [{ id, apiFormat }] }`. |
| `list-sessions.ts:listSessions` | `bodhi/listSessions` | Returns `{ sessions: host.store?.listSummaries() ?? [] }`. |
| `get-session.ts:getSession` | `bodhi/getSession` | Validates the session row exists; returns the rebuilt snapshot (`messages`, `lastModelId`, `title`, `mcpToggles`) by interleaving stored `'turn'` and `'builtin'` entries. The `BodhiBuiltinTag` marker is stamped on the user/assistant pair so the host can render the muted-builtin badge. |
| `volumes-list.ts:volumesList` | `_bodhi/volumes/list` | Returns `{ volumes: host.registry?.list() }` mapped to `BodhiVolumeDescriptor`. |
| `features-list.ts:featuresList` | `_bodhi/features/list` | Validates `params.sessionId`; returns `{ features: host.readFeatures(sessionId), defaults: FEATURE_DEFAULTS }`. |
| `features-set.ts:featuresSet` | `_bodhi/features/set` | Validates `{ sessionId, key, value }`; rejects unknown keys via `isFeatureKey`; rejects `forceToolCall` when `!host.isDev` (throws with `code: -32004`); persists via `host.features.set(sessionId, key, value)` + returns the updated bag. |
| `mcp-toggles-set.ts:mcpTogglesSet` | `_bodhi/mcp/toggles/set` | Validates the params shape (server-only override OR `{serverSlug, toolName}`); dispatches to `host.mcpToggles.setServer` or `host.mcpToggles.setTool` based on whether `toolName` is present (the `McpToggleStore` interface has no flat `set`); returns the wire snapshot via `wire-utils.ts:toWireMcpToggles`. |
| `sessions-delete.ts:sessionsDelete` | `_bodhi/sessions/delete` | Idempotent: returns `{ deleted: false }` when the row is unknown. Order: `host.mcpPool.releaseAll(sessionId)` → `host.sessions.delete(sessionId)` → clear inline messages if this is the active inline session → `host.store.deleteSession` for the row + entries + features + mcpToggles cleanup. |

When upstream ACP adds a stable verb for one of these
(e.g. `session/list`, `session/delete`), the migration is the
two-step capability-gated swap documented in
`steering/04-principles.md` § 15.

## Permissions — `acp/permissions.ts`

`permissions.ts:requestPermissionStub` is the deferred bridge
for `session/request_permission`. **Throws** an `Error`
(`requestPermission: not supported in web-acp M0`) — the
M0 permission bridge is not implemented; the bash tool runs
without invoking it. The just-bash transform plugin
classifier + persistent allow-always semantics are tracked in
`milestones/deferred.md` and re-enter at a post-M2 milestone
kickoff. The stub is exported from the public barrel so hosts
that want to wire their own permission UI can replace it
when handing the runtime to `ClientSideConnection`.

## Wire helpers — `acp/wire-utils.ts`

Pure functions (no side effects, no `this`). Called from the
adapter, the engine, and host code:

| Function | Purpose |
| --- | --- |
| `extractSessionMeta(meta)` (`:24`) | Defensively coerces `_meta.bodhi` from `session/new` / `session/load` requests into `BodhiSessionMeta { requestedMcpUrls, mcpInstances }`. |
| `filterHttpServers(servers)` (`:56`) | Drops anything that isn't an `McpServerHttp` from `params.mcpServers` (web-acp advertises `mcpCapabilities.http = true` only). |
| `toWireMcpToggles(snapshot)` (`:79`) | `McpToggleSnapshot` (worker shape) → `BodhiMcpToggleSnapshot` (wire shape). |
| `toAvailableCommand(def)` (`:86`) | `CommandDef` → ACP `AvailableCommand` (the picker wire shape). |
| `toolTitle(toolName, args)` (`:97`) | Renders the `bash:` prefix + first-line preview for `tool_call.title`. |
| `toToolCallContent(content)` (`:109`) | pi-agent-core tool-result content array → ACP `tool_call_update.content`. |
| `extractAssistantText(msg)` (`:122`) | Joins all `text` parts of a pi-agent-core assistant message. |
| `extractMessageId(msg)` (`:134`) | Returns `msg.id` when it's a string. |
| `makeBuiltinUserMessage(text, tag)` / `makeBuiltinAssistantMessage(text, tag)` (`:151,159`) | Construct the in-memory `AgentMessage` shape stamped with `_builtin: BuiltinTagShape` for `bodhi/getSession` replay. |

## Cross-references

- Host-side ACP wire half:
  [`../web-acp-client/acp.md`](../web-acp-client/acp.md)
  (`AcpClient`, `streamingReducer`, host-side
  `dispatchBuiltinAction`, `fs/*` handlers).
- LLM provider + inline runtime: [`agent.md`](./agent.md).
- Storage interfaces:
  [`sessions.md`](./sessions.md),
  [`features.md`](./features.md),
  [`mcp.md`](./mcp.md).
- Volumes registry: [`volumes.md`](./volumes.md).
- Tools: [`tools.md`](./tools.md).
- Commands + built-ins: [`commands.md`](./commands.md).
- Boot flow:
  [`startup-sequence.md`](./startup-sequence.md).
- CLI host's adapter setup:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
