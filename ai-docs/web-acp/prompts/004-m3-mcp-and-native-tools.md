# web-acp — 004 — M3 MCP

Drive [`../milestones/m3-mcp-and-native-tools.md`](../milestones/m3-mcp-and-native-tools.md)
to completion. M2 shipped the agent-owned FS and a single `bash`
tool; M3 adds MCP servers over Streamable HTTP as additional
worker-side tool sources.

## How to use this prompt

1. Read **Read before planning** in full, then draft a phased
   plan at `ai-docs/web-acp/plans/m3-mcp.md`. One phase per
   sub-milestone, one commit per phase, each phase gated
   independently. Do not start implementing before the plan is
   reviewed.
2. Mark to-dos `in_progress` as you work (one at a time). Don't
   stop until exit criteria are ticked.
3. Use `AskUserQuestion` only when a decision changes the plan's
   shape. Cosmetic choices: pick and move on.

## Decisions (do not re-ask)

1. **Agent is the MCP client.** Worker owns connections; main
   thread renders settings and composes the `mcpServers` arg.
2. **Streamable HTTP only.** Stdio and SSE are out.
3. **ACP-canonical wire.** `mcpServers: McpServer[]` on
   `session/new` and `session/load` (both already required by
   `agent-client-protocol/schema/schema.json`).
4. **Tool namespace: `<serverName>__<toolName>`** (double
   underscore).
5. **Server list persists on main thread** in `idb-keyval`
   (same pattern as `vault/fsa-handle-store.ts`). Worker
   receives servers per session; it does not persist a list.
6. **BodhiApp is the MCP proxy; JWT is the credential.** The
   app-wide list is the set of MCP instances configured in
   BodhiApp and approved by the user on the access-request
   page (`Header.tsx:27` already wires
   `LoginOptionsBuilder.addMcpServer(url)`). `McpServerHttp`
   entries target BodhiApp's proxy URL (keyed by instance
   slug) with `Bearer <jwt>`, not the upstream URL.
7. **Connection pool in the worker, keyed by proxy URL,
   refcounted across sessions.** Tear down when refcount hits
   zero.
8. **Per-session toggles are per-server (default) + per-tool
   (override).** Per-server off omits the server from the
   composed `mcpServers` arg. Per-tool off filters the tool
   post-`tools/list`, pre-registration. Persist with the
   session record; rehydrate via `bodhi/getSession`.
9. **`bodhi/getSession` composes reload.** Client reads
   toggles → filters app-wide list → passes composed
   `mcpServers` to `session/load`. Same shape as M1 model
   rehydration.
10. **No permission prompts in M3.** MCP tools run as-is, same
    as `bash`. The permission bridge stays on
    [`../milestones/deferred.md`](../milestones/deferred.md).

## Open design decision for Phase A planning

**Where do MCP toggles live in the session record?** The
existing `features` table validates against static
`FEATURE_DEFAULTS` — dynamic server/tool names don't fit. Pick
one:

- **A** — relax `features` to allow namespaced dynamic keys
  (`mcp.server.<name>`, `mcp.tool.<server>.<name>`). Single
  storage shape, weaker validation.
- **B (recommended)** — new structured `mcpToggles` slot on the
  session row (`{ servers: Record<string, boolean>, tools:
  Record<string, Record<string, boolean>> }`). Dexie v3
  migration. `bodhi/getSession` returns `mcpToggles`. Keeps
  `features` clean.

Raise via `AskUserQuestion` only if you want confirmation;
otherwise pick B.

## Read before planning

### In this repo

1. [`../steering/`](../steering/) — principle 2 (ACP is the
   wire), 7 (testable state), 14 (agent owns tools), 15
   (`_bodhi/*` naming).
2. [`../specs/web-acp/`](../specs/web-acp/) —
   [`acp.md`](../specs/web-acp/acp.md),
   [`agent.md`](../specs/web-acp/agent.md),
   [`tools.md`](../specs/web-acp/tools.md),
   [`features.md`](../specs/web-acp/features.md),
   [`sessions.md`](../specs/web-acp/sessions.md).
