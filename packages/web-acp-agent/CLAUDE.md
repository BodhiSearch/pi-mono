# web-acp-agent — agent guide

See repo `CLAUDE.md` for project-wide context (vision, ACP contract, steering
docs, dev commands, hard constraints). This file layers on package-specific
constraints only.

## Mission

`@bodhiapp/web-acp-agent` is the **transport-agnostic ACP agent runtime**.
It is future-publishable as a standalone npm package. It owns the full agent
loop: ACP wire shim, engine (session lifecycle, prompt turn, builtin dispatch),
pi-ai/pi-agent-core wrapper, MCP client, bash tool + ZenFS volumes, extension
runtime, vault/builtin command loaders, and all host-pluggable storage
interfaces.

It is **not** a host. It does not render UI, spawn processes, open ports,
or implement auth flows. Every host-specific concern is a constructor argument.

## Hard constraints

- **No browser-only deps at runtime.** `@zenfs/dom`, `idb-keyval`, `dexie`,
  `MessagePort`, `Worker`, `FileSystemDirectoryHandle`, `navigator.storage`,
  `window.*` — zero. Grep-verified in CI.
- **No node-only deps at runtime.** `fs`, `child_process`, `path`,
  `node:*` — zero. The package runs in a Web Worker today.
- **No React.** UI is the host's job.
- **ACP is the wire.** Every cross-boundary message is a JSON-RPC 2.0
  request, response, or notification defined in `wire/index.ts` constants.
  No bespoke side-channel except the volume-control rawPostMessage (documented
  as a host-level exception for FSA handle transfer).
- **No imports from sibling packages.** `web-acp`, `ws-acp-client`,
  `tutorial-cli-client`, `web-agent`, `coding-agent` are never imported.
  This package is upstream-only.
- **Storage interfaces stay host-pluggable.** `SessionStore`,
  `PreferenceStore`, `VolumeRegistry` are interfaces only; Dexie / SQLite /
  FSA concrete types never appear inside `src/`.
- **Structured-clone safe.** Every payload crossing the transport is plain
  JSON. No closures, class instances with methods, or non-cloneable values.

## Public surface

- **Production barrel:** `src/index.ts` — the only import path production
  hosts use. New public symbols must appear here AND in
  `ai-docs/web-acp/specs/web-acp-agent/index.md` § "Public surface".
- **Test-only barrel:** `src/test-utils/index.ts` — `AcpAgentAdapter`,
  `assembleServices`, `InlineAgent`, `McpConnectionPool`, seed helpers, etc.
  Production code never imports from here.
- **Anything else is internal.** If a host reaches into `src/acp/engine/`
  or `src/agent/extensions/runner.ts` directly, that is a bug.

## Where to look

Living specs (source of truth — read before changing code):

- `ai-docs/web-acp/specs/web-acp-agent/index.md` — folder layout, global
  invariants, navigation table. **Update in the same commit** as any code
  change; this is enforced by the change-procedure rule.
- Per-topic files: `acp.md`, `agent.md`, `extensions.md`, `volumes.md`,
  `tools.md`, `commands.md`, `sessions.md`, `features.md`, `mcp.md`,
  `startup-sequence.md`.

Reference code (read-only, do not import):

- `packages/coding-agent/` — session shape, tool-operations pattern,
  extension hook signatures. Copy patterns, re-derive types.
- `svkozak/pi-acp` at `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/src/acp/` — prior-art ACP agent in TS (Node/stdio). `agent.ts`, `session.ts`, `slash-commands.ts` are instructive.

## Dev commands

Run from `packages/web-acp-agent/`:

```bash
npm run check     # ESLint + tsc -b (authoritative typecheck)
npm test          # vitest run (unit tests)
```

No e2e at this layer — the agent is exercised via host e2e suites in
`packages/web-acp/`, `packages/ws-acp-client/`,
`packages/tutorial-cli-client/`.

## Footguns

- **ACP SDK pinned at `0.21.0`.** `unstable_*` methods reshape between
  minor versions. Check `node_modules/@agentclientprotocol/sdk` before
  reaching for an `unstable_` method.
- **Data-URL extension loader, not blob URL.** Data URLs work across
  browser/worker/Node test environments; blob URLs don't. See
  `agent/extensions/loader.ts`.
- **`_bodhi/*` namespace required for extension methods.** See
  `steering/04-principles.md` § 15. Constants go in `wire/index.ts`,
  not inlined at call sites.
- **`tsc -b` is authoritative, not `tsc --noEmit`.** This package uses
  project references. `npm run typecheck` calls `tsc -b`.
- **`@bodhiapp/bodhi-js-react` is `devDependencies`.** The agent uses
  `import type` only against `bodhi-js-react/api` for type-shape lookup.
  It must never become a runtime dep (pulls React + browser code).

## When NOT to add code here

- UI rendering, React components, Pinia stores → `packages/web-acp/` or `acp-ui/`.
- Transport bytes, MessagePort wiring, WebSocket framing → host packages.
- FS backend implementations (FSA, SQLite, Passthrough) → host packages.
- Auth flows, token refresh, OAuth → host packages.
- Test-only helpers reused only within this package → `src/test-utils/`.
