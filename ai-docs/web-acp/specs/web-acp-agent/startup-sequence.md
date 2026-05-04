# Startup sequence — host-neutral ACP boot + per-session lifecycle

**Source of truth:** `packages/web-acp-agent/src/`.

## Purpose

The wire-flow narrative for `@bodhiapp/web-acp-agent`,
**independent of any host**. Describes what happens between
the moment a host hands a transport + services bag to
`startAcpAgent` and the moment the LLM emits the first
streaming chunk. Valid for the browser host, the CLI host,
and any future host that consumes the agent package.

For host-specific boot details (React mount, FSA volume
resolution, OAuth flow, etc.), follow the cross-links to
[`../web-acp-client/startup-sequence.md`](../web-acp-client/startup-sequence.md)
or [`../cli-acp-client/index.md`](../cli-acp-client/index.md).

## Actors

| Actor | File | Owns |
| --- | --- | --- |
| `startAcpAgent` | `bootstrap.ts:28` | Frames `ndJsonStream` over the host's transport pair; constructs the `AgentSideConnection` + adapter. |
| `AcpAgentAdapter` | `acp/agent-adapter.ts:57` | Implements ACP's `Agent` interface; delegates to per-concern handlers. |
| Per-method handlers | `acp/handlers/{initialize,session-crud}.ts` | Stateless functions taking `AcpAdapterContext` — own all business logic for the standard ACP surface. |
| `AcpAdapterContext` | `acp/handlers/adapter-context.ts:6` | Frozen-shape bag (`services`, `runtime`, `driver`, `isDev`, `buildVersion`) handed to every handler. |
| `AcpSessionRuntime` | `acp/engine/session-runtime.ts:34` | Per-session lifecycle owner (state map, MCP pool subscription, model cache, vault commands cache). |
| `PromptTurnDriver` | `acp/engine/prompt-driver.ts` | Single prompt-turn loop. |
| `dispatchExtMethod` | `acp/engine/ext-methods/index.ts:31` | `_bodhi/*` extension method registry (5 methods). |
| `BodhiProvider` (default) | `agent/bodhi-provider.ts:41` | `LlmProvider` impl — token storage, model catalog fetch. |
| `InlineAgent` | `agent/inline-agent.ts:29` | `pi-agent-core` wrapper. |
| `McpConnectionPool` | `agent/mcp/connection-pool.ts:71` | Refcounted MCP connection cache. |
| `ZenfsVolumeRegistry` | `agent/volume-registry.ts:55` | `/mnt/<name>` mount registry. |

## Phase 1 — Bootstrap

The host calls:

```ts
startAcpAgent(
    transport,                 // { readable, writable } byte-stream pair
    services: AcpAdapterServices,
    options: { isDev, buildVersion, acpSdkVersion, onAdapter? },
);
```

Inside `bootstrap.ts:startAcpAgent` (`:28`):

1. `stream = ndJsonStream(transport.writable, transport.readable)`
   wraps the byte streams in NDJSON framing.
2. `new AgentSideConnection((conn) => { … }, stream)` — the
   SDK's connection constructor invokes `toAgent(conn)`
   synchronously to build the `Agent` implementation.
3. Inside `toAgent`:
   - `adapter = new AcpAgentAdapter(conn, services, { isDev,
     buildVersion, acpSdkVersion })`.
   - `options.onAdapter?.(adapter)` — callback so the host
     can hold a reference for `dispose()` on teardown.
   - Returns `adapter`.

The `AcpAgentAdapter` constructor (`acp/agent-adapter.ts:63`)
synchronously builds:

- `#services = services`.
- `#runtime = new AcpSessionRuntime(conn, services)` — sets up
  the MCP pool subscription + initialises the empty session
  map.
- `#driver = new PromptTurnDriver({ conn, services, runtime,
  buildVersion, acpSdkVersion, isDev })`.
- `#ctx = { services, runtime, driver, isDev, buildVersion }`
  — the shared bag handlers receive.

