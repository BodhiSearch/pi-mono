# cli-acp-client

**Source of truth:** `packages/cli-acp-client/src/`.

**Status:** living document — update as part of any plan that
changes the source folder. The CLI host shipped post-M4 phase B
agent-package extraction as a deliberate proof point that
`@bodhiapp/web-acp-agent` is genuinely host-neutral. Two host
runtimes (browser worker, Node TTY) consume the same agent code
over the same ACP wire; the only divergence is above the
transport boundary.

## Purpose

`packages/cli-acp-client/` is a Claude-Code-style interactive
CLI that **embeds `@bodhiapp/web-acp-agent` in-process** and
speaks ACP JSON-RPC 2.0 over an in-memory duplex byte-stream
pair. The same code that runs as the browser's Web Worker agent
runs unchanged inside the Node CLI process — no fork, no shim
layer, just a different transport and a different services bag.

Three things drive the design:

- **Transport-neutrality proof.** If the agent runtime can be
  embedded over `MessageChannel` (browser) **and** over
  `TransformStream` pairs (CLI), the M8 library-extract claim
  that the agent is host-portable is no longer hypothetical.
  An HTTP/SSE host slots in behind the same boundary later.
- **Developer-loop ergonomics.** Stepping through the agent
  under `--inspect-brk` is one `npx tsx` away. No worker
  spawning, no IDE-glued debug protocol bridging, no browser
  devtools sourcemap dance.
- **A second e2e seam.** `packages/web-acp/e2e/` exercises the
  full UI stack against a real BodhiApp; the CLI's e2e exercises
  the same agent behind a deterministic line-mode REPL. Each
  catches what the other cannot (UI vs streaming framing).

## Hard constraints

- `packages/cli-acp-client/` MUST NOT import from
  `packages/web-acp/`. The agent code lives behind the
  `@bodhiapp/web-acp-agent` workspace dep; the CLI's only
  cross-package import.
- The CLI MUST NOT pull browser-only deps (`@zenfs/dom`,
  `dexie`, `idb-keyval`, FSA types). The agent package already
  guarantees this for itself; the CLI inherits it by sticking to
  `@zenfs/core` + `@zenfs/core/backends/passthrough.js`.
- ACP is the wire. No bespoke JSON-RPC between dispatcher and
  embedded agent. The dispatcher consumes `AcpClient` (a thin
  wrapper over `ClientSideConnection`); the agent consumes
  `AcpAgentAdapter` (constructed by `startAcpAgent`).

## Folder layout

