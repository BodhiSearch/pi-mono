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
  --cwd /path/to/working/dir
```

Flags:

- `--port <n>` — listen port. `0` picks an ephemeral port; the chosen
  port is printed on stdout in the line `ready: ws://host:port`.
- `--bind <host>` — interface to bind. Defaults to `127.0.0.1`.
- `--cwd <path>` — agent's working directory + sqlite location.
  Defaults to `process.cwd()`.

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
(`mcp:toggles`). **Two browser tabs talking to the same
`ws-acp-client` process see the same session list** — that is
intentional for single-user laptop deployments. Multi-tenant
hardening would require per-connection authentication-derived
namespacing on `session_id`; not in scope today.

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
                                     │ │ InlineAgent (turn loop)      │ │
                                     │ │ AcpAgentAdapter              │ │
                                     │ │ → assembleServices points    │ │
                                     │ │   at the shared registry +   │ │
                                     │ │   stores                     │ │
                                     │ └──────────────────────────────┘ │
                                     └──────────────────────────────────┘
```

- `src/server.ts` — HTTP server (for health checks) wrapped by
  `ws.WebSocketServer`. Each new socket → `WsTransportPair` →
  per-connection `BodhiProvider` + `InlineAgent` +
  `assembleServices({ … registry, store, preferences })` →
  `AcpAgentAdapter` driven by `AgentSideConnection`. The advanced
  surface lives at `@bodhiapp/web-acp-agent/test-utils` because
  multi-connection hosts need to share a single
  `ZenfsVolumeRegistry` (ZenFS keeps a process-global mount table —
  two registries would collide on `/mnt/cwd`).
- `src/transport/ws-transport.ts` — adapts a `ws` socket to the
  WHATWG byte-stream pair `web-acp-agent` expects. Outbound chunks
  are sent as text frames (browsers' `WebSocket.onmessage` rejects
  binary frames in the acp-ui path).
- `src/services/assemble.ts` — `createHostState` opens the sqlite
  `AppDb` once per process and mounts the `$cwd` volume on the
  shared `ZenfsVolumeRegistry`. Per-connection wiring lives in
  `server.ts`.
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