3. [`../milestones/m3-mcp-and-native-tools.md`](../milestones/m3-mcp-and-native-tools.md)
   — rename to `m3-mcp.md` (update the index board).
4. [`../milestones/m2-tools.md`](../milestones/m2-tools.md) —
   cadence to mirror.
5. [`../milestones/deferred.md`](../milestones/deferred.md) —
   permission bridge stays; add a parking-lot entry for
   provider-native tools.
6. `packages/web-acp/src/acp/client.ts` — the two call sites
   (`newSession`, `loadSession`) currently pass `mcpServers:
   []`. Composed arg flows through here.
7. `packages/web-acp/src/acp/agent-adapter.ts` +
   `packages/web-acp/src/agent/inline-agent.ts` — tool
   registry assembly.
8. `packages/web-acp/src/agent/tools/bash-tool.ts` — the
   `AgentTool` shape MCP tools match.
9. `packages/web-acp/src/vault/fsa-handle-store.ts` — the
   `idb-keyval` pattern to copy for the server list.
10. `packages/web-acp/src/components/Header.tsx:27` — the
    existing `LoginOptionsBuilder.addMcpServer(...)` site;
    driven by the app-wide list in Phase A.

### External

11. `agent-client-protocol/schema/schema.json` —
    `McpServer`, `McpServerHttp`, `NewSessionRequest.mcpServers`,
    `LoadSessionRequest.mcpServers`.
12. `agent-client-protocol/docs/protocol/session-setup.mdx` —
    wire shape.
13. `agentclientprotocol/claude-agent-acp/src/acp-agent.ts` —
    reference thick-agent MCP client placement.
14. `https://modelcontextprotocol.io/specification` — Streamable
    HTTP + tools primitives.
15. `@modelcontextprotocol/sdk` — browser client if shipped;
    otherwise a minimal client against the spec.
16. `@modelcontextprotocol/server-everything` —
    `https://github.com/modelcontextprotocol/servers/blob/main/src/everything/docs/features.md`
    for the tool list (`echo`, `get-sum`, …).

### E2E harness

17. `packages/web-acp/e2e/tests/global-setup.ts` — Bodhi boot +
    login + model config; extends in Phase A.
18. `packages/web-acp/e2e/tests/pages/ApiModelsPage.ts` —
    page-object style to mirror.
19. `packages/web-acp/e2e/tests/pages/ChatPage.ts` — `login()`
    currently unchecks every `[data-testid^="review-mcp-toggle-"]`;
    extend with `acceptMcps` opt.
20. `packages/web-acp/e2e/bash-smoke.spec.ts` — tool-call
    assertion template (`[data-testid^="tool-call-"]`,
    `[data-teststate="completed"]`, `getAssistantText(turn)`).
21. `BodhiApp/crates/lib_bodhiserver/tests-js/pages/McpsPage.mjs`
    — port `createMcpServer` + `createMcpInstance` (public
    auth only). Skip playground + OAuth-connect.

---

## Phase A — M3.1 — MCP client + app-wide server list

### Source

- `packages/web-acp/src/mcp/` (main thread): `McpServerConfig`
  type (shape mirrors `McpServerHttp`), `idb-keyval`-backed
  store, settings UI (`data-testid="mcp-panel"`, rows
  `data-testid="mcp-server-<name>"` with
  `data-test-state="disconnected|connecting|connected|error"`).
- `packages/web-acp/src/agent/mcp/` (worker only): Streamable
  HTTP client — official `@modelcontextprotocol/sdk` browser
  client if available, else a minimal client; connection pool
  keyed by URL with per-session refcount; `tools/list`
  discovery; registration of `<serverName>__<toolName>`
  entries into the tool registry alongside `bash`.
- `packages/web-acp/src/acp/client.ts`: `newSession` composes
  the `mcpServers` array from the app-wide store. Empty list
  still allowed.
- `Header.tsx`: `LoginOptionsBuilder.addMcpServer(...)` driven
  by the app-wide list (not hardcoded).
- `initialize` response: advertise
  `agentCapabilities.mcpCapabilities.http = true`.
- Surface `data-tool-name` + raw input/output DOM mirrors on
  the tool-call bubble if M2 doesn't already expose them — see
  Phase B assertions.

