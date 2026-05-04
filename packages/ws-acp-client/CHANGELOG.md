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
- CLI entrypoint (`src/cli.ts`) with `--port`, `--bind`, `--cwd`
  flags, ephemeral-port support, and a `ready: ws://…` stdout
  signal that test harnesses can scrape.
- Playwright e2e suite (`e2e/*.spec.ts`) covering Bodhi auth,
  agent init, prompt round-trip, and the multi-session + tools +
  cancel journey. The suite boots a real BodhiApp NAPI server via
  `@bodhiapp/app-bindings`, drives the acp-ui static web bundle, and
  asserts state through `data-test-state` attributes only — no
  `page.evaluate` / `localStorage` injection.

### Changed

- Migrated to the post-simplification `@bodhiapp/web-acp-agent`
  embed surface. The host continues to drive
  `AcpAgentAdapter` + `assembleServices` directly through
  `@bodhiapp/web-acp-agent/test-utils` because multi-connection
  hosts need to share a single `ZenfsVolumeRegistry` — ZenFS
  keeps a process-global mount table, so the simpler
  `startAgent({ volumes })` boot path (which constructs a fresh
  registry per call) collides on `/mnt/cwd`.
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