```
packages/cli-acp-client/src/
├── cli.ts                  # Entry point: arg parsing, banner, bootstrap, exit handling.
├── bootstrap.ts            # Wires renderer + dispatcher + embedded host + settings.
├── index.ts                # Public re-exports for tests.
├── acp/
│   ├── embedded-host.ts    # createEmbeddedHost(): startAcpAgent + ClientSideConnection over duplex
│   ├── client.ts           # AcpClient — mirrors packages/web-acp/src/acp/client.ts
│   ├── duplex.ts           # createInMemoryDuplex(): two TransformStream pairs
│   └── index.ts
├── auth/                   # Node-native OAuth 2.1 + PKCE client
│   ├── config.ts           # APP_CLIENT_ID, DEFAULT_AUTH_SERVER_URL, DEFAULT_CALLBACK_PORT, scope helpers
│   ├── pkce.ts             # createPkcePair (code_verifier + S256 challenge + state)
│   ├── access-request.ts   # POST /bodhi/v1/apps/request-access; GET status
│   ├── callback-server.ts  # ephemeral http.Server on 127.0.0.1:<port>
│   ├── login-flow.ts       # runLoginFlow(): two-phase consent + Keycloak code exchange
│   ├── token-exchange.ts   # exchangeCodeForTokens / refreshTokens / revokeRefreshToken
│   ├── browser-opener.ts   # `open` package wrapper + print-only opener for --no-browser/CI
│   ├── debug.ts            # formatErrorChain, FetchFailureError, HttpStatusError, fetchWithDiagnostics
│   └── index.ts
├── commands/               # One file per slash command
│   ├── help.ts host.ts login.ts logout.ts mcp.ts models.ts session.ts quit.ts
│   ├── prompt.ts           # default handler — accumulates streamed deltas, emits cumulative text
│   └── index.ts
├── services/               # Node implementations of the agent-package interfaces
│   ├── assemble.ts         # assembleNodeServices() — provider, registry, stores, $cwd volume
│   ├── stores.ts           # in-memory SessionStore / FeatureStore / McpToggleStore
│   ├── cwd-volume.ts       # createCwdVolumeInit(): PassthroughFS over node:fs at $cwd
│   └── index.ts
├── settings/               # zod-validated $cwd/.cli-acp-client/settings.json
│   ├── schema.ts           # SettingsSchema, TokenBundleSchema
│   ├── store.ts            # createSettingsStore(): load/patch/save
│   └── index.ts
├── shell/
│   ├── context.ts          # AppContext: status, modelId, sessionId, tokens, MCP servers
│   ├── registry.ts         # CommandRegistry: name → SlashCommand
│   ├── parser.ts           # /command + args, plain-prompt detection
│   ├── dispatcher.ts       # routes input lines to commands or prompt(); error rendering
│   ├── history.ts          # in-process input history (line-mode + pi-tui)
│   ├── types.ts            # Renderer / ShellMessage / ConnectionStatus / SlashCommandSummary
│   └── index.ts
└── tui/
    ├── pi-renderer.ts      # @mariozechner/pi-tui renderer (default)
    ├── line-renderer.ts    # plain-text per-message renderer (used by line-repl + tests)
    ├── line-repl.ts        # readline-based REPL for --ci-line-mode
    ├── themes.ts           # editor theme defaults
    └── index.ts

packages/cli-acp-client/e2e/
├── cli.spec.ts             # happy path: /host → OAuth → /models → /model → prompt → assert pong
├── tests/
│   ├── global-setup.ts     # spawns BodhiApp via @bodhiapp/app-bindings, registers admin + model
│   └── utils/
│       ├── cli-harness.ts  # spawns CLI in --ci-line-mode --no-browser, exposes line-by-line waitFor
│       └── auth-driver.ts  # Playwright walks BodhiApp review UI + Keycloak SSO
└── bin/                    # symlink → packages/web-acp/e2e/bin (BodhiApp NAPI platform stubs)
```

## Boot sequence

The CLI's startup mirrors the browser worker's narratively, but
above the transport everything is bare Node code rather than
React + service-worker plumbing.

1. **`cli.ts`** parses argv (`--ci-line-mode`, `--no-browser`,
   `--cwd`, `--help`), prints a banner, picks an opener
   (browser-launching or print-only), and calls `bootstrapCli`.
2. **`bootstrap.ts:bootstrapCli`** opens the settings store at
   `$cwd/.cli-acp-client/settings.json` (creating the directory
   if absent), then `createEmbeddedHost({ cwd })`:
   - **`embedded-host.ts:createEmbeddedHost`**:
     1. `assembleNodeServices({ cwd })` constructs the
        `BodhiProvider`, the `InlineAgent`, the
        `ZenfsVolumeRegistry` with a single `/mnt/cwd`
        `PassthroughFS` mount, and the in-memory store trio.
     2. `createInMemoryDuplex()` returns two byte-stream pairs
        joined head-to-tail (`agent.readable ↔ client.writable`,
        `client.readable ↔ agent.writable`).
     3. `startAcpAgent(duplex.agent, services, opts)` (from
        `@bodhiapp/web-acp-agent`) frames `ndJsonStream` over
        the agent half and returns the live
        `AgentSideConnection`. The host captures the
        `AcpAgentAdapter` via `onAdapter` so it can call
        `dispose()` on shutdown.
     4. The host wraps the client half with `ndJsonStream` and
        passes it to `new ClientSideConnection(toClient, stream)`.
     5. `client.initialize()` exchanges the ACP capability
        handshake. The `clientCapabilities.fs` is currently
        `{ readTextFile: false, writeTextFile: false }` — the
        CLI does not advertise the IDE-integration `fs/*` seam
        (the bash tool talks to `/mnt/cwd` directly).
3. **Renderer** is selected by `--ci-line-mode`: `pi-tui`'s
   `Editor`-based UI for interactive use, or a `readline`-based
   line REPL for tests.
4. **`createAppContext`** seeds runtime state from
   `initialSettings`: `modelId = lastModelId`, `tokens =
   tokens`, `status = disconnected (token refresh pending)` if
   a host is configured, else `disconnected (no host configured)`.
5. **`createDispatcher`** returns a function that the renderer's
   submit handler calls per input line. It parses (`/cmd args`
   vs plain-prompt) and routes to either the
   `CommandRegistry.handler` or `handlePrompt` — both via a
   single `try/catch` that pipes errors through `formatErrorChain`.
