# MCP — client, pool, tool adapter, toggle store

**Source of truth (agent package):**
`packages/web-acp-agent/src/agent/mcp/`,
`packages/web-acp-agent/src/storage/mcp-toggle-store.ts`,
`packages/web-acp-agent/src/mcp/url-canonical.ts`.

## Purpose

The agent runs as an MCP **client** — it connects to one or
more remote MCP servers (over Streamable HTTP only) and
adapts each remote tool into a `pi-agent-core` `AgentTool` so
the LLM can call them through the standard tool-call path.

Per-session MCP server lists arrive on `session/new` /
`session/load` as `params.mcpServers: McpServerHttp[]`. The
agent filters non-HTTP entries
(`acp/wire-utils.ts:filterHttpServers`), acquires a connection
per server through the refcounted `McpConnectionPool`, calls
`tools/list` once at connect time, and registers the
resulting tools per turn (filtered by per-session toggles).

## Client — `agent/mcp/client.ts:createMcpClient`

`createMcpClient(config: McpServerHttp)` is the only worker
entry point that touches the MCP transport.

- Uses `@modelcontextprotocol/sdk`'s `Client` +
  `StreamableHTTPClientTransport`.
- `MCP_CLIENT_NAME = 'web-acp'`, `MCP_CLIENT_VERSION = '0.1.0'`.
- Headers are forwarded verbatim from `config.headers ?? []`
  (the main thread injects `Authorization: Bearer <jwt>` into
  the `headers` array via `compose-mcp-servers.ts:compose` —
  see [`../web-acp-client/mcp.md`](../web-acp-client/mcp.md)).
- Returns `{ client: Client, close: () => Promise<void> }`.
  `client.close()` errors are logged but not thrown.

Error path: if `client.connect(transport)` throws, the
transport is closed (`transport.close()`) and the original
error rethrown — clean teardown without masking the cause.

## Connection pool — `agent/mcp/connection-pool.ts:McpConnectionPool`

Refcounted multi-session pool. Two sessions targeting the same
proxy URL with the same auth fingerprint share one underlying
`Client`.

### Pool entry — `:41`

```ts
interface PoolEntry {
    config: McpServerHttp;
    authFingerprint: string;
    client: Client;
    close: () => Promise<void>;
    tools: McpToolDescriptor[];
    refs: Set<string>;             // sessionIds holding this entry
}
```

Keying: `keyOf(config) = config.url`. Auth fingerprint:
`fingerprintOf(config)` returns the **`Authorization` header
value only** — a case-insensitive name match over
`config.headers`, the first match's value, or `''` when no
`Authorization` is present. Header changes other than
`Authorization` (e.g. `X-Custom-*`) do **not** evict the pool
entry; the connection is reused.

### `acquire(sessionId, config)` — `:88`

1. Lookup `entries.get(key)`.
2. If present + same fingerprint → register `refs.add(sessionId)`,
   return `{ client, tools }`.
3. If present but fingerprint changed (e.g. JWT rotated) →
   evict via `#evict(key, existing)` (deletes the pool entry,
   closes the client, emits `disconnected`) before reconnecting.
   `#evict` does not iterate `entry.refs`; sessions tracked
   under the old fingerprint are silently abandoned because the
   entry is gone.
4. Emit `connecting` lifecycle event.
5. Call `createMcpClient(config)`. On failure: emit `error`
   event and rethrow.
6. Call `client.listTools()`; map raw tool descriptors via
   `normaliseTool` to `McpToolDescriptor`. On failure: emit
   `error`, close the client, rethrow.
7. Emit `connected` event with the tool name list.
8. Insert the new `PoolEntry`; return `{ client, tools }`.

### `release(sessionId, config)`

Drops the session from `refs`. When `refs.size === 0` —
removes the entry, calls `close()`, emits `disconnected`.

### `releaseAll(sessionId)`

Iterates the pool and releases every entry the session holds.
Called by `runtime.dispose()` (per-session cleanup at
`session-runtime.ts:386`) and by `sessions-delete.ts:22`
(top-of-handler teardown). `loadSession` does **not** call
`releaseAll`; it calls `releaseMcpConnections(sessionId,
existing.mcpServers)` (the per-session, per-server release on
the runtime) so only the previously-held servers are released
before re-acquiring under the request's headers.

### `getClient(config)` / `getTools(config)`

Read-only accessors used by the engine layer. Returns the
cached client / tool list without side effects. The driver
calls these per turn (`session-runtime.ts:mcpToolsForSession`).

### Lifecycle events — `:55`

```ts
type McpPoolEventType = 'connecting' | 'connected' | 'error' | 'disconnected';

interface McpPoolEvent {
    type: McpPoolEventType;
    server: string;
    url: string;
    tools?: string[];     // populated on 'connected'
    error?: string;       // populated on 'error'
}
```

`subscribe(listener)` registers a listener; returns the
unregister fn. The engine layer subscribes once at
`AcpSessionRuntime` construction and forwards events to
affected sessions via `_meta.bodhi.mcp` riding an empty
`agent_message_chunk`. **Events are transient** — never
persisted — see `acp/engine/session-runtime.ts:broadcastMcpPoolEvent`
(`:201-209`) for the rationale.

Wire-envelope shape (the meta object the host receives):
```ts
_meta: {
  bodhi: {
    mcp: {
      state: McpPoolEventType;   // 'connecting' | 'connected'
                                 // | 'error' | 'disconnected'
      server: string;            // server slug
      url: string;
      tools?: string[];          // present on 'connected'
      error?: string;            // present on 'error'
    }
  }
}
```
The agent renames the pool's `type` field to `state` on the
wire so the host's reducer key naming stays `state` — that is
the only field rename across the boundary.

## Tool adapter — `agent/mcp/tool-adapter.ts:createMcpAgentTool`

