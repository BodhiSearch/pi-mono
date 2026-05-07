# web-acp — agent guide

See repo `CLAUDE.md` for project-wide context (vision, ACP contract, steering
docs, dev commands, hard constraints). This file layers on package-specific
constraints only.

## Mission

`packages/web-acp/` is the **browser host** for `@bodhiapp/web-acp-agent`.
It is a Vite + React + Web Worker bundle: the reference application that
wires the agent in a worker, mounts FSA volumes, persists state to
IndexedDB/Dexie, and renders the chat/tools/volumes/MCP/extensions UI.

It is the future `@bodhiapp/bodhi-web-acp` library extraction target (M11).
Until extraction, it is a reference app — not a published library.

It is **not** an agent. It does not implement the ACP turn loop, session
lifecycle, tool execution, or MCP client. Those live in `web-acp-agent`.

## Hard constraints

- **Never import from `packages/web-agent/`, `packages/coding-agent/`,
  `packages/cli-acp-client/`, `packages/ws-acp-client/`, or
  `packages/tutorial-cli-client/`.** CI grep guards enforce this.
  `grep -r "packages/web-agent\|packages/coding-agent" packages/web-acp/src/`
  must return zero.
- **Only public barrel imports from `web-acp-agent`.** No
  `../../web-acp-agent/src/internal/path` imports. Test files may
  additionally import `@bodhiapp/web-acp-agent/test-utils`.
- **Storage is IndexedDB, not OPFS.** Dexie adapters in
  `runtime/storage-dexie/`. OPFS doesn't serialise writes across tabs.
- **One worker per tab.** `acp/runtime.ts:ensureRuntime` is the singleton
  guard. StrictMode double-mount and HMR re-entry must not spawn a
  second worker.
- **Test seams are `data-testid` + `data-test-state`.** No
  `page.waitForTimeout`. No `page.evaluate` reaching into ZenFS,
  transport, or ACP client internals.

## Public surface

None yet — this is a reference app. The future host-runtime library boundary
(settled at M11) is the `acp/` + `runtime/` + `agent/agent-worker.ts`
subtree.

## Where to look

Living specs (update in the same commit as any code change):

- `ai-docs/web-acp/specs/web-acp-client/index.md` — folder layout +
  navigation table.
- Per-topic files: `transport.md`, `acp.md`, `hooks.md`,
  `storage-dexie.md`, `volumes.md`, `mcp.md`, `commands.md`,
  `features.md`, `startup-sequence.md`.

Steering (durable — don't contradict):

- `ai-docs/web-acp/steering/02-architecture.md` — layer cake, transport
  boundary, ZenFS layout.
- `ai-docs/web-acp/steering/04-principles.md` — the rules that survive plans.

## Dev commands

Run from `packages/web-acp/`:

```bash
npm run dev       # Vite dev server on :5173
npm run check     # ESLint + tsc -b
npm test          # vitest run (unit)
npm run test:e2e  # Playwright — self-contained (boots BodhiApp, real LLM)
```

**Run `test:e2e` once per feature**, not after each intermediate edit.
Requires `e2e/.env.test` with LLM API key and Bodhi admin credentials.

## Footguns

- **FSA handles aren't JSON-serialisable.** The volume-control sidechannel
  uses raw `postMessage` on the worker global scope (not ACP). Documented
  in `specs/web-acp-client/transport.md`.
- **StrictMode double-mount.** `ensureRuntime` in `acp/runtime.ts` must
  be module-scoped. An `useEffect`-scoped singleton spawns a second worker
  under StrictMode.
- **Real-LLM e2e.** `e2e/.env.test` needs credentials. Tests exercise
  actual LLM traffic — don't mock the LLM in Playwright specs.
- **Authoritative typecheck is `tsc -b`, not `tsc --noEmit`.**

## When NOT to add code here

- Agent runtime logic (session lifecycle, tool execution, prompt turn,
  MCP client) → `packages/web-acp-agent/`.
- ACP wire types and constants → `packages/web-acp-agent/src/wire/`.
- WebSocket or HTTP transport → `packages/ws-acp-client/`.
- Generic ACP client UI with no React → `acp-ui/`.
