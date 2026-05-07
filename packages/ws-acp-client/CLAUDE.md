# ws-acp-client — agent guide

See repo `CLAUDE.md` for project-wide context (vision, ACP contract, steering
docs, dev commands, hard constraints). This file layers on package-specific
constraints only.

## Mission

`packages/ws-acp-client/` is the **WebSocket backend host** for
`@bodhiapp/web-acp-agent`. It embeds the agent in a Node.js process,
exposes it over `ws://`, and is the backend counterpart to the `acp-ui`
Vue frontend. Sessions are persisted to SQLite via Drizzle ORM.

It is **not** a browser package. It is **not** a UI package. It is a Node.js
server that hosts the agent and bridges it to WebSocket clients.

## Hard constraints

- **No browser-only deps at runtime.** `@zenfs/dom`, `idb-keyval`, `dexie`,
  `FileSystemDirectoryHandle`, `window.*` — zero.
- **No imports from `packages/web-acp/`, `packages/tutorial-cli-client/`.**
  Cross-host contamination is a bug.
- **WebSocket transport boundary is clean.** The framing layer imports no
  business logic. Business logic imports no WebSocket primitives.
- **SQLite/Drizzle are the only DB-aware code.** The agent runtime
  (`@bodhiapp/web-acp-agent`) is unaware of the storage backend.
- **Tokens never appear in logs.** Credentials are never persisted
  plaintext without an explicit decision entry.

## Public surface

- CLI binary: `ws-acp-client` (bin entry `src/cli.ts`).
- `src/index.ts` re-exports for tests. Not a published library yet.

No living spec for this package. The package CLAUDE.md is the reference.
Add `ai-docs/web-acp/specs/ws-acp-client/` when the surface stabilises.

## Where to look

- `ai-docs/web-acp/specs/web-acp-agent/startup-sequence.md` — the
  host-neutral ACP boot sequence; the portion below the transport boundary
  applies here verbatim.
- `packages/tutorial-cli-client/` — sibling Node host, simpler (in-memory
  stores, passthrough FS). Use as a model for any new host capability.

## Dev commands

Run from `packages/ws-acp-client/`:

```bash
npm run dev       # tsx src/cli.ts
npm run check     # tsc --noEmit
npm run test:e2e  # Playwright (requires BodhiApp and real LLM)
```

(No `npm run lint` yet — see `package.json`.)

## Footguns

- **WebSocket transport must frame ACP JSON-RPC 2.0** the same way all
  other transports do (`ndJsonStream` framing). A bespoke envelope breaks
  ACP compliance.
- **ACP SDK version.** Pinned to `0.21.0` in `web-acp-agent`; verify
  this package's dep matches before introducing `unstable_*` surface.
- **Drizzle migrations** must be run before the server accepts connections.
  See `drizzle.config.ts`.

## When NOT to add code here

- Browser UI → `acp-ui/`.
- Agent-runtime logic → `packages/web-acp-agent/`.
- ACP wire types → `packages/web-acp-agent/src/wire/`.
