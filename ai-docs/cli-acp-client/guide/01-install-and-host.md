# 01. Install and connect

## Install

`cli-acp-client` lives in the `pi-mono` workspace. From a fresh
clone:

```sh
npm install
npm --workspace @bodhiapp/cli-acp-client run dev
```

For ad-hoc invocation outside the workspace, build first and run
the compiled entry:

```sh
npm --workspace @bodhiapp/cli-acp-client run build
node packages/cli-acp-client/dist/cli.js --cwd "$(pwd)"
```

## Run modes

| Flag | Purpose |
| --- | --- |
| _(none)_ | `pi-tui` interactive renderer (default). |
| `--ci-line-mode` | Plain stdin/stdout REPL — used by e2e tests; one event per line; deterministic snapshots. |
| `--no-browser` | Print the OAuth URL instead of launching a browser. Useful for headless boxes. |
| `--cwd <path>` | Override the working directory. The CLI's sqlite state and `/mnt/cwd` volume are both rooted here. |

## Configure a host

The first command in any session is `/host <url>`:

```
> /host https://bodhi.example.com
```

That triggers an OAuth 2.1 + PKCE flow:

1. The CLI starts a localhost callback server on a random port.
2. It prints a `review_url` to stdout (or opens it in the default
   browser).
3. The browser walks: BodhiApp login → Keycloak realm sign-in →
   Access-request review → 302 to the CLI callback.
4. The CLI exchanges the auth code for tokens and persists them to
   `<cwd>/.cli-acp-client/settings.json`.

After `/host`, the access token is pushed to the embedded agent via
`bodhi/authenticate` so every MCP call carries the right
`Authorization: Bearer ...` header.

## Pick a model

```
> /models             # list models registered on the host
> /model oai/gpt-4.1-nano
```

The active model id is persisted to sqlite kv (`lastModelId`) and
restored on the next launch — no need to re-pick.

## Refresh / re-authenticate

- `/login` — re-run the OAuth flow (e.g. after `/mcp add` to refresh
  the requested-MCP scope).
- `/logout` — drop tokens; subsequent prompts error until you log
  back in.

## Where credentials live

- Access + refresh tokens: `<cwd>/.cli-acp-client/settings.json`.
  This file is plaintext — **do not commit it**.
- `requestedMcps` (the URL wishlist) and `lastModelId`: sqlite
  (`<cwd>/.cli-acp-client/state.db`).
- The settings JSON keeps the older `requestedMcps`/`lastModelId`
  keys readable for a one-shot migration; new writes go to sqlite.