### Spec

New [`../specs/web-acp/mcp.md`](../specs/web-acp/mcp.md):
app-wide storage layout, BodhiApp proxy architecture,
transport + reconnection policy, tool namespacing, connection
pooling, and how the composed `mcpServers` flows through
`session/new` / `session/load`.

### E2E harness

- `packages/web-acp/e2e/tests/utils/everything-mcp-manager.ts`
  — spawns `npx @modelcontextprotocol/server-everything
  streamableHttp` with `PORT=<fixed>`, polls until ready,
  exposes `start()` / `stop()`. `EVERYTHING_MCP_PORT` exported
  alongside `BODHI_SERVER_PORT`; added to `assertPortsFree()`.
- `@modelcontextprotocol/server-everything` added as a
  `devDependency` of `packages/web-acp` so `npx` hits the
  cache.
- `packages/web-acp/e2e/tests/pages/McpsPage.ts` — port
  `createMcpServer` + `createMcpInstance` (public auth) from
  BodhiApp's `McpsPage.mjs`. Selectors match upstream
  verbatim.
- `global-setup.ts` — after `ApiModelsPage` calls:
  1. start everything-mcp → capture URL
     (`http://localhost:51136/mcp`),
  2. `createMcpServer(url, 'everything', 'MCP everything reference (fixture)')`,
  3. `createMcpInstance('everything', 'everything', 'everything', { authConfig: 'public' })`,
  4. persist `mcpEverythingSlug` + `mcpEverythingUrl` to
     `.test-state.json`,
  5. stop the fixture in the teardown closure.
- `ChatPage.login(credentials, opts?: { acceptMcps?: string[] })`
  — default stays uncheck-all (existing specs unchanged). With
  `acceptMcps`, leave listed toggles checked and uncheck the
  rest.

### Gate

`npm run check` + vitest + full M2 e2e + new
`mcp-connect.spec.ts`:
1. `login({ acceptMcps: ['everything'] })`,
2. navigate, select a model,
3. assert the `everything` row in the MCP panel reaches
   `data-test-state="connected"` after `session/new`,
4. assert `echo` (and one sibling tool, e.g. `get-sum`) appear
   in the registered-tool surface.

No `page.waitForTimeout`; wait on `data-test-state` /
`data-teststate`. Commit:
`web-acp: M3 phase A — MCP HTTP client + app-wide server list`.

---

## Phase B — M3.2 — invocation + per-session toggles + reload

### Source

- Route tool calls by name: `bash` → just-bash; `<srv>__<tool>`
  → the matching MCP client; unknown → structured error.
- Wrap `tools/call` with a `session/cancel`-aware
  `AbortController`; emit `tool_call_update` with `rawInput`
  / `rawOutput` preserved. MCP error envelopes translate to
  `failed` status with the server's error text.
- Persist per-session toggles per the option chosen in Phase
  A planning.
- `bodhi/getSession` response extended with the toggle
  snapshot.
- `session/load` composes `mcpServers` from (app-wide list) ∩
  (server toggles). Per-tool filtering runs agent-side post
  `tools/list`.
- Session-MCP panel UI: per-server toggle + expandable
  per-tool list (`data-testid="mcp-session-server-<name>"`,
  `data-testid="mcp-session-tool-<server>-<tool>"`, each with
  `data-test-state="on|off"`).
- Vitest: registry routing; failure translation; abort
  plumbing; `composeMcpServersForSession(appWide, toggles)`.

### E2E

Each spec generates a fresh token per run
(`crypto.randomUUID().slice(0, 8).toUpperCase()`, e.g.
`WEB_ACP_M3_ECHO_<HEX>`). `features.forceToolCall = true` is
acceptable if it makes tool dispatch deterministic.

- `packages/web-acp/e2e/mcp-roundtrip.spec.ts`:
  1. `login({ acceptMcps: ['everything'] })`, select
     `FULL_MODEL_ID`.
  2. Prompt: *"Call the `echo` tool with message `<TOKEN>` and
     reply with exactly that text."*
  3. Assert tool-call bubble carries
     `data-tool-name="everything__echo"`, reaches
     `data-teststate="completed"`, its `rawInput.message`
     equals `<TOKEN>`, and its `rawOutput` contains
     `<TOKEN>`.
  4. Assert `getAssistantText(turn)` contains `<TOKEN>`
     verbatim.