6. **`tryRefreshTokens`**: if `settings.tokens` is fresh enough
   (>30s remaining), the CLI calls `client.authenticate({ token,
   baseUrl })` directly. If expired, it refreshes against the IdP
   then re-authenticates. After every successful `authenticate`
   we **warm the agent's model catalog** by calling
   `client.listModels()` so the very next `/prompt` resolves
   `_meta.bodhi.modelId` against a populated cache (the agent's
   `prompt-driver` looks up the model in its in-memory catalog,
   not the upstream Bodhi API).

The above is the entire startup. From step 2 onwards the agent
is byte-identical to the browser worker; the only host-specific
work is steps 1, 3, 4, 5, 6.

## Slash command surface

| Command | Description |
| --- | --- |
| `/help` | Print the registered command list. |
| `/host <url>` | Set the BodhiApp URL and auto-trigger `/login` if a host change happens. Auto-prepends `http://` to bare `host[:port]`. |
| `/login` | Run the BodhiApp access-request + Keycloak PKCE flow. Persists tokens to settings. |
| `/logout` | Revoke the refresh token (best-effort) and clear local tokens. |
| `/models` | List the model catalog from the connected BodhiApp host. |
| `/model <id>` | Set the active model id; persisted as `lastModelId`. |
| `/mcp add <url>` | Add a new MCP server URL to the requested-resources wishlist (re-login required to take effect). |
| `/mcp list` / `/mcp remove <url>` | Inspect / mutate the wishlist. |
| `/session list` / `/session new` / `/session load <id>` / `/session delete <id>` | In-memory only in v0 — no cross-launch persistence. |
| `/quit` | Cleanly shut down (calls `host.dispose()` then `process.exit(0)`). |

Plain-text input (no leading `/`) is routed to the default
prompt handler.

## Authentication flow

Two-phase, network-shape identical to BodhiApp's web flow:

1. `requestAccess` POSTs `/bodhi/v1/apps/request-access` with
   `flow_type: "redirect"`, `redirect_url: <local callback +
   ?bodhi_flow=access_request>`, requested role, and the
   `mcp_servers` wishlist.
