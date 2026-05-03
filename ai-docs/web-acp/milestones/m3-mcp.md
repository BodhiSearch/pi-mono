# M3 — MCP over Streamable HTTP

**Status:** shipped (MCP-only). Provider-native tools deferred —
see [deferred.md](deferred.md).

## ACP compliance header

**Posture.** Thick agent, **agent is the MCP client.** This is the
ACP-canonical posture: `agent-client-protocol/docs/protocol/session-setup.mdx`
and the `mcpServers` field of `session/new` / `session/load` both
place MCP configuration on the client → agent boundary, with the
agent responsible for actually connecting to MCP servers and
invoking their tools. The claude-agent-acp reference implementation
(`/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/claude-agent-acp/src/acp-agent.ts`)
follows the same pattern.

**Transport.** `agentCapabilities.mcpCapabilities = { http: true,
sse: false }`. Only the Streamable HTTP transport is advertised and
consumed; stdio is meaningless in a Web Worker and SSE is
deprecated per the MCP spec.

## What this milestone delivered

1. **App-wide MCP catalog** sourced live from BodhiApp's
   `bodhiClient.mcps.list()`. No IndexedDB cache — BodhiApp is the
   authoritative catalog; a live fetch per session boot avoids any
   invalidation story.
2. **Main-thread composition** of `McpServerHttp[]` with the Bodhi
   JWT embedded as an `Authorization: Bearer <jwt>` header on every
   server entry. The worker never sees the raw token — it receives
   `McpServerHttp.headers` and hands them straight to
   `StreamableHTTPClientTransport.requestInit.headers`.
3. **Worker-side MCP client** backed by `@modelcontextprotocol/sdk`
   (`Client` + `StreamableHTTPClientTransport`), wrapped in a
   refcounted `McpConnectionPool` keyed by URL + auth fingerprint.
   JWT rotation triggers a `session/load` re-issue; the fingerprint
   check evicts the stale client and reconnects.
4. **Tool namespacing** as `<serverName>__<toolName>` registered
   alongside `bash` through the existing InlineAgent tool path.
   MCP tools reuse `bindAbortSignal` so `session/cancel` aborts
   in-flight `tools/call` requests through the MCP SDK's
   `RequestOptions.signal`.
5. **Per-session toggles** (Option B): a Dexie v3 `mcpToggles`
   table, mutated via a new `_bodhi/mcp/toggles/set` extension
   method and surfaced through `bodhi/getSession` on reload. Server
   toggles omit the server from the composed `mcpServers` array;
   tool toggles filter the `tools/list` snapshot pre-registration.
6. **Connection lifecycle events** broadcast as `session/update`
   notifications with an empty `agent_message_chunk` payload and
   the real payload in `_meta.bodhi.mcp = { server, state, error?,
   tools? }`. These notifications are **transient** (sent straight
   via `conn.sessionUpdate`, never persisted) because the pool is
   rebuilt from scratch on every `session/load`; persisting would
   replay stale `connected` entries on top of a freshly
   `disconnected` live state.
7. **Status + toggle UI** under `packages/web-acp/src/mcp/McpPanel.tsx`
   with `data-testid` / `data-test-state` hooks for Playwright.

## Sub-milestones as shipped

M3 shipped in two implementation phases and an exit gate.

### M3.1 — MCP HTTP client + app-wide catalog (Phase A)

Source surface:

- `packages/web-acp/src/mcp/` — `types.ts`, `useMcpInstances.ts`
  (live fetch, `isReady` gate), `compose-mcp-servers.ts` (pure
  composition), `McpPanel.tsx` (status UI).
- `packages/web-acp/src/agent/mcp/` — `client.ts`
  (`StreamableHTTPClientTransport` wiring), `connection-pool.ts`
  (refcounted pool keyed by URL, fingerprint eviction),
  `tool-adapter.ts` (`<srv>__<tool>` namespacing, `Type.Unsafe`
  schema wrapping, `isError` → thrown `Error`).
- `packages/web-acp/src/acp/agent-adapter.ts` — `initialize` adds
  `agentCapabilities.mcpCapabilities = { http: true, sse: false }`;
  `newSession` / `loadSession` call `pool.acquire` for each MCP
  entry; `prompt` includes cached MCP tools alongside `bash`.
- `packages/web-acp/src/acp/client.ts` — widened `newSession` /
  `loadSession` accept `McpServerHttp[]` with `type: 'http'`
  injected.