- `packages/web-acp/e2e/mcp-toggles.spec.ts`:
  1. Login, create session, disable `everything` in the
     session MCP panel.
  2. Send the echo prompt (fresh token); assert no
     `everything__*` tool call.
  3. Reload, re-select the session, assert toggle still off.
  4. Re-enable, re-send, assert the tool call returns and the
     assistant echoes the new token.
  5. Per-tool override: disable `everything__get-sum` with
     `everything__echo` on; assert echo still works and sum
     is absent from the registered tools.

### Gate

`npm run check` + vitest + full previous e2e +
`mcp-roundtrip.spec.ts` + `mcp-toggles.spec.ts`. Commit:
`web-acp: M3 phase B — MCP tool invocation + per-session toggles`.

---

## Phase C — exit

- Grep audits: no `request_permission|allow_always`, no
  `_bodhi/mcp/`, no main-thread MCP-SDK imports, no hardcoded
  public MCP hosts (e.g. `mcp.exa.ai`) in `e2e/`.
- MCP SDK imports stay inside `packages/web-acp/src/agent/mcp/`.
- Finalise `m3-mcp.md` (renamed): status "shipped", decision
  log, test inventory. Milestone index board updated.
- `deferred.md` gains a parking-lot entry for provider-native
  tool passthrough.
- Write `005-<next-milestone>.md` (skeleton).
- Spec index nav includes `mcp.md`.

### Gate

`npm run check` + full web-acp e2e suite green (chat +
sessions-persist + sessions-resume + volumes + bash-smoke +
features + mcp-connect + mcp-roundtrip + mcp-toggles). Commit:
`web-acp: M3 phase C — M3 exit gate`.

---

## Hard constraints

1. Specs co-commit with code.
2. No `any`; no `@ts-ignore`; no skipped tests.
3. Main thread owns config (idb-keyval); worker owns runtime
   (connections, registered tools). Dexie / MCP SDK imports
   are worker-only; the idb-keyval server-list store is
   main-thread-only.
4. Stable ACP schema only (`schema.json`, not
   `schema.unstable.json`).
5. Prefer stock ACP over extensions. If an extension is
   unavoidable (e.g. toggle shape via option A), use the
   `_bodhi/*` prefix with constants in `acp/methods.ts`
   (principle 15).
6. No `page.waitForTimeout` in new e2e; wait on
   `data-test-state` / `data-teststate`.
7. One task in-progress at a time.
8. If a test fails, it fails — no flake budget.

## Open questions (raise only if needed)

1. **MCP SDK choice.** Check `@modelcontextprotocol/sdk` for a
   browser build at implementation time; hand-roll a minimal
   client only if none exists.
2. **Connection-pool key.** URL alone suffices unless per-session
   auth varies for the same URL; if so, key by
   `(url, auth-fingerprint)`.
3. **Toggle storage** — option A vs B (recommendation: B).

## Exit criteria

- [ ] Plan at `ai-docs/web-acp/plans/m3-mcp.md` reviewed.
- [ ] Three phase commits lande with matching spec updates.
- [ ] `npm run check` green at every commit.
- [ ] `@modelcontextprotocol/server-everything` installed as a
      devDependency; `everything-mcp-manager.ts` spawns and
      tears it down cleanly; port in `assertPortsFree()`.
- [ ] `global-setup.ts` creates the `everything` server +
      instance in BodhiApp and persists slug + URL.
- [ ] `McpsPage.ts` + extended `ChatPage.login()` landed.
- [ ] `mcp-connect.spec.ts`, `mcp-roundtrip.spec.ts`,
      `mcp-toggles.spec.ts` green alongside all pre-M3 specs.
- [ ] Milestone doc marked "shipped"; `deferred.md` carries the
      new provider-native-tools parking lot; permission-bridge
      entry untouched.
- [ ] Next prompt drafted.
- [ ] All grep audits from Phase C pass.