After `startAcpAgent` returns, the agent is ready to receive
`initialize` from the client. No work happens until the
client makes the first call. **No model catalog is fetched up
front** — that's lazy, see Phase 5.

## Phase 2 — `initialize` handshake

Client sends `initialize({ protocolVersion, clientCapabilities })`.

`AcpAgentAdapter.initialize` (`acp/agent-adapter.ts:87`)
delegates to `acp/handlers/initialize.ts:handleInitialize`
which returns:

```json
{
    "protocolVersion": <PROTOCOL_VERSION from SDK>,
    "agentInfo": { "name": "Bodhi Web ACP", "version": "<buildVersion>" },
    "agentCapabilities": {
        "loadSession": <true if services.store !== undefined>,
        "mcpCapabilities": { "http": true, "sse": false },
        "promptCapabilities": {
            "image": false, "audio": false, "embeddedContext": false
        },
        "sessionCapabilities": {
            "list": <{} if services.store !== undefined>,
            "close": {}
        }
    },
    "authMethods": [
        { "id": "bodhi-token", "name": "Bodhi token",
          "description": "Push a Bodhi access token from the main thread." }
    ]
}
```

The `loadSession` and `sessionCapabilities.list` advertisements
are conditional on whether the host provided a `SessionStore`.
CLI host = yes (in-memory store); browser host = yes (Dexie
store); a hypothetical no-persistence host could pass
`services.store = undefined` and the agent would advertise
`loadSession: false` and omit `sessionCapabilities.list`.

The `mcpCapabilities.http = true / sse = false` advertisement
matches the agent's
`agent/mcp/client.ts:createMcpClient` which only consumes the
Streamable HTTP transport.

## Phase 3 — `authenticate`

Client sends `authenticate({ methodId: 'bodhi-token', _meta:
{ token, baseUrl } })`.

`AcpAgentAdapter.authenticate` (`:91`) delegates to
`acp/handlers/initialize.ts:handleAuthenticate`:

1. Validates `methodId === BODHI_AUTH_METHOD_ID`. Throws
   `'Unsupported auth method: ...'` otherwise.
2. Reads `_meta` as `BodhiAuthenticateMeta`. Throws
   `'authenticate: _meta must include { token, baseUrl }'` if
   either field is missing.
3. Calls `services.bodhi.setAuthToken({ provider: 'bodhi',
   token, baseUrl })` — the default `BodhiProvider` stores
   both fields. Custom `LlmProvider` implementations may do
   different things.
4. Resets caches:
   - `runtime.setModels([])` — next `ensureModelsLoaded` call
     re-fetches the catalog under the new credential.
   - `services.inline.clearMessages()` — the inline agent
     drops its history; the client should follow up with
     `loadSession` if it wants to resume a session under the
     new auth.

Returns `{}`.

The agent does **not** verify the token here — that happens
implicitly on the next `newSession`/`loadSession` when
`tryEnsureModels` triggers a catalog fetch. Errors are caught
(catalog fetch failure is non-fatal — the session still
creates and `models?` is omitted from the response).

## Phase 4 — Session creation (catalog lazy-loads here)

Client calls `newSession({ cwd, mcpServers, _meta?.bodhi })`.

`AcpAgentAdapter.newSession` (`:95`) delegates to
`acp/handlers/session-crud.ts:handleNewSession`:

1. `sessionId = 'bodhi-' + crypto.randomUUID()`.
2. `mcpServers = filterHttpServers(params.mcpServers ?? [])` —
   drops any non-HTTP entries the client sent.
3. `sessionMeta = extractSessionMeta(params._meta)` — picks
   `requestedMcpUrls` and `mcpInstances` off `_meta.bodhi`.
4. `runtime.setSession(sessionId, { id, mcpServers,
   requestedMcpUrls, mcpInstances, currentModelId: null })`.
5. `services.store?.createSession(sessionId)` — write the
   row.
