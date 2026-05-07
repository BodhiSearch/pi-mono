# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project focus

Active initiative: **web-acp** at `packages/web-acp/` — a browser-native agent that speaks the **Agent Client Protocol (ACP)** as its internal wire protocol. Main thread hosts the ACP client (React UI, `/vault` mount, fs/* delegation, permission prompts). Web Worker hosts the ACP agent (turn loop, LLM calls via `@mariozechner/pi-ai`, tool invocations). The transport between them frames ACP JSON-RPC 2.0 over `MessageChannel` today, and is explicitly designed to be swappable (future HTTP/SSE for remote-agent deployments).

Post-M4 phase B the agent runtime was extracted into `packages/web-acp-agent/` (`@bodhiapp/web-acp-agent`) — a transport-agnostic ACP agent with zero browser-only deps. It exposes `startAcpAgent(transport, services)` taking a byte-stream pair plus pluggable interfaces (`SessionStore`, `FeatureStore`, `McpToggleStore`, `VolumeRegistry`, `LlmProvider`). Active host runtimes:

- **`packages/web-acp/`** — browser host (Vite + React + Web Worker + Dexie/IndexedDB).
- **`packages/ws-acp-client/`** — WebSocket backend host (Node.js + SQLite/Drizzle); paired with the `acp-ui/` Vue frontend.
- **`packages/tutorial-cli-client/`** — tutorial CLI host (Node.js TTY, in-process, minimal wiring); the hands-on reference for "how do I host the agent in Node".

**Frozen hosts (reference only, do not extend):**

- **`packages/cli-acp-client/`** — the original Node TTY CLI (Claude-Code-style, pi-tui, Node-native OAuth 2.1 + PKCE). Superseded by `packages/tutorial-cli-client/` as the active CLI host. Kept as reference for the auth flow and the first transport-neutrality proof. No new features land here.
- **`packages/web-agent/`** — shipped M0–M8 and is now a frozen reference spike. See `ai-docs/web-agent/README.md` for the archive marker and the list of specific architectural drifts that motivated the pivot.

Other `pi-*` packages (`ai`, `agent`, `coding-agent`, `mom`, `tui`, `web-ui`, `pods`) are upstream libraries we consume and occasionally patch. Do not extend them unless explicitly asked.

## Hard constraints

- **`packages/web-acp/` must not import from `packages/web-agent/` or `packages/coding-agent/`.** web-agent is a frozen spike with known compromises we are moving away from; coding-agent pulls node-only deps (`fs`, `child_process`, jiti, `pi-tui`) that break browser bundling. Both are reference material — copy the pattern, re-derive the types. `grep -r "packages/web-agent\|packages/coding-agent" packages/web-acp/src/` must always return zero.
- **ACP is the wire protocol.** No bespoke RPC between client and agent. Extensions to ACP go via `_meta` / namespaced notifications first, upstream RFD second, sub-protocols as a documented last resort.
- **Transport is swappable.** The framing layer imports zero `MessagePort`/`Worker`/DOM references. Browser is today's default; HTTP/SSE is tomorrow's. A test-double transport exists by M0.b to prove the boundary.
- **Storage is IndexedDB, not OPFS.** Rationale carried from web-agent (`ai-docs/web-agent/04-principles.md` § 2).

## Steering docs (load on demand)

- @ai-docs/web-acp/steering/00-vision.md — north star
- @ai-docs/web-acp/steering/01-goals.md — capability checklist with test seams
- @ai-docs/web-acp/steering/02-architecture.md — layer cake, transport boundary, ZenFS + ACP fs/* mapping
- @ai-docs/web-acp/steering/04-principles.md
- @ai-docs/web-acp/milestones/index.md — status board with load-when hooks
- @ai-docs/web-acp/specs/web-acp-agent/index.md — transport-agnostic agent runtime spec
- @ai-docs/web-acp/specs/web-acp-client/index.md — browser host runtime spec
- @ai-docs/web-acp/specs/cli-acp-client/index.md — Node CLI host spec (frozen — matches the frozen `packages/cli-acp-client/`)

### Reference (web-agent archive)

- @ai-docs/web-agent/README.md — frozen-archive marker + what shipped + why we pivoted
- @ai-docs/web-agent/00-vision.md — original web-agent vision
- @ai-docs/web-agent/02-architecture.md — original web-agent architecture (useful for ZenFS layout + testing-seam patterns that port)
- @ai-docs/web-agent/milestones/index.md — web-agent M0–M9 status board
- @ai-docs/specs/worker-agent/index.md — technical specs for the web-agent worker-agent library; crib sheet for session shape, tool operations, extension hook signatures

## Dev commands

Repo root:

```bash
npm install                 # install all workspaces
npm run build               # build packages in dependency order
npm run check               # biome + tsgo + browser-smoke + web-ui + web-agent (web-acp to be added at M0)
npm test                    # vitest across workspaces --if-present
```

`packages/web-acp/` (active):

```bash
npm run dev                 # vite dev server
npm run build               # tsc -b && vite build
npm test                    # vitest (unit)
npm run test:e2e            # Playwright — real LLM via .env.test, self-contained
npm run check               # lint + typecheck
```

`npm run test:e2e` is **self-contained** — it does not require any external
service to be running. The Playwright `globalSetup` in
`packages/web-acp/e2e/tests/global-setup.ts` boots a fresh BodhiApp server,
seeds Keycloak realms/users, and registers any MCP servers the suite needs.
The Playwright `webServer` block boots Vite at `localhost:5173` for the run.
Credentials (LLM API keys, Bodhi admin) live in `packages/web-acp/e2e/.env.test`.

**Run e2e once per task, not per change.** When changes under
`packages/web-acp/` or `packages/web-acp-agent/` are complete (all
intended code edits in, unit tests + `npm run check` green), run
`npm run test:e2e` from `packages/web-acp/` yourself before reporting
the task done. Do not ask the user to run it. Unit tests (`npm test`)
and `npm run check` are necessary but not sufficient — the
agent + transport + IndexedDB + LLM round-trip is only exercised
end-to-end. Treat any new e2e regression as a blocker.

For multi-step refactors, run e2e at the end of the work, not after
every intermediate edit. Re-run it after any fix that follows from
e2e feedback.

`packages/ws-acp-client/` (active — WebSocket backend host):

```bash
npm run dev                 # tsx src/cli.ts
npm run check               # tsc --noEmit
npm run test:e2e            # Playwright + real BodhiApp NAPI + real LLM
```

`packages/tutorial-cli-client/` (active — tutorial CLI host):

```bash
npm run dev                 # tsx src/cli.ts (interactive)
npm run check               # ESLint + tsc -b
npm run test:e2e            # Playwright + real BodhiApp NAPI + real LLM
```

`packages/cli-acp-client/` (frozen — reference only, do not extend):

No new work here. Consult for the OAuth 2.1 + PKCE flow, pi-tui REPL
wiring, and the first transport-neutrality proof. See entry in "Frozen hosts"
above.

`packages/web-agent/` (frozen — reference only, do not extend):

```bash
npm run dev                 # vite dev server on :5173
npm run build               # tsc -b && vite build
npm test                    # vitest (unit)
npm run test:e2e            # Playwright — requires Bodhi server via global-setup
npm run check               # lint + typecheck (uses tsc -b)
```

## Footguns

- **Authoritative typecheck is `tsc -b`, not `tsc --noEmit`** in packages using project references. web-agent's `packages/web-agent/` is one such; verify for `packages/web-acp/` at M0.
- **Do not run `npm run build` in `packages/ai`** unless you want to regenerate `src/models.generated.ts` from live upstream APIs — it can break existing tests when upstream removes a model. Use `npx tsgo -p tsconfig.build.json` for a TS-only rebuild.

## Reference projects (read-only, not dependencies)

- **`agentclientprotocol/agent-client-protocol`** at `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/` — the Agent Client Protocol itself. `schema/schema.json` is ground truth for wire shapes; `docs/protocol/` is the conceptual model; `src/` is the reference TS implementation. ACP library dependency choice (consume vs vendor vs hand-roll) settled at M0.
- **`svkozak/pi-acp`** at `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/` — the closest existing "ACP agent in TypeScript" (Node/stdio, fronts `coding-agent`). Prior art, not a dependency. `src/acp/agent.ts`, `session.ts`, `session-store.ts`, `slash-commands.ts` are the most instructive files; the stdio plumbing does not port.
- **`bodhiapps/zenfs-browser`** — ZenFS mount lifecycle, FSA handle persistence, dev-seed testing pattern. Used by web-agent; pattern carries to web-acp.
- **`packages/coding-agent`** — architectural reference for session shape, RPC schema, extension hooks, tool "operations" pattern. Copy patterns, **do not import** (it pulls node-only deps that break browser bundling).

## Code review

Use the `/review` slash command to run a structured review of a squashed
feature commit before treating it as done:

```bash
/review             # Review HEAD (default — squash first, then review)
/review HEAD~3..HEAD  # Review a range
/review <sha>       # Review a specific commit
```

Reports land in `ai-docs/web-acp/reviews/<ref>/`. The command classifies
files by layer, loads the relevant CLAUDE.md + spec context per layer,
launches parallel Explore agents, and produces a per-layer findings report
+ a consolidated index with a suggested fix order. See
`.claude/commands/review.md` for the full checklist.

## AGENTS.md

See `AGENTS.md` for development rules (conversational style, code quality, command policy, PR workflow, changelog, git safety). Those rules apply unchanged to `packages/web-acp/` work.
