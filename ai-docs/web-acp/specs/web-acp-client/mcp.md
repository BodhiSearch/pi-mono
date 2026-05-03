# MCP — main-thread catalog, composition, requested wishlist, UI

**Source of truth:** `packages/web-acp/src/mcp/`.

## Purpose

Browser-host MCP surface. The host:

- **Fetches** the user's MCP instance catalog from BodhiApp
  (`bodhiClient.mcps.list()`) — via `useMcpInstances`.
- **Composes** the per-session `McpServerHttp[]` payload from
  the catalog + JWT + per-session toggle filter — via
  `composeMcpServers`.
- **Persists** a "requested" wishlist of MCP URLs the user
  wants Bodhi to grant access for — `requested-mcps-store.ts`.
- **Renders** status chips + per-server / per-tool toggle UI
  — `McpPanel.tsx`.

Worker-side MCP runtime (client, connection pool, tool
adapter, toggle store interface) lives in
[`../web-acp-agent/mcp.md`](../web-acp-agent/mcp.md).

## Catalog watcher — `mcp/useMcpInstances.ts`

`useMcpInstances()` returns `{ instances, isLoading, isReady,
error, refresh }`.

- **Live fetch only.** Never persists. The authoritative
  source is `bodhiClient.mcps.list()`; every auth flip
  (login, logout, token rotation) triggers a re-fetch.
  Decision rationale documented in source.
- **`isReady` semantics.** `fetchedForToken === currentToken` —
  i.e. the most recent successful fetch was for the *current*
  auth token. Consumers waiting on a deterministic snapshot
  (e.g. `useAcpSession` before `session/new`) check `isReady`
  rather than `!isLoading` because the latter has a
  transient false value between auth landing and the refresh
  effect firing.
- **Token-rotation invariant.** Auth rotation immediately
  flips `currentToken`; `isReady` evaluates to `false` until
  the next `refresh()` resolves and writes the new token
  back into `fetchedForToken`. No effect-driven `resetState`
  dance — keeps the hook lint-clean against
  `react-hooks/set-state-in-effect`.

`UNAUTHENTICATED_TOKEN = '__unauth__'` (`:55`) is a sentinel —
when auth drops out the fetch path skips the network and
sets `fetchedForToken` so `isReady` flips to `true` for the
unauthenticated state too.

`toView(rawRow)` (`:43`) projects from the raw
`@bodhiapp/ts-client` row into `McpInstanceView` (defined at
`mcp/types.ts:9`). The catalog's auth-config plumbing is
intentionally dropped — the host only needs `id`, `slug`,
`name`, `description`, `enabled`, `path`, `authType`.

## Composition — `mcp/compose-mcp-servers.ts`

`composeMcpServers(instances, jwt, bodhiBaseUrl, toggles?)`
(`:24`) builds the `mcpServers: McpServerHttp[]` payload
passed on `session/new` / `session/load`.

Per-instance:

- Skip if `!instance.enabled` (Bodhi-side enable flag).
- Skip if `toggles?.servers[instance.slug] === false`
  (user-side server-level toggle).
- Build `{ name: slug, url: '${baseUrl}${path}', headers:
  [{ name: 'Authorization', value: 'Bearer <jwt>' }] }`.

Why embed the JWT here:

- The worker-side MCP client (`@modelcontextprotocol/sdk`'s
  `StreamableHTTPClientTransport`) consumes a header bag at
  construct time. By putting the JWT into `headers`, the
  worker can hand a ready-to-use transport to the SDK
  without ever touching the token itself.
- The pool keys by URL + auth fingerprint, so a JWT rotation
  triggers `releaseAll` + reconnect for the same URL —
  documented at [`../web-acp-agent/mcp.md`](../web-acp-agent/mcp.md)
  § connection pool.
- Token rotation flow: main thread re-issues `client.loadSession(...)`
  with a freshly composed payload after `useAcpAuth` re-runs.

`McpToggleSnapshot` (`:10`) — local mirror of the agent's
shape; same `{ servers, tools }` keying. Per-tool filtering
isn't applied here because the catalog isn't known on the
main thread; it happens worker-side after `tools/list`. See
[`../web-acp-agent/mcp.md`](../web-acp-agent/mcp.md).

## Requested wishlist — `mcp/requested-mcps-store.ts`