2. The browser opens at `review_url`; the user signs in to
   Keycloak (via Bodhi's `/ui/login` wrapper) and approves the
   resource set.
3. Bodhi redirects to the local callback with `?id=<request_id>
   &bodhi_flow=access_request`. The CLI's callback server
   recognises that as Phase 1.
4. The CLI fetches `/bodhi/v1/apps/request-access/<id>/status`
   (must return `approved`), reads `access_request_scope`, then
   responds to the still-open browser request with a `302` to
   Keycloak's `/protocol/openid-connect/auth?...&scope=openid
   email profile roles access_request:<id>...&code_challenge=
   ...&code_challenge_method=S256...`.
5. Keycloak's SSO cookie is set; it bounces back to the local
   callback with `?code=...&state=...` (Phase 2).
6. `exchangeCodeForTokens` POSTs Keycloak's token endpoint;
   tokens are persisted to settings; `client.authenticate({
   token, baseUrl })` pushes the token to the embedded agent;
   `client.listModels()` warms the agent's model catalog.

Verbose error reporting is the rule, not the exception — every
`fetch` rides through `fetchWithDiagnostics`, which raises
`FetchFailureError` (with `code/syscall/address/port` from
Node's `Error.cause`) or `HttpStatusError` (with body preview)
on failure. `formatErrorChain` walks both `Error.cause` chains
**and** raw JSON-RPC error envelopes (ACP rejects with
`{ code, message, data }` directly, not an Error instance).

The OAuth client id is **hardcoded** as
`bodhi-app-f181a4d1-d7af-43f4-965a-0a8efd453d86`. Override the
auth server with `settings.authServerUrl`; override the
callback port with `settings.callbackPort` (default `5173`,
chosen to match the registered Keycloak `redirect_uri` for the
shared dev client).

## Service implementations (Node-flavored)

The agent package declares interfaces; the CLI provides minimal
in-memory implementations:

- **`SessionStore`** (in-memory `Map<id, SessionRow>` +
  `Map<id, SessionEntry[]>`) — `/session list` only sees the
  current run. SQLite-backed swap-in is a follow-up; the agent
  reads through the same interface.
- **`FeatureStore`** — `Map<sessionId, Record<key, boolean>>`
  merged with `FEATURE_DEFAULTS` from the agent package.
- **`McpToggleStore`** — `Map<sessionId, McpToggleSnapshot>`,
  cloned on every read so callers can't mutate cached state.
- **`VolumeRegistry`** — `ZenfsVolumeRegistry` from the agent
  package (host-agnostic), seeded with
  `createCwdVolumeInit({ cwd })` which builds a `PassthroughFS`
  over Node's native `fs` rooted at `$cwd`. The agent sees the
  user's project files at `/mnt/cwd`.

Settings persistence is the only on-disk store: zod-validated
JSON at `$cwd/.cli-acp-client/settings.json`. Tokens are
written **plaintext** in v0; OS keychain swap is a follow-up.

## Streaming and rendering contract

ACP `agent_message_chunk` notifications carry the *delta*
emitted by the LLM since the previous chunk (see
`web-acp-agent/src/acp/engine/prompt-driver.ts` —
`text.slice(cursor.emittedLength)`). Both renderers replace the
text under a given `id`, so emitting raw deltas would overwrite
each fragment instead of accumulating. `commands/prompt.ts`
therefore allocates a fresh per-turn id (`assistant-N`) and
accumulates per-`messageId` buffers; each emit pushes the
cumulative text under the per-turn id, so the renderer's
replace-semantics produces the expected "growing line" effect
and one assistant slot per question.

`tool_call` / `tool_call_update` updates use the agent's
`toolCallId` directly — those updates carry full state
(`status`, `title`), not deltas, so replace-semantics is
correct. `plan` updates are skipped in v0.

## Testing

- **Unit tests** (`npm test`): vitest covers the auth modules
  (PKCE, callback server, login flow URL building, access
  request body shape, error chain formatting, token exchange),
  the dispatcher + parser + history, the embedded host
  handshake, and the smoke check that `BodhiProvider` actually
  streams against a Node `fetch`.
- **End-to-end** (`npm run test:e2e`): mirrors
  `packages/web-acp/e2e/` exactly. `global-setup.ts` boots
  BodhiApp via `@bodhiapp/app-bindings` on `127.0.0.1:51135`
  (matches the Keycloak-registered admin redirect), signs in
  the admin, and registers one OpenAI API model. `cli.spec.ts`
  spawns the CLI under `--ci-line-mode --no-browser`, drives
  the OAuth flow with Playwright (clicking through Bodhi's
  review UI + Keycloak SSO), and asserts that a streamed
  prompt produces the expected reply.
- **Mandatory.** Any change under `packages/cli-acp-client/` or
  `packages/web-acp-agent/` runs `npm run test:e2e` from the
  CLI's package root before commit. The full agent + transport
  + LLM round-trip is only exercised end-to-end.

## Public surface

The CLI is private to the monorepo (`"private": true`) and
not published. `src/index.ts` exposes test-friendly factories
(`bootstrapCli`, `createEmbeddedHost`, `assembleNodeServices`,
`createInMemoryDuplex`, the OAuth helpers) so external test
suites can drive a CLI in-process. The library version
(`@bodhiapp/cli-acp-client` as a dep on npm) lands when M8's
extract step does — by then the OAuth/callback/settings code
is generic enough to ship as a starter kit for "embed
`@bodhiapp/web-acp-agent` in your own Node host".

## Change procedure

Any plan that modifies files under
`packages/cli-acp-client/src/` MUST update this spec in the
same commit. Bullet list of touched files in the plan; brief
note when the surface is a pure internal refactor.

When a topic grows large enough to need its own file (e.g.
auth gets multi-IdP, settings get migrated to keychain), split
this `index.md` into per-topic files following the
[`../web-acp/`](../web-acp/index.md) pattern (one file per
folder, `Source of truth:` header per file, navigation table
in `index.md`).

## Cross-references

- `packages/cli-acp-client/README.md` — user-facing install /
  usage / debugging guide.
- [`../web-acp/index.md`](../web-acp/index.md) — the sibling
  host runtime; specs cover the shared agent code.
- [`../web-acp/startup-sequence.md`](../web-acp/startup-sequence.md)
  — boot narrative for the browser host; the part below the
  transport boundary applies verbatim to the CLI.
- [`../../milestones/index.md`](../../milestones/index.md) §
  "Post-M4 phase B agent-package extraction" — the change that
  enabled this CLI to exist.
- [`../../steering/02-architecture.md`](../../steering/02-architecture.md)
  § "The Transport boundary" — the architectural claim this
  package validates.