- `packages/web-acp/src/hooks/useAcp.ts` — composes `McpServerHttp[]`
  before every ACP call and routes `_meta.bodhi.mcp` into
  `mcpStates`.
- `packages/web-acp/src/components/Header.tsx` — login button
  resolves the "everything MCP" URL from `window.__mcpEverythingUrl`
  or `VITE_MCP_EVERYTHING_URL` (the hard-coded `mcp.exa.ai` URL is
  gone).

### M3.2 — invocation + per-session toggles + reload (Phase B)

Source surface:

- `packages/web-acp/src/agent/session-store.ts` — Dexie v3
  `mcpToggles` store with transactional cleanup in `deleteSession`.
- `packages/web-acp/src/mcp/toggle-store.ts` — worker-side store
  with `get(sessionId)` / `set(sessionId, patch)` / `clear(sessionId)`.
- `packages/web-acp/src/acp/index.ts` — `_bodhi/mcp/toggles/set`
  constant, `McpToggleSnapshot` type, extended
  `BodhiGetSessionResponse` with `mcpToggles`.
- `packages/web-acp/src/acp/agent-adapter.ts` — `_bodhi/mcp/toggles/set`
  handler, `bodhi/getSession` returns the snapshot, per-tool
  filtering in the prompt path.
- `packages/web-acp/src/acp/client.ts` — `setMcpToggle` wrapper.
- `packages/web-acp/src/hooks/useAcp.ts` — re-issues `loadSession`
  on JWT rotation; `ensureSession` waits for `mcpInstances.isReady`
  to avoid a race against the first MCP catalog fetch.
- `packages/web-acp/src/mcp/McpPanel.tsx` — per-server and per-tool
  toggle UI with `data-testid` / `data-test-state` wired to
  `onSetToggle`.

### M3.3 — exit gate (Phase C)

Grep audits (all pass):

- `rg "request_permission|allow_always" packages/web-acp/src` → 0
  (permission bridge still deferred).
- `rg "_bodhi/mcp/" packages/web-acp/src` → only in `acp/index.ts`,
  `acp/agent-adapter.ts`, `acp/client.ts`, `hooks/useAcp.ts`,
  `agent/session-store.ts`, and their tests.
- `rg "@modelcontextprotocol/sdk" packages/web-acp/src` → only
  under `packages/web-acp/src/agent/mcp/`.
- `rg "mcp.exa.ai" packages/web-acp` → 0.

## Test inventory

### Vitest

- `src/mcp/compose-mcp-servers.test.ts` — enabled/disabled
  instances, per-server toggle filtering, URL normalisation, JWT
  embedding.
- `src/mcp/toggle-store.test.ts` — defaults, server-vs-tool
  precedence, clear-on-delete.
- `src/agent/mcp/connection-pool.test.ts` — share-per-URL,
  refcount release, fingerprint eviction, error emission,
  `releaseAll`.
- `src/agent/mcp/tool-adapter.test.ts` — name namespacing, success
  path, `isError` envelope translation, abort propagation.
- `src/acp/agent-adapter.test.ts` — `_bodhi/mcp/toggles/set`
  handler, `bodhi/getSession` snapshot shape, per-tool filtering
  in prompt.

### Playwright

- `packages/web-acp/e2e/mcp-connect.spec.ts` — after login the
  `mcp-server-everything` chip reaches `connected`; discovered
  tools (`echo`, `get-sum`, …) appear as `mcp-tool-everything-*`
  rows.
- `packages/web-acp/e2e/mcp-roundtrip.spec.ts` — echo round-trip:
  `everything__echo` tool-call bubble reaches `completed` with
  `rawInput.message === <TOKEN>`, `rawOutput` contains `<TOKEN>`,
  assistant text echoes `<TOKEN>` verbatim.
- `packages/web-acp/e2e/mcp-toggles.spec.ts` — per-server + per-tool
  toggles + reload persistence: toggle off → server chip reports
  `disconnected`, tool disappears from registered surface; reload
  → toggle state survives; toggle on → echo works again.

Supporting e2e harness:

- `e2e/tests/utils/everything-mcp-manager.ts` spawns
  `@modelcontextprotocol/server-everything` (via `node` +
  `createRequire`, not `npx`) on a deterministic port.
- `e2e/tests/pages/McpsPage.ts` provides `createMcpServer` /
  `createMcpInstance` helpers against BodhiApp.
