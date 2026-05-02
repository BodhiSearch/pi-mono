# 04. MCP servers — add, toggle, remove

`cli-acp-client` consumes Model Context Protocol (MCP) servers
exactly the way the browser host does:

1. The user asks BodhiApp to **provision** an MCP URL via OAuth
   (`/mcp add` + `/login`).
2. BodhiApp returns a catalog of `McpInstanceView` records
   (`{slug, name, path, enabled}`).
3. The CLI composes `McpServerHttp[]` with the current JWT and
   passes it on every `session/new` / `session/load`.
4. The agent's `McpConnectionPool` opens
   `StreamableHTTPClientTransport` connections and emits
   `_meta.bodhi.mcp` lifecycle events as servers connect.

## Wishlist + provisioning

The CLI persists your **requested** MCP URLs in sqlite kv
(`KV_REQUESTED_MCPS`). Mutating the wishlist is a two-step process:

```
> /mcp add https://my-mcp.example.com/sse
Added https://my-mcp.example.com/sse. Run /login to refresh the access-request scope.
> /login
# OAuth flow re-runs; Keycloak surfaces the new scope.
```

Provisioning the actual MCP server happens server-side in BodhiApp
— the CLI just submits the wishlist on every `/login`.

## Listing

```
> /mcp list
Instances (2/3 connected):
  ● deepwiki         connected [12 tools]
  ● my-mcp           connected [4 tools]
  ✗ broken-server    error — handshake timeout

Pending or denied (1):
  • https://still-provisioning.example.com/mcp
```

The **Instances** block reflects the live BodhiApp catalog; the
**Pending or denied** block shows wishlist URLs that BodhiApp has
not (yet) returned an instance for — typically because Keycloak
denied the access request.

The bullet glyph encodes connection state:

| Glyph | State |
| --- | --- |
| `●` | connected |
| `◌` | connecting |
| `◯` | disconnected |
| `✗` | error |

## Aggregated status line

Every time any MCP transitions, the CLI emits one summary line
(`[mcp] 2/3 server(s) connected`) so you don't have to re-run
`/mcp list`. Per-server transitions also surface their own
single-line `[mcp] <slug>: <state>` notification.

## Per-session toggles

`/mcp on|off` toggles a server (and optionally specific tools)
within the current session — without removing it from the wishlist:

```
> /mcp off deepwiki
Server 'deepwiki' set to off for session <id>.

> /mcp on my-mcp:read,search
my-mcp: 2 tool(s) set to on.
```

Toggles persist across `/session load` because they are stored in
the agent's `McpToggleStore` (sqlite-backed, sessionId-keyed).

## Removing

```
> /mcp remove https://my-mcp.example.com/sse
Removed https://my-mcp.example.com/sse. Run /login to refresh.
```

Removing only updates the wishlist; the actual MCP instance stays
provisioned in BodhiApp until you manage it from the BodhiApp UI.

## Agent-side `/mcp` builtin

The agent ships a parallel `/mcp` builtin so a model can request
add/remove operations during a turn:

```
[turn 4]
> /mcp add https://docs-mcp.example.com/mcp
[mcp] add request received — run /login to confirm.
```

The agent emits a `_meta.bodhi.builtin.action = { kind: 'mcp-add', params: {...} }`
which the CLI dispatcher routes to a sqlite kv mutation. You still
have to run `/login` to actually provision; the builtin only
updates the wishlist.