6. `services.inline.clearMessages()` — fresh history.
7. `runtime.setActiveInlineSessionId(sessionId)`.
8. `await runtime.acquireMcpConnections(sessionId, mcpServers)`
   — opens connections via the pool. Errors per-server are
   logged; one bad MCP doesn't break the session. Pool
   lifecycle events (`connecting`, `connected`, `error`,
   `disconnected`) flow into the client through
   `runtime.broadcastMcpPoolEvent` →
   `extNotification("_bodhi/mcp/state", …)`.
9. `await runtime.refreshAvailableCommands(sessionId)` —
   loads vault commands + prompt templates from
   `services.commandsFs`, deduplicates, merges with
   `builtinAvailableCommands()`, emits the
   `available_commands_update` notification.
10. `models = await tryEnsureModels(ctx)` — first call to
    `runtime.ensureModelsLoaded()` triggers the
    `BodhiProvider.getAvailableModels()` fetch (subsequent
    sessions hit the cache). Wrapped in try/catch so a
    catalog failure doesn't block session creation.
11. Default-seed model: `defaultModelId = models[0]?.id ??
    null`; `runtime.setSessionModel(sessionId,
    defaultModelId)`.
12. Build response: `{ sessionId, models?, configOptions }`.
    - `models?` = `SessionModelState { availableModels,
      currentModelId }` only when the catalog is non-empty.
    - `configOptions` = `buildFeatureConfigOptions(snapshot,
      isDev)` — the per-session feature toggles (see
      [`features.md`](./features.md)).

## Phase 4b — Session reload

Client calls `loadSession({ sessionId, cwd, mcpServers,
_meta?.bodhi })`. Available only when
`agentCapabilities.loadSession` was advertised true.

`AcpAgentAdapter.loadSession` (`:99`) delegates to
`acp/handlers/session-crud.ts:handleLoadSession`:

1. `store.getSession(sessionId)` — throws if unknown.
2. Releases prior MCP connections under the **previous**
   per-session config (if the session was already in memory)
   so the pool can re-key under new headers without dropping
   servers the caller wants to keep.
3. `runtime.setSession(...)` with the new mcpServers + meta;
   `currentModelId: row.lastModelId` seeds the previously-used
   model.
4. `store.readEntries(sessionId)` — iterate every persisted
   entry via the shared `walkEntries(notification + turn)`
   walker:
   - `'notification'` → `runtime.sendRawNotification(payload)`
     re-emits to the client without persisting (the store
     already has it).
   - `'turn'` → captures `payload.finalMessages` for the
     last-turn history seed.
   - `'builtin'` entries are intentionally **not** re-emitted
     on the wire by `loadSession` — the host calls
     `_bodhi/session/get` after `loadSession` resolves to
     rebuild the muted-builtin bubbles. (TODO at
     `acp/handlers/session-crud.ts:93` tracks folding the
     builtin transcript into `loadSession` itself; M5
     deferred.)
5. `services.inline.restoreMessages(lastTurnMessages)` if
   any; else `services.inline.clearMessages()`.
6. `runtime.setActiveInlineSessionId(sessionId)`.
7. `runtime.acquireMcpConnections + refreshAvailableCommands`
   (same as `newSession`).
8. `models = await tryEnsureModels(ctx)`; `seededModelId =
   resolveSeededModelId(models, row.lastModelId)`;
   `runtime.setSessionModel(sessionId, seededModelId)`.
9. Build response: `{ models?, configOptions, _meta.bodhi:
   { title, mcpToggles } }`. Title + mcpToggles ride
   `_meta.bodhi` so the host UI can rebuild picker label +
   toggle state in a single round trip.

## Phase 5 — First prompt

Client calls `prompt({ sessionId, prompt: [{ type: 'text',
text }] })`.

