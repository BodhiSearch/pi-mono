# tutorial-cli-client — agent guide

See repo `CLAUDE.md` for project-wide context (vision, ACP contract, steering
docs, dev commands, hard constraints). This file layers on package-specific
constraints only.

## Mission

`packages/tutorial-cli-client/` is a **hands-on tutorial CLI** that
demonstrates how to embed `@bodhiapp/web-acp-agent` in a minimal Node TTY
host. It is the active replacement for the now-frozen `packages/cli-acp-client/`
reference.

Primary purpose: **legibility**. Someone building a custom agent host should
be able to read this package and understand the minimal wiring needed.
Secondary purpose: a second e2e seam proving the agent is truly host-portable.

It is **not** a feature-parity target with `packages/web-acp/`. It does not
need every UI feature — it needs to be clear.

## Hard constraints

- **Public barrel only.** Imports from `@bodhiapp/web-acp-agent` go
  through the public barrel. No `../../web-acp-agent/src/internal/...` paths.
  Test files may additionally import `@bodhiapp/web-acp-agent/test-utils`.
- **No browser-only deps.** `@zenfs/dom`, `idb-keyval`, `dexie`,
  `FileSystemDirectoryHandle`, `window.*` — zero.
- **Tutorial-grade clarity.** Every non-obvious line should be
  self-explanatory or carry a short WHY-comment. If a reader would need to
  consult the spec to understand a code line, simplify the code.
- **No imports from `packages/web-acp/`, `packages/ws-acp-client/`.**

## Public surface

- Bin entry: `src/cli.ts`.
- `src/index.ts` re-exports for tests.

No living spec yet. The package CLAUDE.md is the reference. Once the surface
stabilises, add `ai-docs/web-acp/specs/tutorial-cli-client/`.

## Where to look

- `ai-docs/web-acp/specs/web-acp-agent/startup-sequence.md` — host-neutral
  ACP boot; the below-transport portion applies here verbatim.
- `ai-docs/cli-acp-client/guide/` — carry-over docs from the frozen
  predecessor. Useful for auth flow reference until this package gets its
  own doc folder.
- `packages/ws-acp-client/` — sibling Node host with SQLite persistence;
  compare for any new capability.

## Dev commands

Run from `packages/tutorial-cli-client/`:

```bash
npm run dev       # tsx src/cli.ts (interactive)
npm run check     # ESLint + tsc -b
npm run test:e2e  # Playwright (requires BodhiApp NAPI + real LLM via .env.test)
```

(No `npm test` vitest suite yet — unit tests to be added.)

## Footguns

- **Real BodhiApp e2e.** `e2e/.env.test` needs LLM API key + Bodhi admin
  credentials. `global-setup.ts` boots BodhiApp via
  `@bodhiapp/app-bindings`.
- **Settings persist plaintext** to `$cwd/.tutorial-cli-client/settings.json`
  (tokens included). OS keychain swap is a follow-up.
- **In-memory stores.** Session data is lost on process exit — this is
  intentional for tutorial simplicity. For persistent sessions, copy the
  Drizzle adapter from `ws-acp-client`.

## When NOT to add code here

- Browser/UI work → `packages/web-acp/` or `acp-ui/`.
- Agent runtime logic → `packages/web-acp-agent/`.
- Production WebSocket server → `packages/ws-acp-client/`.