IDB persistence at the key `'web-acp:mcp-requested'`. Drives:

- The `LoginOptionsBuilder` chain in `components/Header.tsx`
  (login click sends `addMcpServer(url)` for each entry).
- The `_meta.bodhi.requestedMcpUrls` payload on
  `session/new` / `session/load` so the worker's `/mcp`
  built-in can render Pending entries and `/mcp add` /
  `/mcp remove` give correct idempotency feedback.

Source of truth lives on the main thread; the worker treats
the list as read-only.

API:

- `loadRequestedMcps(): Promise<string[]>` (`:21`) —
  `idb-keyval` read; filters non-strings; deduplicates
  preserving order. Empty array on read error.
- `saveRequestedMcps(urls)` (`:31`) — full replace; empty
  array → `del(key)`. Errors logged but swallowed.
- `clearRequestedMcps()` (`:48`) — `del(key)`.
- `addRequestedMcp(url)` — canonicalises via
  `canonicalizeMcpUrl`, returns `{ list, added, canonical }`.
  `canonical: null` ⇒ parse failed; `added: false` ⇒ URL
  already present.
- `removeRequestedMcp(url)` — symmetric; returns `{ list,
  removed, canonical }`.

`addRequestedMcp` / `removeRequestedMcp` are consumed by
`acp/builtin-dispatch.ts:dispatchBuiltinAction` to handle the
`mcp-add` / `mcp-remove` built-in actions. After mutation the
dispatcher calls `triggerLogin(list)` to re-issue Bodhi's
OAuth flow with the updated list.

## URL canonicalisation — `mcp/url-canonical.ts`

Mirrors the agent package's helper of the same name (re-exported
via `@bodhiapp/web-acp-agent`). The host imports its own copy
to avoid the agent-package dep at the module level — both
copies are kept identical by hand. Documented at
[`../web-acp-agent/mcp.md`](../web-acp-agent/mcp.md) § URL
canonicalisation.

## Status panel — `mcp/McpPanel.tsx`

UI surface for the MCP catalog. Renders:

- Per-server status chips. `data-testid="mcp-server-<slug>"`,
  `data-test-state="connecting | connected | error |
  disconnected"`. Source: `state.mcpStates[serverSlug]`
  (populated by the streaming reducer from
  `_meta.bodhi.mcp` notifications).
- Per-server toggle (`Switch` component). On flip → `setMcpToggle(slug, value)`
  from `useAcp()`. Server-level changes re-issue `loadSession`
  inside `useAcpMcp`.
- Per-tool toggles within an expandable server panel. On
  flip → `setMcpToggle(slug, value, toolName)` (no
  `loadSession` re-issue — the agent applies tool-level
  filtering per turn).
- Add server affordance: textarea + button. On submit calls
  the `mcp-add` built-in action via `dispatchAction`.
- Remove affordance: per-row trash icon → `mcp-remove`
  action.

The panel is part of the host's reference UI (the components
folder); when the host-runtime is extracted (M8) the panel
will likely move into the reference-app boundary, with the
data plumbing staying in `mcp/`.

## Connection state types — `mcp/types.ts`

```ts
type McpConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

interface McpConnectionMeta {
    server: string;
    state: McpConnectionState;
    error?: string;
    tools?: string[];          // populated on 'connected'
}

interface BodhiMcpUpdateMeta {
    bodhi?: { mcp?: McpConnectionMeta };
}
```

Mirrored from the agent's `McpPoolEvent` shape (one field
rename: `type` → `state` because the host renders it as a
state machine). The streaming reducer reads the `bodhi.mcp`
slot via `acp/message-shape.ts:extractMcpMeta` and stores it
keyed by `server` in `state.mcpStates`.

## Cross-references

- Worker-side runtime that consumes the composed payload:
  [`../web-acp-agent/mcp.md`](../web-acp-agent/mcp.md).
- Host-side hook that drives composition + dispatch:
  [`hooks.md`](./hooks.md) (`useAcpMcp`).
- Host-side built-in dispatcher (mcp-add / mcp-remove):
  [`acp.md`](./acp.md) § builtin-dispatch.
- Storage adapter:
  [`storage-dexie.md`](./storage-dexie.md) (`mcp-toggle-store`).
