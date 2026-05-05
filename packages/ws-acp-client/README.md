# `@bodhiapp/ws-acp-client`

WebSocket-fronted host for [`@bodhiapp/web-acp-agent`](../web-acp-agent/).
Boots a Node process that listens on a TCP port, accepts framed
JSON-RPC over WebSocket, and runs one transport-agnostic ACP agent
adapter per accepted connection. The agent's working directory is the
host process's `$cwd`, surfaced to the agent as a ZenFS
[`PassthroughFS`](../../node_modules/@zenfs/core/dist/backends/passthrough.js)
volume mounted at `/mnt/cwd`.

This package is the second host runtime for `web-acp-agent`. The first
is `packages/web-acp/` (browser, MessageChannel transport). They share
the agent core verbatim — the WebSocket framing here is the same
NDJSON-of-JSON-RPC bytes exchanged inside the browser.

## When to use

- you want a remote agent reachable from any browser host that speaks
  the bodhi-js auth flow (acp-ui, web-acp, custom embedders) without
  shipping the LLM / FS plumbing in the browser bundle,
- you want the agent's filesystem ops to land on a real disk (`$cwd`)
  rather than the browser's IndexedDB / OPFS,
- you want a single-tenant / single-machine deployment — the same
  sqlite database under `<cwd>/.ws-acp-client/state.db` is shared by
  every WebSocket connection (see "Storage" below).

## Run

```bash
# from the package root
npx tsx src/cli.ts \
  --port 8765 \
  --bind 127.0.0.1 \
  --cwd /path/to/working/dir \
  --volume notes=/Users/me/notes \
  --volume code=/Users/me/code
```

Flags:

- `--port <n>` — listen port. `0` picks an ephemeral port; the chosen
  port is printed on stdout in the line `ready: ws://host:port`.
- `--bind <host>` — interface to bind. Defaults to `127.0.0.1`.
- `--cwd <path>` — agent's working directory + sqlite location.
  Defaults to `process.cwd()`. Mounted as `/mnt/cwd` to the agent.
- `--volume <name>=<path>` — repeatable. Mounts an additional host
  directory as a ZenFS `PassthroughFS` volume at `/mnt/<name>`. The
  `<name>` must match `[A-Za-z0-9_-]{1,63}` and cannot collide with
  the reserved `cwd` mount or with another `--volume` name in the
  same invocation. The agent surfaces the mounted set via the
  `_bodhi/volumes/list` ext-method, which acp-ui renders in the
  Volumes panel. Useful for letting an agent reach extra workspaces
  (notes, project sources, scratch dirs) without changing `$cwd`,
  and for seeding `.pi/{commands,prompts}/*.md` so vault `/wiki:*`
  slash commands are discoverable from the chat.

The process traps `SIGTERM` / `SIGINT` and shuts the WebSocket server
down cleanly, including closing the sqlite handle.

## Storage

The host opens a single sqlite database at
`<cwd>/.ws-acp-client/state.db` using `better-sqlite3` and `drizzle-orm`.
Migrations are applied inline on boot — no separate `drizzle-kit` run is
required. The schema mirrors `packages/web-acp/src/runtime/storage-dexie/db.ts`
verbatim:

| table         | columns                                                                          |
| ------------- | -------------------------------------------------------------------------------- |
| `sessions`    | `id`, `created_at`, `updated_at`, `title`, `turn_count`, `last_model_id`         |
| `entries`     | composite-PK `(session_id, seq)`, `at`, `kind`, `payload` (JSON-encoded text)    |
| `preferences` | composite-PK `(session_id, key)`, `value` (JSON-encoded text), `updated_at`      |

All three stores live in one SQLite file. The `preferences` table is
the unified per-session keyed store backing both feature toggles
(`feature:bashEnabled`, `feature:forceToolCall`) and MCP toggles
(`mcp:toggles`).

**Single-tenant carve-out**: two browser tabs talking to the same
`ws-acp-client` process see the same session list, the same
per-session feature toggles, and the same MCP toggle bitmap. The
`_bodhi/sessions/delete` ext-method is destructive across browsers
sharing one host — deleting a session in tab A also removes it from
tab B's sidebar on next refresh. This is intentional for single-user
laptop deployments. Multi-tenant hardening would require
per-connection authentication-derived namespacing on `session_id`
across the `sessions` / `entries` / `preferences` tables; see
`packages/web-acp-agent/TECHDEBT.md` for the migration shape. Not in
scope today.

