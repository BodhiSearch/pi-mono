# Headless ACP-protocol e2e tests for `@bodhiapp/web-acp-agent`

## Context

The agent runtime in `packages/web-acp-agent/` currently ships with
unit tests under `src/**/*.test.ts` plus the browser-host e2e in
`packages/web-acp/e2e/` and the CLI-host e2e in
`packages/cli-acp-client/e2e/`. Both host-level e2e suites cover the
agent indirectly: web-acp drives a real browser tab, cli-acp-client
spawns a CLI subprocess and parses stdout. Neither lets a contributor
confirm that the agent's wire surface is ACP-compliant by speaking
ACP at it directly.

We want a new test suite at `packages/web-acp-agent/e2e/` that:

1. **Embeds** the agent in-process (same shape as
   `packages/tutorial-cli-client/src/agent/embed.ts` and
   `packages/cli-acp-client/src/acp/embedded-host.ts`) over the
   public `createInMemoryDuplex` transport.
2. Talks to it via **`ClientSideConnection` from `@agentclientprotocol/sdk`**
   only — no UI, no Playwright assertions, no subprocess parsing.
3. Runs **fast and concurrent** (vitest, file-level parallelism)
   against a **single shared BodhiApp + JWT** booted once in
   global-setup.
4. Mirrors the chat + sessions slices of `packages/web-acp/e2e/`
   spec-for-spec, so any drift between the host-level e2e and the
   protocol-level e2e is a real bug rather than a test-style
   difference.

Goal: prove ACP-compliance, surface protocol regressions earlier
(currently they only show up at host-level e2e), and give the agent
package its own deterministic e2e seam ahead of the M11 npm publish.

## Decisions locked in

| # | Decision | Why |
|---|---|---|
| 1 | **Test runner: vitest** | File-level parallelism, fast cold-start, `defineWorkspace` already in repo style, no Playwright fixtures needed in specs. |
| 2 | **Token strategy: shared JWT in `.test-state.json`** | global-setup runs OAuth + access-request once via headless Playwright; specs each call `client.authenticate({ token, baseUrl })` against their own embedded agent. |
| 3 | **First-cut scope: chat + sessions** | Smallest meaningful slice — proves initialize/authenticate/prompt/cancel and listSessions/loadSession/closeSession/`_bodhi/sessions/delete` end-to-end. Built-ins, MCP, tools, extensions are post-first-cut. |
| 4 | **Self-contained: copy BodhiApp setup code** | No cross-package imports from `packages/web-acp/e2e/`. Each package's e2e owns its fixture wiring; matches how `cli-acp-client/e2e` already works. |

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  vitest spec (Node)                                          │
│  ├─ ClientSideConnection (from @agentclientprotocol/sdk)     │
│  ├─ ndJsonStream over duplex.client                          │
│  └─ asserts on responses + accumulates session/update        │
├──────────────────────────────────────────────────────────────┤
│  createInMemoryDuplex()  — TransformStream byte-pair         │
├──────────────────────────────────────────────────────────────┤
│  startAgent({ transport: duplex.agent, provider, registry })│
│  ├─ AcpAgentAdapter                                          │
│  ├─ BodhiProvider — talks to shared BodhiApp via JWT         │
│  ├─ ZenfsVolumeRegistry — fresh per spec                     │
│  └─ in-memory SessionStore + PreferenceStore                 │
└──────────────────────────────────────────────────────────────┘
        │
        │ HTTPS (real LLM via BodhiApp)
        ▼