`AcpAgentAdapter.prompt` is a one-line passthrough to
`#driver.run(params)`. The full prompt-turn flow — built-in
early return, model resolution (reads
`SessionState.currentModelId`, no per-prompt `_meta` envelope),
slash-command expansion, history-attach guard, per-turn tool
list assembly, system prompt composition, stream-override
toggle, stream subscribe, inline-event → ACP-notification
translation, persistence, and the `{ stopReason: 'end_turn' |
'cancelled' }` return — is the canonical responsibility of
`PromptTurnDriver` and is documented in detail at
[`acp.md`](./acp.md) § PromptTurnDriver. This file does not
duplicate the step list — read `acp.md` when you need to
trace the prompt loop.

The client switches the session's selected model via
`Agent.unstable_setSessionModel({ sessionId, modelId })`
between turns; the driver reads the latest selection from
`SessionState.currentModelId` at the start of each turn.

## Phase 5b — Cancellation

Client sends `cancel({ sessionId })` while a prompt is in
flight.

`AcpAgentAdapter.cancel` (`:125`) delegates to
`acp/handlers/session-crud.ts:handleCancel` which calls
`#driver.abortIfActive(params.sessionId)` — only aborts when
the driver's `#promptSessionId === sessionId` (guards against
aborting an unrelated session's turn since the driver is
single-instance for the worker).

The driver's `abort()` path:

1. `#cancelled = true`.
2. `#turnAbort?.abort()` — every per-turn tool sees the
   abort signal flip and short-circuits.
3. `services.inline.cancel()` — `pi-agent-core`'s `Agent`
   stops streaming.

`#driver.run` then resolves with `{ stopReason: 'cancelled' }`.
The cancelled run is **not persisted** as a turn (the store
would have a `'turn'` entry with truncated assistant text
otherwise).

## Phase 6 — Subsequent prompts + extension methods

After Phase 5, the agent is in steady state. The client may:

- Send more `prompt` calls (each a fresh turn).
- Issue `cancel` mid-turn.
- Switch the session's model:
  `unstable_setSessionModel({ sessionId, modelId })`.
- Toggle a feature: `setSessionConfigOption({ sessionId,
  configId, value })`.
- Issue `listSessions` for the session picker.
- Issue `closeSession` to drop the in-memory state (keeps the
  persisted row).
- Call extension methods:
  - `_bodhi/session/get` (legacy alias `bodhi/getSession`,
    warned-once on first use) → session snapshot rebuild
    (interleaves `'turn'` and `'builtin'` entries via
    `walkEntries`).
  - `_bodhi/volumes/list` → volume snapshot.
  - `_bodhi/mcp/toggles/set` → server / tool overrides.
    Server-off forces pool eviction across refcounts.
  - `_bodhi/sessions/delete` → idempotent delete (drops the
    persisted row + in-memory state via
    `runtime.tearDownSession`).

Each extension method dispatches through
`acp/engine/ext-methods/index.ts:dispatchExtMethod` to a
single per-method handler (5 methods total — the legacy
`bodhi/listModels`, `bodhi/listSessions`,
`_bodhi/features/list`, `_bodhi/features/set` methods are
gone, replaced by standard ACP methods). See
[`acp.md`](./acp.md) § ext-methods for the full table.

## Teardown

Host calls `adapter.dispose()` (`:163`) during shutdown.
Internally:

1. `#runtime.dispose()` — unsubscribes from the MCP pool,
   releases every `(sessionId, server)` pair, clears the
   session map. Idempotent. Does **not** abort in-flight
   turns — the host must call `cancel` first.
2. The host should also close the transport (writable side)
   so `ndJsonStream` flushes pending output.

After `dispose`, the adapter is unusable; further ACP method
calls reject.

## Cross-references

- ACP wire shim + handler + engine layer:
  [`acp.md`](./acp.md).
- LLM provider runtime + lazy model catalog:
  [`agent.md`](./agent.md).
- Per-session feature toggle wire path:
  [`features.md`](./features.md).
- Browser host's React-side boot flow:
  [`../web-acp-client/startup-sequence.md`](../web-acp-client/startup-sequence.md).
- CLI host's TTY boot flow:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md)
  § "Boot sequence".
