# @bodhiapp/cli-acp-client

Claude-Code-style interactive CLI that **embeds `@bodhiapp/web-acp-agent`
in-process** and speaks Agent Client Protocol (ACP) over an in-memory
duplex transport. Exists primarily to prove that the agent runtime is
**transport- and host-neutral**: the same code that powers the browser
worker in `packages/web-acp/` runs unchanged inside a Node.js TTY.

> **Looking for task-shaped docs?** The full user guide lives at
> [`ai-docs/cli-acp-client/guide/`](../../ai-docs/cli-acp-client/guide/index.md).
> This README covers the architectural surface and contributor workflow;
> day-to-day usage (slash commands, MCP, volumes, sessions,
> troubleshooting) is in the guide.

## What it is

```
+-------------------+        ACP over MessageChannel        +-----------------------+
| packages/web-acp/ |  <----------------------------------> | web-acp-agent (Worker)|
+-------------------+                                        +-----------------------+

+----------------------+   ACP over in-memory duplex   +-----------------------+
| packages/cli-acp-     | <-------------------------> | web-acp-agent (Node)  |
| client/ (this pkg)   |                              +-----------------------+
+----------------------+
```

The CLI ships:

- A line-mode REPL (`--ci-line-mode`) for deterministic e2e and CI logs.
- A `pi-tui` interactive renderer for normal terminal use.
- A native Node OAuth 2.1 + PKCE client that talks to BodhiApp's
  access-request flow and Keycloak's token endpoint.
- An ACP client wrapper mirroring `packages/web-acp/src/acp/client.ts`.
- Auto-mounting of the launching `$cwd` as a ZenFS volume named
  `cwd` so the agent can read/write the user's working directory through
  ACP `fs/*`.

## Status

- [x] Slash command pipeline (`/host`, `/login`, `/logout`, `/models`,
      `/model`, `/mcp`, `/session`, `/volume`, `/feature`, `/help`, `/quit`).
- [x] OAuth flow with redirect callback server, Bodhi access-request
      consent, and Keycloak token exchange.
- [x] Embedded ACP host with Node service adapters.
- [x] Streaming state machine ported from `web-acp`, long-lived
      `client.onSessionUpdate` listener, MCP catalog/lifecycle/toggle
      wiring, builtin-action dispatcher (OSC 52 + print fallback),
      multi-volume mounts, sqlite-backed sessions/features/MCP toggles
      via Drizzle.
- [x] Unit + smoke tests; Playwright e2e scaffold (mirrors
      `packages/web-acp/e2e`).
- [ ] Token storage encryption (currently plaintext under
      `$cwd/.cli-acp-client/settings.json` — see Caveats).

## Install / build (workspace-local)

This package is private to the monorepo and is not published. Inside the
workspace root:

```bash
npm install                                # installs all workspaces
npm run check --workspace @bodhiapp/cli-acp-client
npm test --workspace @bodhiapp/cli-acp-client
```

To launch the CLI from source against a BodhiApp at `http://localhost:1135`:

```bash
npx tsx packages/cli-acp-client/src/cli.ts
```

Useful flags:

| Flag              | Purpose                                                          |
| ----------------- | ---------------------------------------------------------------- |
| `--ci-line-mode`  | Plain newline-delimited output (deterministic for e2e/CI).        |
| `--no-browser`    | Print the OAuth URL instead of spawning a browser.               |
| `--cwd <path>`    | Use `<path>` as the working dir + auto-mounted volume root.      |
| `--help`          | Inline usage.                                                    |

## Quick start

See [`ai-docs/cli-acp-client/guide/01-install-and-host.md`](../../ai-docs/cli-acp-client/guide/01-install-and-host.md)
for a walkthrough. TL;DR:

```text
$ npx cli-acp
> /host http://localhost:1135      # OAuth + tokens persisted to sqlite kv
> /model oai/gpt-4.1-nano
> Reply with the single word: pong.
```

For the rest of the surface see the user guide:

