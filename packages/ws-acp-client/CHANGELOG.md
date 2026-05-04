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
