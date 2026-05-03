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
| `AcpAgentAdapter` | `acp/agent-adapter.ts:53` | Implements ACP's `Agent` interface; delegates to the engine layer. |
| `AcpSessionRuntime` | `acp/engine/session-runtime.ts:37` | Per-session lifecycle owner. |
| `PromptTurnDriver` | `acp/engine/prompt-driver.ts:49` | Single prompt-turn loop. |
| `dispatchExtMethod` | `acp/engine/ext-methods/index.ts:34` | `_bodhi/*` extension method registry. |
| `BodhiProvider` (default) | `agent/bodhi-provider.ts:35` | `LlmProvider` impl — token storage, model catalog fetch. |
| `InlineAgent` | `agent/inline-agent.ts:29` | `pi-agent-core` wrapper. |
| `McpConnectionPool` | `agent/mcp/connection-pool.ts:71` | Refcounted MCP connection cache. |
| `ZenfsVolumeRegistry` | `agent/volume-registry.ts:55` | `/mnt/<name>` mount registry. |

## Phase 1 — Bootstrap

The host calls:

```ts
startAcpAgent(
    transport,                 // { readable, writable } byte-stream pair
    services: AcpAdapterServices,
    options: { isDev, buildVersion, acpSdkVersion },
);
```

Inside `bootstrap.ts:startAcpAgent` (`:32`):

1. `stream = ndJsonStream(transport.writable, transport.readable)`
   wraps the byte streams in NDJSON framing.
2. `new AgentSideConnection((conn) => { … }, stream)` —
   the SDK's connection constructor invokes `toAgent(conn)`
   synchronously to build the `Agent` implementation.
3. Inside `toAgent`:
   - `adapter = new AcpAgentAdapter(conn, services, options)`.
   - `options.onAdapter?.(adapter)` — callback so the host
     can hold a reference for `dispose()` on teardown.
   - Returns `adapter`.

The `AcpAgentAdapter` constructor (`acp/agent-adapter.ts:59`)
synchronously builds:

- `#runtime = new AcpSessionRuntime(conn, services)` — sets up
  the MCP pool subscription + initialises the empty session
  map.
- `#driver = new PromptTurnDriver({ conn, services, runtime,
  buildVersion, acpSdkVersion, isDev })`.

After `startAcpAgent` returns, the agent is ready to receive
`initialize` from the client. No work happens until the
client makes the first call.

## Phase 2 — `initialize` handshake

Client sends `initialize({ protocolVersion, clientCapabilities })`.

`AcpAgentAdapter.initialize` (`acp/agent-adapter.ts:73`)
returns:

```json
{
    "protocolVersion": 1,
    "agentCapabilities": {
        "loadSession": <true if services.store !== undefined>,
        "mcpCapabilities": { "http": true, "sse": false },
        "promptCapabilities": {
            "image": false, "audio": false, "embeddedContext": false
        }
    },
    "authMethods": [
        { "id": "bodhi-token", "name": "Bodhi token",
          "description": "Push a Bodhi access token from the main thread." }
    ]
}
```

The `loadSession` flag is conditional on whether the host
provided a `SessionStore`. CLI host = yes (in-memory store);
browser host = yes (Dexie store); a hypothetical
no-persistence host could pass `services.store = undefined`
and the agent would advertise `loadSession: false`.

The `mcpCapabilities.http = true / sse = false` advertisement
matches the agent's
`agent/mcp/client.ts:createMcpClient` which only consumes the
Streamable HTTP transport.

## Phase 3 — `authenticate`

Client sends `authenticate({ methodId: 'bodhi-token', _meta:
{ token, baseUrl } })`.

`AcpAgentAdapter.authenticate` (`acp/agent-adapter.ts:98`):

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
   - `runtime.setModels([])` — next `bodhi/listModels` call
     re-fetches under the new token.
   - `services.inline.clearMessages()` — the inline agent
     drops its history; the client should follow up with
     `loadSession` if it wants to resume a session under the
     new auth.