| Topic | Guide page |
| --- | --- |
| Prompts vs slash commands vs vault commands | [02](../../ai-docs/cli-acp-client/guide/02-vault-commands-and-prompts.md) |
| `bash` tool + `/mnt/cwd` | [03](../../ai-docs/cli-acp-client/guide/03-bash-tool.md) |
| MCP add / list / toggle / remove | [04](../../ai-docs/cli-acp-client/guide/04-mcp.md) |
| `/volume` mounts | [05](../../ai-docs/cli-acp-client/guide/05-volumes.md) |
| Sessions, replay, `/info`, `/copy` | [06](../../ai-docs/cli-acp-client/guide/06-sessions.md) |
| Troubleshooting (OSC 52, sqlite, OAuth) | [07](../../ai-docs/cli-acp-client/guide/07-troubleshooting.md) |
| Architecture overview (duplex, state stores) | [08](../../ai-docs/cli-acp-client/guide/08-architecture.md) |

## /host + /login flow (deep dive)

End-user flow lives in
[guide 01](../../ai-docs/cli-acp-client/guide/01-install-and-host.md).
The protocol-level steps are:

1. The CLI starts a callback server on **`127.0.0.1:5173`** by default.
   This port intentionally matches the one `packages/web-acp/`'s Vite
   dev server uses, because the Keycloak public client `cli-acp-client`
   is registered with `http://localhost:5173/callback` in its allowed
   `redirect_uri` list. Using a random port would trip Keycloak's
   redirect validation. Override per-cwd with
   `settings.callbackPort`.
2. It POSTs `/bodhi/v1/apps/request-access` with
   `flow_type: "redirect"`, `redirect_url: <local callback>`, the
   requested role, and any MCP servers in your wishlist.
