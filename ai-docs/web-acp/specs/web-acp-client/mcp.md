# MCP — main-thread catalog, composition, requested wishlist, UI

**Source of truth:** `packages/web-acp/src/mcp/`,
`packages/web-acp/src/acp/message-shape.ts:parseMcpStateParams`,
`packages/web-acp/src/acp/panels-reducer.ts:39` (`mcp-state` arm).

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
adapter, toggle store interface, `extNotification`
broadcaster) lives in
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

## Lifecycle wire path — `extNotification("_bodhi/mcp/state")`

The agent emits per-server lifecycle events via the
ACP-standard `extNotification` envelope rather than stuffing
state onto `agent_message_chunk` `_meta`. The host wires
this in `useAcpStreaming`'s consolidated subscription block
(`hooks/useAcpStreaming.ts:65–87`):

```ts
const unsubExt = runtime.client.onExtNotification((method, params) => {
  if (method === BODHI_MCP_STATE_NOTIFICATION_METHOD) {
    const meta = parseMcpStateParams(params);
    if (meta) dispatch({ type: 'mcp-state', meta });
    return;
  }
  // ...
});
```

`parseMcpStateParams` (`acp/message-shape.ts:6`) is a
defensive parser that returns `undefined` on malformed
payloads so a misbehaving agent build can't crash the
reducer:

- `params.server` must be a string.
- `params.state` must be one of `'disconnected' |
  'connecting' | 'connected' | 'error'`; unknown values
  are warned-and-dropped.
- `params.error` (string) and `params.tools` (string array)
  are optional.

The reducer reads it in `panelsReducer` (`acp/panels-reducer.ts:39`):

```ts
case 'mcp-state':
  return {
    ...state,
    mcpStates: { ...state.mcpStates, [action.meta.server]: action.meta },
  };
```

The `streamingReducer` is an explicit no-op for `'mcp-state'`
(documented at [`acp.md`](./acp.md) § panelsReducer) — the
slice belongs to panels because it survives `'reset'` and
prompt-turn boundaries.

`extractMcpMeta` and the early-return at the top of
`applySessionUpdate` (the legacy path that read
`_meta.bodhi.mcp` off empty `agent_message_chunk`s) are gone.

## Status panel — `mcp/McpPanel.tsx`

UI surface for the MCP catalog. Renders:

- Per-server status chips. `data-testid="mcp-server-<slug>"`,
  `data-test-state="connecting | connected | error |
  disconnected"` (`:87-89`). Source: `state.mcpStates[serverSlug]`
  from `panelsState.mcpStates` (populated by the
  `'mcp-state'` reducer arm above).
- Per-server checkbox toggle
  (`data-testid="mcp-session-server-<slug>"`,
  `data-test-state="on|off"`, `:99-110`). On flip →
  `setMcpToggle(slug, value)` from `useAcp().mcp.setToggle`.
  Server-level changes re-issue `loadSession` inside
  `useAcpMcp` so the worker pool reacquires under the new
  server set.
- Per-tool checkbox toggles within an expandable server
  panel (`data-testid="mcp-session-tool-<slug>-<tool>"`,
  `:131-145`). On flip → `setMcpToggle(slug, value,
  toolName)`. No `loadSession` re-issue — the agent applies
  tool-level filtering per turn.
- Tool-level checkboxes are auto-disabled when the parent
  server is off (`disabled={!canToggle || !serverOn}`,
  `:139`) and the row's `data-test-state` follows
  `toolOn && serverOn` so e2e can assert the implicit-off
  state.
- The panel renders **status + toggles only**. There is no
  in-panel add-server textarea and no per-row trash icon.
  Mutation of the requested-MCP list flows through the
  agent-side built-in slash commands `/mcp add <url>` and
  `/mcp remove <url>` (see [commands.md](./commands.md)) —
  the agent emits an
  `extNotification("_bodhi/builtin/action")` payload of
  kind `'mcp-add'` / `'mcp-remove'`, `useAcpStreaming`
  parses and forwards it to
  `acp/builtin-dispatch.ts:dispatchBuiltinAction` after the
  built-in turn resolves. The dispatcher writes to the IDB
  requested list and re-issues Bodhi auth via
  `triggerLogin`.

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
state machine). `BodhiMcpUpdateMeta` is retained as a typing
alias only — the runtime path is the
`extNotification("_bodhi/mcp/state")` flow described above.
The doc-comment on the type still points to the legacy
`_meta.bodhi.mcp` carrier, which is stale wording but not
runtime-incorrect (no code reads from the slot).

## Cross-references

- Worker-side runtime that consumes the composed payload +
  emits `extNotification("_bodhi/mcp/state")`:
  [`../web-acp-agent/mcp.md`](../web-acp-agent/mcp.md).
- Host-side hook that drives composition + dispatch:
  [`hooks.md`](./hooks.md) (`useAcpMcp`).
- Host-side built-in dispatcher (mcp-add / mcp-remove) and
  the `extNotification("_bodhi/builtin/action")` sibling
  channel:
  [`acp.md`](./acp.md) § builtin-dispatch and
  [`commands.md`](./commands.md).
- Storage adapter:
  [`storage-dexie.md`](./storage-dexie.md) (`mcp-toggle-store`).
