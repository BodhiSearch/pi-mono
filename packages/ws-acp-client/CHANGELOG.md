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
- Per-connection `BodhiProvider` + `InlineAgent` so concurrent
  WebSocket clients don't share auth tokens.
- CLI entrypoint (`src/cli.ts`) with `--port`, `--bind`, `--cwd`,
  `--dev` flags, ephemeral-port support, and a `ready: ws://…`
  stdout signal that test harnesses can scrape.
- Playwright e2e suite (`e2e/*.spec.ts`) covering Bodhi auth,
  agent init, prompt round-trip, and the multi-session + tools +
  cancel journey. The suite boots a real BodhiApp NAPI server via
  `@bodhiapp/app-bindings`, drives the acp-ui static web bundle, and
  asserts state through `data-test-state` attributes only — no
  `page.evaluate` / `localStorage` injection.