- `e2e/tests/global-setup.ts` boots the everything server, seeds
  the Bodhi MCP instance, and persists `mcpEverythingUrl` +
  `mcpEverythingSlug` to `.test-state.json`.
- `e2e/tests/pages/ChatPage.ts` `login({ acceptMcps })` matches
  toggles by **full upstream URL** (the BodhiApp access-request
  review page keys `review-mcp-toggle-<url>`) and binds an
  instance via the `review-mcp-select-trigger-<url>` dropdown
  before approving.
- `e2e/helpers/install-mcp.ts` injects `window.__mcpEverythingUrl`
  so the main-thread login builder picks up the fixture URL.

## Decision log

- **Live catalog over IndexedDB cache.** BodhiApp is authoritative
  for the MCP server list; a live fetch per session boot avoids
  invalidation on auth change or MCP settings change. Documented
  as a deliberate deviation from the original prompt decision 5.
- **JWT embedded in `McpServerHttp.headers`, not a bespoke
  extension method.** Keeps the wire strictly ACP-canonical. The
  rotation cost is a `session/load` re-issue, which the pool
  already handles via fingerprint eviction.
- **Pool keyed by URL (not `(url, session)`).** Multiple sessions
  typically share the proxy URL; refcounting is simpler than
  parallel clients. The fingerprint check is the escape hatch
  when auth legitimately diverges.
- **`<serverName>__<toolName>` namespacing.** Collision-free and
  readable; slug-based server names never contain double
  underscores so the split is unambiguous for DOM selectors.
- **Lifecycle events via `_meta`, not a new `session/update`
  kind.** `_meta` is the spec-blessed extension path; avoids
  adding an ACP verb and keeps the notification wire-valid by
  riding an empty `agent_message_chunk`.
- **MCP lifecycle events are transient, not persisted.** The pool
  is rebuilt on every `session/load`; persisting `connected`
  events would replay stale state over the fresh live state after
  a toggle flip or restart. `#broadcastMcpPoolEvent` uses
  `conn.sessionUpdate` directly and skips `recordNotification`.
- **Option B per-session toggles.** New Dexie v3 `mcpToggles`
  store keeps the v2 `features` table untouched (no dynamic keys)
  and surfaces naturally through `bodhi/getSession`.

## Out of scope (this milestone)

- **Provider-native tool passthrough** (OpenAI `web_search`,
  Anthropic `web_search` / computer-use, etc.). Originally M3.3;
  deferred — see [deferred.md](deferred.md). MCP covers the
  generic tool-registration surface; provider-native hook-up can
  layer on later without reshaping this milestone's wire.
- **Stdio MCP.** Browsers cannot spawn processes.
- **MCP SSE.** Deprecated in the MCP spec; Streamable HTTP is the
  forward path. `agentCapabilities.mcpCapabilities.sse = false`.
- **OAuth-from-the-agent to the MCP upstream.** BodhiApp is the
  OAuth peer; the agent only ever sees the Bearer token it hands
  back. Non-BodhiApp upstream auth schemes are post-M3.
- **Dynamic MCP catalog mutation through ACP.** BodhiApp owns the
  catalog; only per-session toggles are mutable via the agent
  surface.
- **Destructive-command gating for MCP tools.** Same deferral as
  `bash`; when the permission bridge re-enters it will cover both
  uniformly.

## Why this ordering

**MCP before commands and extensions** because MCP tools are
themselves a form of extension — adding external capability to
the agent without changing agent code. Landing the tool registry
shape (built-in `bash` + MCP, all addressable by name, all routed
through the same `InlineAgent.setModel({ tools })` path) before
layering commands and extensions on top means the later surfaces
inherit a stable catalog rather than churning it.

**HTTP-only for v1** because stdio is meaningless in a browser
worker and SSE is deprecated; we document the limitation and punt
stdio to whenever a remote-agent deployment happens (at which
point a Node-hosted agent can legitimately spawn stdio servers).

## Cross-references

- Spec: [`../specs/web-acp-agent/mcp.md`](../specs/web-acp-agent/mcp.md) —
  current living reference for `src/mcp/` + `src/agent/mcp/`.
- Parent index: [`./index.md`](./index.md).
- Deferred items: [`./deferred.md`](./deferred.md) — provider-
  native tools, permission bridge, allow-always persistence.