Returns `{}`.

The agent does **not** verify the token here — that happens
implicitly on the next `bodhi/listModels` call when the
provider tries to fetch the catalog. Errors surface as a
JSON-RPC reject from `extMethod` then.

## Phase 4 — `bodhi/listModels`

Client calls `extMethod('bodhi/listModels', {})`.

`acp/engine/ext-methods/list-models.ts:listModels`:

```ts
const models = await host.bodhi.getAvailableModels();
host.setModels(models);
return { models: models.map((m) => ({ id: m.id, apiFormat: apiFormatOfModel(m) })) };
```

`BodhiProvider.getAvailableModels` (`agent/bodhi-provider.ts:53`):

1. `requireCredentials()` — throws if `setAuthToken` hasn't
   run with a Bodhi credential.
2. `fetch(${baseUrl}/bodhi/v1/models?page_size=100,
   { headers: { Authorization: 'Bearer ' + token } })`.
3. On non-OK response: throws `'Failed to fetch Bodhi model
   catalog: <status> <statusText> — <body>'`.
4. Flattens the paginated response via `flattenAlias` per
   entry — alias entries (Bodhi's API-key wrappers) yield one
   `Model<Api>` per underlying provider model; local aliases
   yield one `Model<Api>` each.

The runtime caches the flattened list in
`AcpSessionRuntime.#models`. Subsequent prompts read from the
cache via `runtime.getModels()` — the host doesn't need to
re-issue `listModels` per turn.

## Phase 5 — Session creation

Client calls `newSession({ cwd, mcpServers, _meta?.bodhi })`.

`AcpAgentAdapter.newSession` (`acp/agent-adapter.ts:117`):

1. `sessionId = 'bodhi-' + crypto.randomUUID()`.
2. `mcpServers = filterHttpServers(params.mcpServers ?? [])` —
   drops any non-HTTP entries the client sent.
3. `sessionMeta = extractSessionMeta(params._meta)` — picks
   `requestedMcpUrls` and `mcpInstances` off `_meta.bodhi`.
4. `runtime.setSession(sessionId, { id, mcpServers,
   requestedMcpUrls, mcpInstances })`.
5. `services.store?.createSession(sessionId)` — write the
   row.
6. `services.inline.clearMessages()` — fresh history.
7. `runtime.setActiveInlineSessionId(sessionId)`.
8. `await runtime.acquireMcpConnections(sessionId, mcpServers)`
   — opens connections via the pool. Errors per-server are
   logged; one bad MCP doesn't break the session. Pool
   lifecycle events (`connecting`, `connected`, `error`,
   `disconnected`) flow into the client through
   `runtime.broadcastMcpPoolEvent`.
9. `await runtime.refreshAvailableCommands(sessionId)` —
   loads vault commands + prompt templates from
   `services.commandsFs`, deduplicates, merges with
   `builtinAvailableCommands()`, emits the
   `available_commands_update` notification.

Returns `{ sessionId }`.

## Phase 5b — Session reload

Client calls `loadSession({ sessionId, cwd, mcpServers,
_meta?.bodhi })`. Available only when `agentCapabilities.loadSession`
was advertised true.

`AcpAgentAdapter.loadSession` (`acp/agent-adapter.ts:150`):

1. `store.getSession(sessionId)` — throws if unknown.
2. Releases prior MCP connections under the old config (if
   the session was already in memory) before re-acquiring
   under the new headers — lets the pool re-key by
   fingerprint.
3. `runtime.setSession(...)` with the new mcpServers + meta.
4. `store.readEntries(sessionId)` — iterate every persisted
   entry:
   - `'notification'` → `runtime.sendRawNotification(payload)`
     re-emits to the client without persisting (the store
     already has it).
   - `'turn'` → captures `payload.finalMessages` for the
     last-turn history seed.
   - `'builtin'` entries are intentionally **not** re-emitted
     on the wire — the host calls `bodhi/getSession` after
     `loadSession` resolves to rebuild the muted-builtin
     bubbles with their `_meta.bodhi.builtin` envelope.
5. `services.inline.restoreMessages(lastTurnMessages)` if
   any; else `services.inline.clearMessages()`.
6. `runtime.setActiveInlineSessionId(sessionId)`.
7. `runtime.acquireMcpConnections + refreshAvailableCommands`
   (same as `newSession`).

Returns `{}` — ACP's stable `LoadSessionResponse` is
intentionally minimal; the snapshot rebuild rides through the
follow-up `bodhi/getSession` extension method.

## Phase 6 — First prompt

Client calls `prompt({ sessionId, prompt: [{ type: 'text',
text }], _meta: { bodhi: { modelId } } })`.

`AcpAgentAdapter.prompt` is a one-line passthrough to
`#driver.run(params)`. The full prompt-turn flow — built-in
early return, model resolution, slash-command expansion,
history-attach guard, per-turn tool list assembly, system
prompt composition, stream-override toggle, stream subscribe,
inline-event → ACP-notification translation, persistence, and
the `{ stopReason: 'end_turn' | 'cancelled' }` return — is
the canonical responsibility of `PromptTurnDriver` and is
documented in detail at [`acp.md`](./acp.md) § PromptTurnDriver.
This file does not duplicate the step list — read `acp.md`
when you need to trace the prompt loop.

## Phase 6b — Cancellation

Client sends `cancel({ sessionId })` while a prompt is in
flight.

`AcpAgentAdapter.cancel` calls `#driver.abort()`
(`acp/engine/prompt-driver.ts:184`):

1. `#cancelled = true`.
2. `#turnAbort?.abort()` — every per-turn tool sees the
   abort signal flip and short-circuits.
3. `services.inline.cancel()` — `pi-agent-core`'s `Agent`
   stops streaming.

`#driver.run` then resolves with `{ stopReason: 'cancelled'
}`. The cancelled run is **not persisted** as a turn (the
store would have a `'turn'` entry with truncated assistant
text otherwise).

## Phase 7 — Subsequent prompts + extension methods

After Phase 6, the agent is in steady state. The client may:

- Send more `prompt` calls (each a fresh turn).
- Issue `cancel` mid-turn.
- Call extension methods:
  - `bodhi/listSessions` → list summaries.
  - `bodhi/getSession` → session snapshot rebuild
    (interleaves `'turn'` and `'builtin'` entries with the
    `_builtin` marker stamped).
  - `_bodhi/volumes/list` → volume snapshot.
  - `_bodhi/features/list` / `_bodhi/features/set` → feature
    toggles.
  - `_bodhi/mcp/toggles/set` → server / tool overrides.
  - `_bodhi/sessions/delete` → idempotent delete.

Each extension method dispatches through
`acp/engine/ext-methods/index.ts:dispatchExtMethod` to a
single per-method handler. See [`acp.md`](./acp.md) §
ext-methods for the full table.

## Teardown

Host calls `adapter.dispose()` (`acp/agent-adapter.ts:244`)
during shutdown. Internally:

1. `#runtime.dispose()` — unsubscribes from the MCP pool,
   releases every `(sessionId, server)` pair, clears the
   session map.
2. The host should also close the transport (writable side)
   so `ndJsonStream` flushes pending output.

After `dispose`, the adapter is unusable; further ACP method
calls reject.

## Cross-references

- ACP wire shim + engine layer:
  [`acp.md`](./acp.md).
- LLM provider runtime:
  [`agent.md`](./agent.md).
- Browser host's React-side boot flow:
  [`../web-acp-client/startup-sequence.md`](../web-acp-client/startup-sequence.md).
- CLI host's TTY boot flow:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md)
  § "Boot sequence".
