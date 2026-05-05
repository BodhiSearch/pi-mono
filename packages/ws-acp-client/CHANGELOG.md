# Changelog

All notable changes to `@bodhiapp/ws-acp-client` will be documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial cut of `@bodhiapp/ws-acp-client`: a Node WebSocket host that
  exposes `@bodhiapp/web-acp-agent` over framed JSON-RPC, mounts the
  process `$cwd` as a ZenFS `PassthroughFS` volume at `/mnt/cwd`, and
  persists sessions to a single sqlite database under
  `<cwd>/.ws-acp-client/state.db` via `drizzle-orm` +
  `better-sqlite3`.
- Per-connection `BodhiProvider` so concurrent WebSocket clients
  don't share auth tokens.
- CLI entrypoint (`src/cli.ts`) with `--port`, `--bind`, `--cwd`,
  and the repeatable `--volume name=path` flag for mounting extra
  ZenFS `PassthroughFS` volumes (each appears at `/mnt/<name>` to
  the agent and is surfaced via the `_bodhi/volumes/list`
  ext-method). Supports ephemeral-port boot and a `ready: ws://…`
  stdout signal that test harnesses can scrape.
- Playwright e2e suite (`e2e/*.spec.ts`) covering the full acp-ui
  parity surface: Bodhi auth, agent init, prompt round-trip,
  multi-session lifecycle + tools + cancel, built-in slash commands
  (`/copy` / `/help` / `/version` / `/info` / `/mcp`) with muted
  bubble tagging + reload-survival, agent-driven sessions sidebar
  via cursor-paginated `Agent.unstable_listSessions`, multi-volume
  panel rendering, vault-sourced `/wiki:*` commands + prompts with
  collision precedence, ACP-native feature toggles
  (`bashEnabled` / `forceToolCall`) with reload-survival, and the
  `/mcp add|remove` re-auth loop with `_bodhi/mcp/state` -driven
  panel updates. Suite boots a real BodhiApp NAPI server via
  `@bodhiapp/app-bindings`, seeds an OpenAI API model + an
  `everything` reference MCP instance, drives the acp-ui static web
  bundle, and asserts state through `data-test-state` attributes
  only — no `page.evaluate` / `localStorage` injection.

### Changed

- Migrated to the public `startAgent({ transport, provider,
  registry, sessions, preferences })` entry point. Each accepted
  WebSocket connection passes the shared `HostState.registry`
  (a `ZenfsVolumeRegistry` with `/mnt/cwd` pre-mounted) into
  `startAgent`. Dropped every import from
  `@bodhiapp/web-acp-agent/test-utils` (`AcpAgentAdapter`,
  `assembleServices`, `createInlineAgent`, `createStreamFn`) —
  they were a workaround for `startAgent({ volumes })`
  constructing a fresh registry per call and colliding on the
  process-global ZenFS mount table. The agent-side API now takes
  a mandatory `registry` so multi-connection hosts no longer
  need the advanced surface, and the borrowed-vs-owned ambiguity
  goes away (the host always owns the registry lifecycle).
- Removed the `acpSdkVersion` server option. `startAgent`
  resolves the SDK version internally; hosts no longer need to
  thread it through.
- Collapsed the per-session `features` and `mcp_toggles` sqlite
  tables into a single `preferences` table keyed by
  `(session_id, key)`. Internal agent code reads the well-known
  keys (`feature:bashEnabled`, `feature:forceToolCall`,
  `mcp:toggles`) through typed accessors. Existing on-disk databases
  receive a v2 migration that drops the legacy tables; per-session
  toggle state resets to defaults on first load.
- Dropped the `--dev` CLI flag and the `isDev` server option. The
  `forceToolCall` feature flag is now accepted unconditionally via
  `setSessionConfigOption`; hosts gate the UI surface.
- Sessions sidebar in acp-ui is now agent-driven via
  `Agent.unstable_listSessions` (cursor-paginated). Local-KVStore
  bookkeeping of saved sessions has been retired; the agent's
  sqlite is the single source of truth and the sidebar repopulates
  on every connect. Disconnect-only logout: `auth.logout()` clears
  the bridge + sidebar (server rows are NOT deleted; they re-appear
  on the next connect).
- Requested-MCPs list (the URLs the user wants Bodhi to approve as
  MCP scopes) lives in browser-local KVStore (`mcp-requested.json`)
  on the acp-ui side, not in `ws-acp-client` sqlite. The host
  surfaces approved instances back via `_bodhi/mcp/state`
  notifications keyed by Bodhi instance slug; per-server toggles
  flow through `_bodhi/mcp/toggles/set` ext-method (browser-local).
  This matches web-acp's `requested-mcps-store.ts` per-browser
  contract.

### Notes

- **Single-tenant carve-out**: the same sqlite under
  `<cwd>/.ws-acp-client/state.db` is shared by every WebSocket
  connection, so two browsers pointing at the same host see the same
  session list, the same per-session feature toggles, and the same
  MCP toggle bitmap. `_bodhi/sessions/delete` is destructive across
  browsers. Hardening for multi-tenant deployments would require
  per-connection authentication-derived `session_id` namespacing on
  the `sessions` / `entries` / `preferences` tables; see
  `packages/web-acp-agent/TECHDEBT.md` for the migration shape.
  Not in scope for laptop deployments today.