┌──────────────────────────────────────────────────────────────┐
│  BodhiApp (booted once in global-setup, shared across specs) │
│  + Keycloak (existing dev IdP at $BODHIAPP_AUTH_URL)         │
└──────────────────────────────────────────────────────────────┘
```

Each spec gets its own embedded agent + duplex +
ClientSideConnection. The only shared state across specs is the
BodhiApp instance + the JWT. Specs are isolated above the transport
boundary.

## Folder layout

```
packages/web-acp-agent/e2e/
├── .env.test.example          # env var template (BODHIAPP_*, OPENAI_API_KEY, ...)
├── .gitignore                 # .env.test, .test-state.json, test-results/
├── vitest.config.e2e.ts       # separate config: include only e2e/**, globalSetup
├── tests/
│   ├── global-setup.ts        # boot BodhiApp + OAuth + register model + write state
│   └── utils/
│       ├── bodhi-server.ts    # copy of web-acp/e2e BodhiServerManager (NAPI bindings)
│       ├── auth-driver.ts     # copy of cli-acp-client auth-driver (Playwright OAuth UI walk)
│       ├── token-acquire.ts   # vitest-side wrapper invoking the local copy of runLoginFlow
│       ├── test-state.ts      # read/write .test-state.json typed accessors
│       └── auth/              # COPIED + adapted from packages/cli-acp-client/src/auth/
│           ├── pkce.ts
│           ├── callback-server.ts
│           ├── access-request.ts
│           ├── login-flow.ts
│           ├── token-exchange.ts
│           ├── config.ts
│           └── debug.ts
├── bin/                       # COPY of web-acp/e2e bin platform stubs (not a symlink)
├── helpers/
│   ├── embed-agent.ts         # createEmbeddedAgent({ token, baseUrl }) → { client, dispose }
│   ├── seed-volumes.ts        # thin wrappers over buildSeedInit + unique mount-name helper
│   └── notification-buffer.ts # collects session/update + extNotification streams for assertions
├── chat.spec.ts               # initialize, authenticate, newSession, prompt, cancel
└── sessions.spec.ts           # newSession persistence, listSessions cursor, loadSession replay,
                                #   closeSession in-memory cleanup, _bodhi/sessions/delete