**The user's "requested MCPs" list is NOT stored here.** The list of
URLs the user wants Bodhi to approve as MCP scopes lives per-browser
in acp-ui's KVStore (`mcp-requested.json`). The `/mcp add <url>` /
`/mcp remove <url>` commands mutate that browser-local list and
re-trigger a Bodhi login with the updated `addMcpServer` scopes; the
agent receives the result on `session/new` /  `session/load` via
`_meta.bodhi.{requestedMcpUrls, mcpInstances}` and connects to each
approved instance, surfacing per-server state through
`_bodhi/mcp/state` notifications. Per-server toggles stay browser-
local and round-trip through `_bodhi/mcp/toggles/set`. This mirrors
the contract `packages/web-acp/` ships in
`src/mcp/requested-mcps-store.ts`.

## acp-ui surfaces driven by this host

`ws-acp-client` is auth-agnostic and UI-less, but it ships hand-in-
hand with `acp-ui/` (Vue 3) which renders all the agent surfaces over
the wire. The combination supports the same user-visible feature set
as `packages/web-acp/`:

- **Sessions sidebar** — agent-driven via cursor-paginated
  `Agent.unstable_listSessions`. Click-to-resume restores the
  authoritative transcript via `LoadSessionResponse._meta.bodhi.messages`.
  Delete is wired through the `_bodhi/sessions/delete` ext-method;
  deleting the active session auto-creates a fresh empty session on
  the same agent + cwd so the chat surface is never stranded on the
  welcome screen.
- **Built-in slash commands** — `/help`, `/version`, `/info`,
  `/copy`, `/mcp` (and any vault-sourced `/wiki:*` commands) appear
  in the `/` palette via `available_commands_update`. Built-in
  replies render as muted bubbles with a "not sent to LLM" badge,
  driven by the `_meta.bodhi.builtin.command` tag the agent stamps
  on the assistant chunk. `/copy` rides an `_bodhi/builtin/action`
  notification that the host dispatches into
  `navigator.clipboard.writeText(renderConversationMarkdown(messages))`.
- **Volumes panel** — read-only renderer of the host's mounted
  volume set (`/mnt/cwd` plus every `--volume name=path`). Fed by
  the `_bodhi/volumes/list` ext-method on connect.
- **Features panel** — checkbox per `_bodhi/feature` entry the
  agent advertises on `NewSessionResponse.configOptions` /
  `LoadSessionResponse.configOptions`. Toggling fires
  `session/set_config_option`; the agent echoes the full updated
  snapshot which the store ingests verbatim. Reload-survival flows
  through the agent's preference store.
- **MCP panel + `/mcp add|remove`** — browser-local
  `mcp-requested.json` tracks the URLs the user wants Bodhi to
  approve. `/mcp add <url>` mutates the list and re-triggers a
  Bodhi `login()` with the augmented scope chain (`addMcpServer`),
  so the user lands on the access-request review page with a fresh
  toggle for the new MCP. On return, the next `session/new` or
  `session/load` sends `_meta.bodhi.{requestedMcpUrls, mcpInstances}`
  and the agent connects to each approved instance, surfacing per-
  server lifecycle through `_bodhi/mcp/state` notifications. `/mcp
  remove <url>` is the symmetric flow.

## Authentication

The agent advertises a single auth method, `bodhi-token`, on
`initialize`. Hosts (e.g. `acp-ui`, `web-acp`) push a Bodhi access
token + base URL in `_meta` on the ACP `authenticate` request:

```jsonc
{ "methodId": "bodhi-token", "_meta": { "token": "<jwt>", "baseUrl": "https://bodhi.example" } }
```

`ws-acp-client` itself stays auth-agnostic — it does not run an OAuth
flow, does not persist tokens, and does not log them. Each accepted
WebSocket connection gets a fresh `BodhiProvider` instance, so
authenticate calls do not leak between concurrent connections.

**Disconnect-only logout contract**: on the acp-ui side, clicking
"Logout" calls `acpClient.disconnect()` to drop the WebSocket bridge
+ wipes the local `bodhiAuth` token; it does NOT call
`_bodhi/sessions/delete` and does NOT remove anything from
`<cwd>/.ws-acp-client/state.db`. The next login + connect refetches
the session list from the agent via `Agent.unstable_listSessions`,
so logged-out + logged-back-in users see exactly the same sidebar
they left behind. Pairs with the single-tenant assumption above.

