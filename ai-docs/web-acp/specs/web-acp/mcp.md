# mcp

**Source of truth (agent — `packages/web-acp-agent/src/`):**
`agent/mcp/` (`client.ts`, `connection-pool.ts`, `tool-adapter.ts`),
`mcp/url-canonical.ts` (slug derivation),
`storage/mcp-toggle-store.ts` (interface + `EMPTY_MCP_TOGGLES`),
`acp/engine/session-runtime.ts` (worker-side MCP lifecycle: pool
subscription, acquire / release, broadcast, tool listing),
`acp/engine/ext-methods/mcp-toggles-set.ts` (`_bodhi/mcp/toggles/set`
handler),
`acp/agent-adapter.ts` (wire shim — MCP server list extraction in
`newSession` / `loadSession`).

**Source of truth (browser host — `packages/web-acp/src/`):**
`mcp/` (main-thread `useMcpInstances`, `compose-mcp-servers`,
`McpPanel.tsx`, the host's `toggle-store.ts` adapter that delegates
to the agent's interface),
`runtime/storage-dexie/mcp-toggle-store.ts` (Dexie v3 implementation
of the agent's `McpToggleStore`),
`acp/client.ts` (main-thread wiring),
`hooks/useAcp.ts` (composition).

**Source of truth (CLI host — `packages/cli-acp-client/src/`):**
`services/stores.ts` carries an in-memory `McpToggleStore`
implementation; the agent's MCP runtime is otherwise host-agnostic.

**Parent:** [`./index.md`](./index.md)

> **Note (post engine-split refactor).** Where this file
> references `AcpAgentAdapter.#acquireMcpConnections`,
> `#mcpToolsForSession`, `#broadcastMcpPoolEvent`,
> `#mcpPool`, or `#mcpSubscription`, those live on
> `AcpSessionRuntime` (`acp/engine/session-runtime.ts`) after the
> refactor. Wire shape is unchanged. Mapping: see
> [`./acp.md`](./acp.md) § "Engine layer".

## Purpose

M3 adds MCP (Model Context Protocol) servers to the agent's tool
surface while keeping `web-acp` strictly ACP-compliant. The worker
hosts the MCP client, the main thread composes per-session server
lists from BodhiApp's live catalog, and the JWT travels with each
server config as an embedded `Authorization: Bearer <jwt>` header.
The worker runs `@modelcontextprotocol/sdk` directly over Streamable
HTTP — no Stdio, no SSE, no bespoke extension method to exchange
credentials.

## Ownership boundaries

| Concern | Home | Notes |
| --- | --- | --- |
| MCP catalog fetch | Main thread — `src/mcp/useMcpInstances.ts` | Wraps `bodhiClient.mcps.list()`. Live fetch, no IndexedDB cache. |
| Compose `McpServerHttp[]` | Main thread — `src/mcp/compose-mcp-servers.ts` | Embeds JWT; normalises URL + path; honours optional per-server toggles (Phase B). |
| MCP SDK (`Client`, `StreamableHTTPClientTransport`) | Worker — `src/agent/mcp/client.ts` | Only file in the repo that imports `@modelcontextprotocol/sdk`. |
| Connection pool | Worker — `src/agent/mcp/connection-pool.ts` | Refcounted by `sessionId`, keyed by URL, evicts on auth-fingerprint change. |
| Tool adapter | Worker — `src/agent/mcp/tool-adapter.ts` | Turns an MCP tool descriptor into a pi-agent-core `AgentTool`. |
| Status UI | Main thread — `src/mcp/McpPanel.tsx` | Mirrors `_meta.bodhi.mcp` events into per-server chips. |
| Login `addMcpServer(...)` | Main thread — `src/components/Header.tsx` | Resolves the "everything MCP" URL from `VITE_MCP_EVERYTHING_URL` or the `window.__mcpEverythingUrl` e2e hook. |

The SDK boundary is enforced by a grep audit in the Phase C gate:
`rg "@modelcontextprotocol/sdk" packages/web-acp/src` must only
match files under `packages/web-acp/src/agent/mcp/`.

## Architecture

```
Main thread                         Worker
───────────                         ──────
useMcpInstances ──┐
                  │
composeMcpServers │                 AcpAgentAdapter
   │ McpServerHttp[]                   │
   ▼                                   │
AcpClient.newSession  ───── ACP ────►  newSession
AcpClient.loadSession ───── ACP ────►  loadSession
                                       │  (per server)
                                       ▼
                                    McpConnectionPool.acquire(sessionId, cfg)
                                       │
                                       ▼
                                    createMcpClient(cfg)
                                       │  StreamableHTTPClientTransport
                                       ▼
                                 BodhiApp proxy → upstream MCP server
                                       │  tools/list
                                       ▼
                                    McpToolDescriptor[]
                                       │ (on prompt)
                                       ▼
                                    createMcpAgentTool(client, server, tool)
                                       │
                                       ▼
                                    InlineAgent.setModel({ tools })
```

## Main-thread modules (`src/mcp/`)

### `types.ts`

- `McpInstanceView` — main-thread projection of a BodhiApp `Mcp`
  record. Narrow on purpose: only the fields
  `composeMcpServers` and `McpPanel` consume. Full auth-config
  plumbing stays on the BodhiApp side.
- `McpConnectionState` — `'disconnected' | 'connecting' |
  'connected' | 'error'`.
- `McpConnectionMeta` — `{ server, state, error?, tools? }` — the
  payload shape carried over `_meta.bodhi.mcp` in session/update
  notifications.
- `BodhiMcpUpdateMeta` — `{ bodhi?: { mcp?: McpConnectionMeta } }` —
  the wrapping `_meta` shape the worker stamps on notifications.

### `useMcpInstances.ts`

A React hook that wraps `bodhiClient.mcps.list()` and projects the
payload into `McpInstanceView[]`. Re-runs when the `bodhiClient`
changes or `auth.accessToken` rotates. No persistence — the
authoritative source is BodhiApp, and the live fetch avoids the
offline-cache drift we would otherwise need to invalidate on every
auth or MCP settings change.

### `compose-mcp-servers.ts`

Pure function:

```ts
composeMcpServers(
  instances: McpInstanceView[],
  jwt: string,
  bodhiBaseUrl: string,
  toggles?: McpToggleSnapshot
): McpServerHttp[]
```

Rules:

1. Drop disabled instances (`instance.enabled === false`).
2. Drop server-toggled-off instances when `toggles.servers[slug] === false`.
3. Resolve URL as `${bodhiBaseUrl trim /}${path with leading /}`.
4. Attach a single `Authorization: Bearer <jwt>` header to every
   server entry. No other headers today.

This is the only place in `web-acp` that knows how to embed the
JWT for MCP; all ACP wire composition flows through it. The worker
never sees the raw token — it receives `McpServerHttp.headers` and
hands them straight to `StreamableHTTPClientTransport.requestInit.headers`.

### `McpPanel.tsx`

Renders one row per enabled MCP instance. The row's
`data-testid="mcp-server-<slug>"` and `data-test-state` reflect the
connection meta. Discovered tools appear beneath the row as
`data-testid="mcp-tool-<slug>-<tool>"` with the same state attribute.

## Worker modules (`src/agent/mcp/`)

### `client.ts`

`createMcpClient(config: McpServerHttp)` builds a
`StreamableHTTPClientTransport` with `requestInit.headers` derived
from `config.headers`, then constructs a `Client({name, version}, { capabilities: {} })`
and awaits `client.connect(transport)`. On connect failure the
transport is closed before rethrowing so we never leak an in-flight
connection. Returns `{ client, close }`; the pool is the only
consumer.

### `connection-pool.ts`

`McpConnectionPool` is keyed by `config.url`. Each entry records:

- the `Client` + close handle,
- the `authFingerprint` (the `Authorization` header value),
- the `tools/list` snapshot captured at connect time,
- a `Set<sessionId>` refcount.

Operations:

- `acquire(sessionId, cfg)` — reuse an existing entry whose
  fingerprint matches; otherwise evict and reconnect. On a fresh
  connect the pool invokes `tools/list` once and caches the
  descriptors. Emits `connecting`, `connected`, or `error` pool
  events to subscribers (the adapter).
- `release(sessionId, cfg)` / `releaseAll(sessionId)` — decrement
  refcounts and close the underlying client at zero.
- `getTools(cfg)` / `getClient(cfg)` — synchronous accessors the
  adapter uses at prompt time.

Eviction on auth-fingerprint change is how we handle JWT rotation:
on rotation the main thread re-issues `session/load` for the
active session, the adapter releases the old config and acquires
the new one, and the pool swaps the underlying client.

### `tool-adapter.ts`

`createMcpAgentTool({ client, serverName, tool })` wraps a
`McpToolDescriptor` into an `AgentTool<TSchema, McpToolDetails>`.

- `tool.inputSchema` (raw JSON Schema from `tools/list`) is wrapped
  via `Type.Unsafe<Record<string, unknown>>(...)` so pi-agent-core
  treats it as an opaque TSchema. The schema reaches the model
  verbatim.
- `tool.name` becomes `<serverName>__<toolName>`
  (`MCP_TOOL_NAME_SEPARATOR === '__'`). No collisions with `bash` —
  the server names come from BodhiApp slugs which never contain
  double-underscores, and the wire contract is stable for the UI
  DOM selectors.
- `execute(toolCallId, params, signal)` forwards to
  `client.callTool({ name, arguments }, undefined, { signal })`.
- The signal originates from the per-turn controller the adapter
  binds via `bindAbortSignal`, so `session/cancel` aborts in-flight
  `tools/call` requests through the MCP SDK's `RequestOptions.signal`.
- Response shape:
  - success → `{ content: [...text blocks], details: { serverName, toolName, isError: false, content, structuredContent? } }`;
  - `isError: true` → thrown `Error` carrying the first text block
    as `message`; the adapter's existing `tool_execution_end`
    handler surfaces it as a failed `tool_call_update` without
    special-casing.

## Adapter wiring (`src/acp/agent-adapter.ts`)

- `initialize` advertises `agentCapabilities.mcpCapabilities =
  { http: true, sse: false }` so clients know the agent consumes
  Streamable HTTP MCP.
- `newSession(params)` filters `params.mcpServers` to the `http`
  variant, stores the slim config on the session state, and calls
  `pool.acquire(sessionId, cfg)` for each. Acquire failures are
  logged and surfaced as pool `error` events but do **not** fail
  `session/new` — a missing MCP server doesn't block the session.
- `loadSession(params)` releases whatever configs the session was
  previously holding (if any), stores the new config list, and
  acquires again. The pool's eviction-on-fingerprint-change path is
  what makes token rotation work.
- `prompt(params)` pulls the cached tool list per server via
  `pool.getTools(cfg)`, wraps each through `createMcpAgentTool`,
  passes them through the same `bindAbortSignal` shim `bash` uses,
  and registers them alongside `bash` on the inline agent.
- A pool subscription translates every lifecycle event into a
  `session/update` notification on behalf of every session that
  holds a matching config. The notification carries an empty
  `agent_message_chunk` payload (required so the update is wire-valid)
  and the real payload as `_meta.bodhi.mcp`.

## Client wrapping (`src/acp/client.ts`)

`AcpClient.newSession(mcpServers?)` and
`AcpClient.loadSession(sessionId, mcpServers?)` default to `[]` and
accept composed `McpServerHttp[]`. The wrapper injects
`{ type: 'http' as const }` on each entry so the ACP wire accepts the
shape. Tests that don't care about MCP still call
`newSession()` with zero args.

## Hook wiring (`src/hooks/useAcp.ts`)

- Owns a `useMcpInstances()` subscription and stores the projected
  list in a ref.
- `composeCurrentMcpServers()` reads the ref + current JWT + base
  URL and invokes `composeMcpServers`. Returns `[]` when auth hasn't
  landed yet; all callers are resilient to that.
- `ensureSession()` composes before `newSession`; `loadSession`
  composes before the ACP call. Both calls always pass a fresh
  server list, so the worker pool always sees the most recent JWT.
- A new session-update branch detects `_meta.bodhi.mcp` and funnels
  the meta into `mcpStates` state keyed by `server`. The MCP
  meta is processed even while `isReplayingRef.current` is true so
  connection chips stay accurate during session replay.
- The hook exposes `mcp: { instances, states, isLoading, error,
  refresh }` for panels and settings.

## Login flow (`src/components/Header.tsx`)

The login button reads from a persisted main-thread IDB list and
issues one `LoginOptionsBuilder.addMcpServer(...)` call per entry:

```ts
const requestedUrls = await loadRequestedMcps();
const builder = new LoginOptionsBuilder().setFlowType('redirect').setRole('scope_user_user');
for (const url of requestedUrls) builder.addMcpServer(url);
await login(builder.build());
```

The list is mutated by the `/mcp add` and `/mcp remove` built-ins
(see [`./commands.md` § /mcp](./commands.md#mcp--manage-requested-mcp-servers))
which write to IDB and re-issue `auth.login` with the updated set.
A brand-new user has an empty list → first login requests zero
MCP scopes; the user expands by typing `/mcp add <url>`.

The previous `window.__mcpEverythingUrl` / `VITE_MCP_EVERYTHING_URL`
seam is gone. E2E tests now seed the IDB list directly via
`installRequestedMcps(page, [url, …])` (Playwright `addInitScript`
on `window.__mcpRequestedSeed`); a DEV-only boot hook in `useAcp`
writes the seed to IDB before any login click reads it.

### Requested-MCPs IDB store

Source of truth on the main thread:
`packages/web-acp/src/mcp/requested-mcps-store.ts`. Single
`idb-keyval` key, value is `string[]` of canonical URLs.

| Concern | Detail |
| --- | --- |
| IDB key | `'web-acp:mcp-requested'` |
| Value | `string[]` — canonicalised URLs, deduped, order preserved |
| Mutators | `addRequestedMcp(url)` / `removeRequestedMcp(url)` — idempotent, return `{ list, added \| removed, canonical }` |
| Failure mode | Read errors → empty list; write errors → swallowed with `console.warn` (mirrors `vault/fsa-handle-store.ts`) |

**URL canonicalisation** (`mcp/url-canonical.ts` `canonicalizeMcpUrl`):
trim, parse via `new URL()`, return `.toString()` — lowercases the
host, drops default ports (`:443` for https, `:80` for http),
preserves query + fragment. Returns `null` on parse failure.
Applied at IDB-write time (so duplicates collapse) and at
match-against-approved-list time (consistency invariant).

**Slug-derivation heuristic** (`deriveSlugFromUrl`): hostname's
first non-generic label (skip `mcp.` / `api.` / `www.`), fall back
to the last meaningful path segment. Used by `/mcp` (list) to
match approved instances back to original URLs. Best-effort —
unmatched approved instances render with the Bodhi proxy URL.

### `_meta.bodhi` session bundle on `session/new` + `session/load`

Wire shape — `packages/web-acp/src/acp/index.ts`:

```ts
export interface BodhiSessionMeta {
  requestedMcpUrls?: string[];             // canonicalised, from IDB
  mcpInstances?: BodhiMcpInstanceDescriptor[]; // {slug, name, path}
}
```

The main-thread `useAcp.ts` `composeSessionMeta` helper bundles
the IDB list with the projected `mcpInstancesRef` and passes it on
every `session/new` and `session/load` (including the
token-rotation reissue and the per-session toggle reissue). The
worker stashes both arrays per-session and reads them in
`#tryHandleBuiltin` to populate `BuiltinHandlerCtx.requestedMcpUrls`
and `BuiltinHandlerCtx.mcpInstances`. Returning `undefined` when
both inputs are empty keeps the wire frame compact for vanilla
sessions.

`extractSessionMeta` in `agent-adapter.ts` defensively coerces
each field so older clients (and test harnesses) that omit the
meta keep working — the worker treats absent inputs as empty.

## Session-update `_meta` contract

When the worker emits an MCP lifecycle event it sends:

```jsonc
{
  "sessionId": "<bodhi-session>",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "content": { "type": "text", "text": "" }
  },
  "_meta": {
    "bodhi": {
      "mcp": {
        "server": "<slug>",
        "state": "connecting" | "connected" | "error" | "disconnected",
        "error": "<optional message>",
        "tools": ["tool-a", "tool-b"]
      }
    }
  }
}
```

Consumers:

- The main-thread `useAcp` hook filters on `_meta.bodhi.mcp` and
  routes the payload into `mcpStates` without touching the
  message stream.
- MCP lifecycle events are **transient** — they describe the live
  state of the worker's pool, which is rebuilt from scratch on
  every `session/load` (the adapter releases every config the
  session was holding and re-acquires against the freshly
  composed list). The adapter therefore sends these notifications
  directly via `conn.sessionUpdate` and deliberately skips
  `recordNotification`: otherwise a subsequent `session/load`
  would replay stale `connecting` / `connected` entries on top of
  a fresh live state (e.g. after a per-server toggle flip the
  pool emits `disconnected`, and replay would re-hydrate
  `connected`).

This is a deliberate extensibility pattern: ACP doesn't ship a
transport-level verb for connection events, but `_meta` is the
spec-blessed escape hatch (`docs/protocol/extensibility`), and
we ride it on the minimal well-formed notification shape.

## Token rotation

On JWT rotation the main thread already re-authenticates via the
existing `auth.accessToken` effect. In Phase B the hook also
re-issues `loadSession(currentSessionId)` so the worker rebuilds
its connection pool with the fresh `Bearer` header. The pool's
`fingerprintOf` helper detects the mismatch and evicts the old
client before reconnecting. No explicit "credentials" extension
method is ever emitted — the JWT always travels as an
`McpServerHttp.headers` entry.

## Testing

### Vitest (Phase A)

- `src/mcp/compose-mcp-servers.test.ts` — enabled/disabled
  instances, server toggles, URL normalisation.
- `src/agent/mcp/connection-pool.test.ts` — share-per-URL,
  refcount release, fingerprint eviction, error emission,
  `releaseAll`.
- `src/agent/mcp/tool-adapter.test.ts` — name namespacing,
  success path, `isError` envelope translation, abort
  propagation.

### Vitest (Phase B)

- `compose-mcp-servers` per-session toggle filtering.
- `toggle-store` defaults / precedence / clear-on-delete.
- `agent-adapter` `_bodhi/mcp/toggles/set` + `bodhi/getSession`
  returning the snapshot.

### E2E

- Phase A: `mcp-connect.spec.ts` — after login, assert the panel
  chip reaches `data-test-state="connected"` for `everything` and
  the registered-tool surface advertises `echo` + `get-sum`.
- Phase B: `mcp-roundtrip.spec.ts` — echo round-trip; assert the
  `everything__echo` tool call bubble reaches `completed` with the
  expected `rawInput`/`rawOutput`.
- Phase B: `mcp-toggles.spec.ts` — per-server + per-tool toggles,
  persistence across reload.

## Decision log

- **Live catalog over IndexedDB cache** — BodhiApp is authoritative;
  any cache would need invalidation on auth change, MCP settings
  change, or server failure. A live fetch per session boot is
  cheaper than getting invalidation right.
- **JWT in `McpServerHttp.headers`, not a new extension method** —
  keeps the wire strictly ACP-canonical. The rotation cost is a
  `session/load` re-issue, which the pool already handles.
- **Single pool keyed by URL, not `(url, session)`** — multiple
  sessions share the proxy URL most of the time, and the refcount
  model is simpler than parallel clients. The fingerprint check
  is the escape hatch when they legitimately diverge.
- **`<serverName>__<toolName>` namespacing** — collision-free and
  readable; the slug-based server name guarantees no double
  underscores appear in practice.
- **Connection lifecycle over `_meta`, not a new `session/update`
  kind** — adding a verb would need an ACP spec change or a full
  custom extension notification; the `_meta` slot is the
  explicitly-sanctioned extension path.

## Non-goals

- Stdio and SSE MCP transports. `agentCapabilities.mcpCapabilities.sse`
  is `false`; stdio is meaningless in a Web Worker.
- OAuth-from-the-agent to the MCP upstream. BodhiApp is the OAuth
  peer; the agent only sees the resulting Bearer token.
- Dynamic MCP catalog mutation through ACP. The catalog is owned
  by BodhiApp; toggles in Phase B mutate only per-session state.