```

Why a sibling `vitest.config.e2e.ts` rather than extending the
existing `vitest.config.ts`: e2e specs need `globalSetup`,
real-network access, and **must not** be picked up by the unit-test
run (`npm test`). The unit `vitest.config.ts` keeps its current
`include`; the e2e config sets `include: ['e2e/**/*.spec.ts']` and
`globalSetup: ['e2e/tests/global-setup.ts']`.

## Files to copy / reuse (with paths)

### Copy verbatim (fixture infrastructure)

- `packages/web-acp/e2e/tests/utils/bodhi-server.ts` → `packages/web-acp-agent/e2e/tests/utils/bodhi-server.ts` (copy; the file consumes `@bodhiapp/app-bindings` only — no downstream workspace deps)
- `packages/web-acp/e2e/bin/` → **copy**, not symlink. Symlinking would be a runtime path traversal into a downstream package. Duplicate the platform stub layout (it's a few stub files; fine to maintain in two places).
- `packages/web-acp/e2e/.env.test.example` → starting point for `packages/web-acp-agent/e2e/.env.test.example`
- `packages/cli-acp-client/e2e/tests/utils/auth-driver.ts` → `packages/web-acp-agent/e2e/tests/utils/auth-driver.ts` (Playwright UI-walk; copy verbatim, adjust selectors only if the Bodhi review UI differs)
- `packages/cli-acp-client/src/auth/*.ts` → `packages/web-acp-agent/e2e/tests/utils/auth/*.ts` (see prior section — copy + adapt; **not** an import)

### Copy + adapt (NOT import — see "Hard rule" below)

OAuth machinery from `packages/cli-acp-client/src/auth/` — copy
and adapt into `packages/web-acp-agent/e2e/tests/utils/auth/`:

- `pkce.ts` (verifier + S256 challenge + state)
- `callback-server.ts` (ephemeral `http.Server` on `127.0.0.1:<port>`)
- `access-request.ts` (POST `/bodhi/v1/apps/request-access` + status poll)
- `login-flow.ts` (two-phase consent + Keycloak code exchange)
- `token-exchange.ts` (`exchangeCodeForTokens`, `refreshTokens`, `revokeRefreshToken`)
- `config.ts` constants (`APP_CLIENT_ID`, `DEFAULT_AUTH_SERVER_URL`, `DEFAULT_CALLBACK_PORT`, scope helpers)
- `debug.ts` (`fetchWithDiagnostics`, error-chain formatting)

Why copy not import: see "Hard rule" below. Adapt freely — strip
the CLI-specific renderer wiring; we just need the headless flow.

### Reuse via API (allowed imports only)

- `@bodhiapp/web-acp-agent` (its own package barrel) — `startAgent`, `createInMemoryDuplex`, `BodhiProvider`, `ZenfsVolumeRegistry`, all `BODHI_*` constants, types.
- `@bodhiapp/web-acp-agent/test-utils` — `buildSeedInit`, `createInMemoryPreferenceStore`, `createInMemorySessionStore` (for fully ephemeral specs).
- `@agentclientprotocol/sdk` — `ClientSideConnection`, `ndJsonStream`, request/response types.
- `playwright` (devDep) — driving the OAuth UI inside global-setup.
- `@bodhiapp/app-bindings` — direct NAPI consumption to boot BodhiApp (matches what `web-acp/e2e` `BodhiServerManager` uses internally).

### Hard rule — `web-acp-agent` is the upstream package

`packages/web-acp-agent/` MUST NOT depend on any downstream
workspace package (`packages/web-acp/`, `packages/cli-acp-client/`,
`packages/tutorial-cli-client/`, `packages/ws-acp-client/`, …) at
**any** level — `dependencies`, `devDependencies`, `peerDependencies`.
The agent is the future-extracted npm library and must stay
above the rest of the monorepo. CI grep guard:

```
grep -r "@bodhiapp/web-acp\|@bodhiapp/cli-acp-client\|@bodhiapp/tutorial-cli-client\|@bodhiapp/ws-acp-client\|@bodhiapp/acp-ui" packages/web-acp-agent/
```

must return zero. If reuse from a downstream package is
tempting, the answer is always **copy + adapt**, never import.

## Key files — what each does

### `tests/global-setup.ts` (vitest globalSetup hook)

1. Load `.env.test`; assert required vars (`BODHIAPP_CLIENT_ID`, `BODHIAPP_USERNAME`, `BODHIAPP_PASSWORD`, `BODHIAPP_AUTH_URL`, `BODHIAPP_AUTH_REALM`, plus an LLM key).
2. Pick free ports for BodhiApp + the OAuth callback (use the same default 51135 / 5173 split as `cli-acp-client/e2e`). Skip if a previous run left a leak — fail loud, don't auto-kill.
3. Spawn `BodhiServerManager` (copied utility); wait for ready.
4. Drive OAuth via `tests/utils/token-acquire.ts`:
   - Launch headless Chromium via `playwright`.
   - Build a `BrowserOpener` adapter that drives `auth-driver.ts` against each URL the flow opens.
   - Call `runLoginFlow(...)` from the **local copy** at `tests/utils/auth/login-flow.ts`. The function handles the callback server + token exchange itself; we only inject the browser-side clicks.
   - Capture `{ accessToken, refreshToken, expiresAt }`.
   - Close Chromium.
5. Use the access token to call BodhiApp's admin API directly (no UI) and register one OpenAI model (matching what `web-acp/e2e/global-setup.ts` does via `ApiModelsPage`, but via fetch to keep this Playwright-free).
6. Write `.test-state.json` with `{ baseUrl, accessToken, refreshToken, expiresAt, modelId }`.
7. Return a teardown that stops `BodhiServerManager`.

Token-refresh strategy: if a spec finds the access token within 30 s
of expiry, it can call `refreshTokens(...)` (the local copy under
`tests/utils/auth/token-exchange.ts`). For the first cut we keep
token TTL generous and skip mid-suite refresh; flag as a follow-up
if it becomes flaky.

### `helpers/embed-agent.ts`

```ts
export interface EmbeddedAgent {
  client: ClientSideConnection;
  notifications: NotificationBuffer;
  dispose: () => Promise<void>;
}

export interface EmbedAgentOptions {
  token: string;
  baseUrl: string;
  modelId?: string;
  volumes?: VolumeInit[];      // pre-mounted before initialize
  isDev?: boolean;             // gates forceToolCall configOption
}

export async function embedAgent(opts: EmbedAgentOptions): Promise<EmbeddedAgent>;
```

Internals:

- `createInMemoryDuplex()` for the byte-stream pair.
- `new BodhiProvider()`, then `setAuthToken({ provider: 'bodhi', baseUrl, token })`.
- `new ZenfsVolumeRegistry()`, mount any provided seeds (using
  unique mount names — see `seed-volumes.ts`).
- `createInMemorySessionStore()` + `createInMemoryPreferenceStore()`
  (both from `test-utils`).
- `startAgent({ transport: duplex.agent, provider, registry, sessions, preferences, isDev })` → handle.
- Wrap `duplex.client` with `ndJsonStream`; build a `Client`-shaped
  handler that buffers `sessionUpdate` + extension notifications;
  hand to `new ClientSideConnection(handler, stream)`.
- Inline a one-line cancelled-outcome stub for `requestPermission`
  to satisfy the ACP `Client` interface (matches both existing
  hosts).
- Issue `client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })`.
- Return `{ client, notifications, dispose }` where `dispose`
  closes the duplex and `await`s `handle.dispose()`.

This file is the single seam the specs reach through. Mirrors
`tutorial-cli-client/src/agent/embed.ts:createEmbeddedAgent` line
for line, adapted for vitest's no-CLI context.

### `helpers/notification-buffer.ts`

Buffers `session/update` notifications and `_bodhi/*` extension
notifications keyed by `sessionId`. Specs await predicates like
`await buf.waitForUpdate(sid, u => u.update.kind === 'agent_message_chunk' && u.update.text.includes(...))`.
Carries the same role as `streamingReducer` in the browser host —
without the React.

### Per-test isolation with ZenFS

ZenFS keeps a **process-global** mount table
(`packages/web-acp-agent/src/agent/volume-registry.ts:62`
`zenfsConfiguredGlobally`). vitest's default `pool: 'forks'` already
isolates tests across files (separate processes), but **within a
spec file** parallel `it()`s share the table.

Mitigation: `helpers/seed-volumes.ts:uniqueMount(name)` returns
`${name}-${counter++}`. Specs use `beforeEach` to mount fresh,
`afterEach` to call `registry.unmountAll()`. Documented in the
helper.

If a future spec file ever runs `it.concurrent` over volume-mounted
flows, switch to a per-test embedded-agent factory instead of
sharing one. For the first cut, both spec files create a fresh
agent in `beforeEach` so this isn't a hot path.

## Test plan — first cut

### `chat.spec.ts` (mirrors `web-acp/e2e/chat.spec.ts`)

| # | Test | Asserts |
|---|---|---|
| 1 | `initialize` → response carries `agentCapabilities` with `loadSession: true`, `sessionCapabilities.list/close`, `mcpCapabilities.http: true`; `agentInfo.name === '@bodhiapp/web-acp-agent'` | `acp/handlers/initialize.ts` advertises the right shape. |
| 2 | `authenticate({ methodId: BODHI_AUTH_METHOD_ID, _meta: { token, baseUrl } })` → response `_meta.bodhi.providerInfo` contains a connectivity-probe result (server ping) | `BodhiProvider.setAuthToken` runs the probe and surfaces it on the auth response. |
| 3 | `newSession({ mcpServers: [], cwd: '/' })` → `sessionId` returned, `models` array non-empty, `configOptions` includes `_bodhi/features/bashEnabled` | `handlers/session-crud.ts` returns the model catalog + per-session config registry. |
| 4 | `prompt(sessionId, 'reply with the single word: pong')` → notifications contain a streamed `agent_message_chunk` whose accumulated text contains `pong`; final `PromptResponse.stopReason === 'end_turn'` | full streamed turn round-trip. |
| 5 | issue `prompt(...)` with a long-running prompt; immediately `cancel(sessionId)` → `PromptResponse.stopReason === 'cancelled'`; subsequent `prompt` on same session works | `cancel` + post-cancel reuse. |

### `sessions.spec.ts` (mirrors `web-acp/e2e/sessions.spec.ts`)

| # | Test | Asserts |
|---|---|---|
| 1 | `newSession` × 3, then `listSessions({ cursor: undefined })` → response lists all 3 sessions newest-first, `nextCursor` is `null` (or absent) when fewer than the page size | `Agent.listSessions` cursor pagination shape (base64 page=N&per_page=10&...). |
| 2 | newSession + 1 prompt round-trip + `loadSession(sessionId)` → response replays prompt + assistant message via notifications; `LoadSessionResponse._meta.bodhi.{messages, mcpToggles, title}` matches the expected `BodhiLoadSessionMeta` shape | replay walker correctness. |
| 3 | `newSession` → `closeSession(sessionId)` → subsequent `prompt(sessionId, ...)` rejects with a JSON-RPC error (session no longer in the runtime's in-memory map; row stays in store) | in-memory cleanup vs persistent row. |
| 4 | `newSession` + run 1 prompt; call `_bodhi/sessions/delete` extension method; verify `listSessions` no longer includes it | `acp/engine/ext-methods/sessions-delete.ts` removes the row + entries. |
| 5 | `listSessions` with seeded > 10 rows; iterate cursor; assert all rows surface exactly once | cursor pagination over a real page boundary. |

Each test creates its own embedded agent in `beforeEach`, with a
fresh in-memory `SessionStore` so test 5 can pre-seed cleanly via
the store handle (helper exposes the underlying store for
arrange-only cases).

## Out of scope (first cut)

These are deliberate follow-ups, not omissions:

- Built-in commands (`/help`, `/version`, `/info`, `/copy`, `/mcp`)
  via the `_meta.bodhi.builtin` envelope.
- MCP integration (would require copying `EverythingMcpManager`
  too).
- Tool round-trip with seeded volumes + `bash` tool + `forceToolCall`
  feature toggle.
- Extensions install/list/reload over `_bodhi/extensions/*` +
  mock npm registry.
- Token mid-run refresh on long suites.

Each becomes its own `*.spec.ts` (file-level isolation already in
place) once the core slice is green.

## Verification

End-to-end:

```bash
cd packages/web-acp-agent
cp e2e/.env.test.example e2e/.env.test  # fill values from 1Password / shared dev
npm run test:e2e                        # vitest with vitest.config.e2e.ts
```

Acceptance:

- `npm run test:e2e` from `packages/web-acp-agent/` exits 0 on a
  clean checkout with valid `.env.test`.
- Both spec files run; `chat.spec.ts` exercises a real OpenAI
  round-trip.
- `npm test` from `packages/web-acp-agent/` (unit tests) does **not**
  pick up `e2e/**/*.spec.ts` — verified by adding a deliberate
  failing spec in e2e/ and confirming `npm test` still passes.
- `npm run check` and root `npm run check` still pass.
- `grep -r "@bodhiapp/web-acp\|@bodhiapp/cli-acp-client\|@bodhiapp/tutorial-cli-client\|@bodhiapp/ws-acp-client\|@bodhiapp/acp-ui" packages/web-acp-agent/` returns zero (no downstream workspace imports anywhere — runtime, dev, or e2e).
- `packages/web-acp-agent/e2e/bin/` exists as a real directory (copy of stubs), not a symlink — `test -L packages/web-acp-agent/e2e/bin` is false.

Smoke checks during dev:

- After global-setup completes, `.test-state.json` exists with
  non-empty `accessToken` and `baseUrl`.
- `helpers/embed-agent.ts` can be invoked from a one-off Node
  script (drop a `repl.ts` next to it during dev) and round-trip a
  prompt.

## Spec updates required (per repo `CLAUDE.md § Functional specs`)

This work changes test infrastructure, not source under
`packages/web-acp-agent/src/`. No topic-file under
`ai-docs/web-acp/specs/web-acp-agent/` needs updating. We **do**
add a one-paragraph "Headless ACP-protocol e2e" section to
`packages/web-acp-agent/CLAUDE.md` so newcomers know to run it
when touching the wire surface.

If implementation discovers a missing public export (e.g., a
constant the spec needs that lives only in an internal module),
that landed export goes through the normal change procedure for
the affected topic file (`acp.md`, `sessions.md`, etc.).

## Open items to resolve at implementation time

1. **`PROTOCOL_VERSION`**: confirm the constant is exported by
   `@agentclientprotocol/sdk` at the version pinned in
   `packages/web-acp-agent/package.json` (0.21.0). If not,
   hardcode `1` matching `acp/handlers/initialize.ts`.
2. **Concurrent `it()` inside one file**: keep tests serial within
   a file for the first cut. Revisit if cold-start cost dominates.
3. **Admin API for model registration**: confirm BodhiApp exposes
   `POST /bodhi/v1/api-models` (or similar) with the JWT we
   captured. If admin-only paths require an extra role beyond what
   the access-request grants, fall back to copying the
   `ApiModelsPage` UI flow under Playwright in global-setup
   (still no Playwright in specs).