3. The browser opens at the returned `review_url`; you sign in to
   Keycloak (via Bodhi's `/ui/login` wrapper) and approve the
   resources.
4. Bodhi redirects to the local callback with `?request_id=<id>`.
5. The CLI fetches the access-request status, builds a Keycloak
   authorize URL with the granted scope (`access_request:<id>`), and
   responds to the still-open browser request with a 302 to that URL.
6. Keycloak's SSO cookie is set, so it bounces the browser straight back
   to the local callback with `?code=...&state=...`.
7. The CLI exchanges the code for tokens at
   `<auth-server>/protocol/openid-connect/token` and pushes the access
   token to the embedded agent via ACP `authenticate`.

The OAuth client id is **hardcoded** as `cli-acp-client`. Register at
[developer.getbodhi.app](https://developer.getbodhi.app) (with localhost
wildcard redirect URIs) before deploying. The auth server defaults to
the dev IdP `https://main-id.getbodhi.app/realms/bodhi`; settings can
override this per-cwd.

## $cwd volume semantics

`<cwd>` is auto-mounted at `/mnt/cwd` via `PassthroughFS`. Add more
mounts with `/volume add <path> [<mountName>]` — see
[guide 05](../../ai-docs/cli-acp-client/guide/05-volumes.md).

To work in a different directory without changing your shell's `pwd`:

```bash
cli-acp --cwd ~/projects/my-thing
```

## Debugging failed `/login` attempts

The CLI is a developer/host tool, not an end-user product, so all auth
errors print verbose context: the operation stage, full URL, request
body preview, the Node `Error.cause` chain (so `fetch failed`'s real
underlying `ECONNREFUSED` / `ENOTFOUND` / TLS error is visible), and a
stack trace. Example for a wrong host:

```text
> /host localhost:9999
[info] Host set to http://localhost:9999. Starting /login flow...
[info] bodhiUrl=http://localhost:9999 authServerUrl=https://main-id.getbodhi.app/realms/bodhi
[info] Binding OAuth callback server on 127.0.0.1:5173
[info] POST http://localhost:9999/bodhi/v1/apps/request-access (client=cli-acp-client)
[error] Login flow failed:
[error] FetchFailureError: request-access (POST http://localhost:9999/...) failed at the network layer
[error]   ↳ caused by: TypeError: fetch failed
[error]     ↳ caused by: AggregateError:  [code=ECONNREFUSED]
[error] request body preview: {"app_client_id":"cli-acp-client",...}
[error]     at fetchWithDiagnostics (.../auth/debug.ts:134:11)
[error]     at async requestAccess (.../auth/access-request.ts:88:24)
[error]     at async runLoginFlow (.../auth/login-flow.ts:116:22)
```

If the host is reachable but the IdP rejects the redirect URI, you'll
see `HttpStatusError` with the response body. The Bodhi side typically
returns JSON with `error_description` — read that verbatim before
filing a bug.

## State storage

Per-cwd state lives under `<cwd>/.cli-acp-client/`:

| File | Owner | Contents |
| --- | --- | --- |
| `state.db` | sqlite (Drizzle) | `sessions`, `entries`, `features`, `mcp_toggles`, `kv` (requested MCPs, last model id, persisted volumes). |
| `settings.json` | settings store | `host`, `authServerUrl`, `callbackPort`, `tokens`. The deprecated `lastModelId` / `requestedMcps` keys are still readable for the one-shot migration. |

Plaintext example of `settings.json`:

```json
{
  "host": "http://localhost:1135",
  "authServerUrl": "https://main-id.getbodhi.app/realms/bodhi",
  "tokens": {
    "accessToken": "...",
    "refreshToken": "...",
    "expiresAt": 1735689600000,
    "tokenType": "Bearer"
  }
}
```

> **Plaintext tokens.** Tokens are written unencrypted. If you share the
> directory (e.g. via cloud sync) treat the file as a credential. We will
> swap to OS keychain storage in a follow-up; for now keep the
> `.cli-acp-client/` directory out of version control (the package's
> `.gitignore` does this for our repo).

## End-to-end test harness

`npm run test:e2e` (from the package root) runs Playwright against a
real BodhiApp NAPI instance. The scaffold mirrors `packages/web-acp/e2e/`:

- `e2e/tests/global-setup.ts` boots BodhiApp via
  `@bodhiapp/app-bindings`, signs in as the admin user, and registers
  one OpenAI API model.
- `e2e/tests/utils/cli-harness.ts` spawns the CLI in
  `--ci-line-mode --no-browser`, exposes `send` / `waitFor` line-by-line
  helpers.
- `e2e/tests/utils/auth-driver.ts` walks Playwright through the OAuth
  flow (review URL → Keycloak credentials → access-request approve).
- `e2e/cli.spec.ts` is the happy-path test: `/host` → OAuth → `/models`
  → `/model` → prompt → assert streamed `pong`.

Prerequisites:

1. Copy `e2e/.env.test.example` to `e2e/.env.test` and fill in
   credentials (the same contract `web-acp/e2e` uses). At minimum:
   `BODHIAPP_*`, `OPENAI_API_KEY`.
2. Symlink `e2e/bin` to the platform-stub directory under
   `web-acp/e2e/bin` (already done in this repo).
3. Register the `cli-acp-client` OAuth client at the configured
   `BODHIAPP_AUTH_URL` with `http://localhost:*/callback` allowed.
   Without this, the OAuth round-trip in the test will fail at
   Keycloak's redirect-URI validation step.

```bash
npm run test:e2e --workspace @bodhiapp/cli-acp-client
```

Set `CLI_ECHO=1` to mirror CLI stdout into the test runner's stdout for
debugging.

## Architecture notes

- **In-memory duplex** (`src/acp/duplex.ts`): two `TransformStream`
  pairs joined head-to-tail give us a `client.read ↔ agent.write` and
  `agent.read ↔ client.write` byte stream that satisfies
  `@agentclientprotocol/sdk`'s `AgentSideConnection.fromStream`.
- **No Worker, no main thread**: both sides run in the CLI process.
  Latency is the cost of a `TransformStream` hop; useful for stepping
  through the agent under a debugger.
- **Settings are the source of truth**: `host`, `authServerUrl`,
  `tokens`, `requestedMcps`, and `lastModelId` are all persisted; the
  embedded agent is rebuilt from them on every launch.
- **No `pi-ai` browser shim required**: web-acp pulls in
  `BodhiProvider` from `@bodhiapp/web-acp-agent`, which uses the
  Node-native `fetch` directly. The streaming hot path goes through
  `streamSimple` from `@mariozechner/pi-ai` which exposes a
  Web-Streams-based reader; Node 20+ supports this natively.