## Architecture

```
┌────────────┐      WebSocket       ┌──────────────────────────────────┐
│   Browser  │  (NDJSON JSON-RPC)   │ ws-acp-client (this package)     │
│   host     │ ───────────────────► │                                  │
│ (acp-ui /  │                      │ ┌─ HostState (per process) ────┐ │
│  web-acp)  │ ◄─────────────────── │ │ sqlite AppDb                  │ │
└────────────┘                      │ │   sessions (SessionStore)     │ │
                                     │ │   preferences (PreferenceStore)│ │
                                     │ │ ZenfsVolumeRegistry           │ │
                                     │ │   /mnt/cwd → PassthroughFS    │ │
                                     │ └───────────────────────────────┘ │
                                     │ ┌─ Per WS connection ──────────┐ │
                                     │ │ BodhiProvider (token holder) │ │
                                     │ │ startAgent({ registry,       │ │
                                     │ │   sessions, preferences,     │ │
                                     │ │   provider, transport })     │ │
                                     │ │ → handle.dispose() on close  │ │
                                     │ └──────────────────────────────┘ │
                                     └──────────────────────────────────┘
```

- `src/server.ts` — HTTP server (for health checks) wrapped by
  `ws.WebSocketServer`. Each new socket → `WsTransportPair` →
  one `startAgent({ transport, provider, registry, sessions,
  preferences })` call. `registry` is mandatory in the agent
  API; the host passes the shared `ZenfsVolumeRegistry` and
  sqlite-backed stores from `HostState`. The per-connection
  `BodhiProvider` carries that user's auth token. `startAgent`
  never mounts, unmounts, or disposes the registry — the host
  owns its lifecycle. Sharing a single registry across
  connections is required because ZenFS keeps a process-global
  mount table; two registries would collide on `/mnt/cwd`.
- `src/transport/ws-transport.ts` — adapts a `ws` socket to the
  WHATWG byte-stream pair `web-acp-agent` expects. Outbound chunks
  are sent as text frames (browsers' `WebSocket.onmessage` rejects
  binary frames in the acp-ui path).
- `src/services/assemble.ts` — `createHostState` opens the sqlite
  `AppDb` once per process and mounts the `$cwd` volume PLUS every
  `--volume` flag on the shared `ZenfsVolumeRegistry`. Per-connection
  wiring lives in `server.ts`.
- `src/services/cwd-volume.ts` — `createCwdVolumeInit({ cwd, mountName })`
  builds the `VolumeInit` for the always-mounted `cwd` volume; the CLI
  re-uses the same factory (passing the user-supplied `mountName`) for
  every `--volume name=path` flag, so all volumes go through one
  PassthroughFS path.
- `src/cli-args.ts` — `--volume name=path` parser, including the
  `[A-Za-z0-9_-]{1,63}` name validation, duplicate-name check, and
  the reserved-`cwd` collision check.
- `src/storage/*` — drizzle schema + better-sqlite3 opener +
  `SessionStore` / `PreferenceStore` impls.

## Development

```bash
npm run typecheck    # tsc --noEmit
npm run check        # alias for typecheck
npm run test:e2e     # playwright; spins BodhiApp NAPI + ws-acp-client + acp-ui dist-web
```

The e2e suite (under `e2e/`) is the primary correctness gate — it
boots a real BodhiApp NAPI instance, provisions an OpenAI-backed API
model, drives `acp-ui` through real OAuth + Keycloak round-trips,
and exercises the full prompt + tool path through the
PassthroughFS-mounted `$cwd`. Every code change to `src/` should be
followed by `npm run test:e2e` before committing.

## See also

- [`packages/web-acp-agent/`](../web-acp-agent/) — the agent core.
- [`packages/web-acp/`](../web-acp/) — the browser-resident host
  runtime (post-ACP-0.21 reference for new hosts).
- [`packages/cli-acp-client/`](../cli-acp-client/) — the Node CLI host
  (in-process MessageChannel transport, OAuth in-process).
- [`acp-ui/`](../../acp-ui/) — the Vue 3 frontend that drives this
  server in the e2e tests; also the canonical browser host for remote
  agents.