Per-tool wrapper. Each MCP tool descriptor becomes a
`pi-agent-core` `AgentTool<TSchema, McpToolDetails>` named
`<serverName>__<toolName>` (separator constant
`MCP_TOOL_NAME_SEPARATOR = '__'`, helper `mcpToolName(serverName,
toolName)`).

`execute(toolCallId, params, signal?)`:

1. `client.callTool({ name, arguments }, undefined, signal ?
   { signal } : undefined)`.
2. Translate `response.content` via `extractContent` to the
   ACP-friendly content array.
3. Build `details: McpToolDetails`:
   `{ serverName, toolName, isError, content, structuredContent? }`.
4. If `isError === true`: throw `Error(summariseErrorContent(content)
   || '<fullName> reported an error')`. The driver's
   `tool_execution_end` path with `isError: true` rides this through
   to `tool_call_update.status = 'failed'`.
5. Otherwise filter `content` to text-only blocks (image / audio
   blocks drop from the LLM-visible array but are preserved on
   `details`), then return `{ content, details }`.

Schema handling: MCP descriptors carry raw JSON Schema; we
wrap with `Type.Unsafe<Record<string, unknown>>(tool.inputSchema)
as TSchema`. The `pi-agent-core` runtime never re-validates
against TypeBox — it forwards the schema to the LLM provider
and the model handles validation client-side.

## Toggle store — `storage/mcp-toggle-store.ts`

Per-session on/off flags. Defaults are **on** — an absent key
means "not explicitly toggled off". Two granularities:

- **Server-level**: `servers[serverSlug] === false` → skip the
  server entirely on `session/load` (the toggle filters
  upstream in the host's `compose-mcp-servers.ts:compose`).
- **Tool-level**: `tools[serverSlug][toolName] === false` →
  server stays connected, but that specific tool is filtered
  from `prompt-driver.ts:run`'s tool list per turn.

### `McpToggleStore` interface — `:31`

```ts
interface McpToggleStore {
    get(sessionId: string): Promise<McpToggleSnapshot>;
    setServer(sessionId, serverSlug, value: boolean): Promise<McpToggleSnapshot>;
    setTool(sessionId, serverSlug, toolName, value: boolean): Promise<McpToggleSnapshot>;
    clear(sessionId: string): Promise<void>;
}
```

Writes are additive patches, not whole-row replacements, so
the wire payload for `_bodhi/mcp/toggles/set` stays minimal.

### Helpers — `:42, :54`

- `isServerEnabled(toggles, serverSlug)` — `toggles.servers?.[slug] !== false`.
- `isToolEnabled(toggles, serverSlug, toolName)` — checks the
  server-level toggle first (off server implies all tools off),
  then `toggles.tools?.[serverSlug]?.[toolName] !== false`.

`EMPTY_MCP_TOGGLES` (`:26`) — frozen `{ servers: {}, tools: {} }`
shared default.

### Wire surface

- `_bodhi/mcp/toggles/set` mutation handler at
  `acp/engine/ext-methods/mcp-toggles-set.ts`. Validates the
  param shape:
  - `{ sessionId, serverSlug, value: boolean }` for a
    server-level override (calls `mcpToggles.setServer`).
  - `{ sessionId, serverSlug, toolName, value: boolean }` for
    a per-tool override (calls `mcpToggles.setTool`).
- The mutation response carries the wire snapshot via
  `acp/wire-utils.ts:toWireMcpToggles`.
- `bodhi/getSession` returns `mcpToggles: BodhiMcpToggleSnapshot`
  on the session-snapshot response.

## URL canonicalisation — `mcp/url-canonical.ts`

Shared by the agent (built-in `/mcp` command, `BuiltinHandlerCtx.requestedMcpUrls`)
and the host (`requested-mcps-store.ts` IDB key, `compose-mcp-servers.ts`
matching). The same canonicalisation rule running on both
sides is what makes the requested-vs-approved comparison
deterministic.

`canonicalizeMcpUrl(input)` (`:22`) — `new URL(trimmed).toString()`.
Returns `null` on parse failure (callers surface to the user).
Effects: lowercases host, drops default ports, percent-encodes
non-ASCII paths, preserves query + fragment.

`deriveSlugFromUrl(input)` — best-effort match against
`bodhiClient.mcps.list()` entries when the slug field doesn't
match by exact URL. Walks the host labels (skipping the generic
ones — `mcp`, `api`, `www` and also any `localhost` host —
see `url-canonical.ts:60`) and the path segments to find the
most distinctive label.

## Engine integration

The engine consumes the MCP surface in three places:

1. **Session lifecycle** —
   `acp/engine/session-runtime.ts:acquireMcpConnections`
   (`:140`) on `newSession` / `loadSession`. Errors are caught
   per-server (one bad MCP doesn't break the session); the
   pool's `error` lifecycle event still fires.
2. **Per-turn tool list** —
   `acp/engine/session-runtime.ts:mcpToolsForSession`
   (`:164`). Filters by per-tool toggles
   (server-level filtering happened upstream in the host).
3. **Lifecycle broadcast** —
   `acp/engine/session-runtime.ts:broadcastMcpPoolEvent`
   (`:193`). Fans transient pool events to every affected
   session as `_meta.bodhi.mcp` on an empty
   `agent_message_chunk`.

## Cross-references

- Engine layer that consumes the pool:
  [`acp.md`](./acp.md).
- Host-side catalog + compose +
  `requested-mcps-store`:
  [`../web-acp-client/mcp.md`](../web-acp-client/mcp.md).
- Sessions persistence (`McpTogglesRow` shape lives there):
  [`sessions.md`](./sessions.md).
- `/mcp` built-in handler:
  [`commands.md`](./commands.md).
