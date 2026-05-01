# @bodhiapp/web-acp-agent

Transport-agnostic [Agent Client Protocol](https://agentclientprotocol.com/)
agent runtime, extracted from the `web-acp` reference application. The agent
package owns the worker-side ACP runtime: wire shim, engine, `pi-agent-core`
wrapper, slash commands, MCP client/pool/tool-adapter, bash tool, and volume
registry. Browser-only adapters (transport, persistence, FSA-backed volumes)
live in the host runtime that consumes this package.

## Status

Pre-release. The package extraction landed but Node/backend bootstrap support
is **out of scope** for the current pass — the interfaces are designed to allow
it later. Today the only consumer is `packages/web-acp/`.

## Public surface

```ts
import { startAcpAgent, BodhiProvider } from '@bodhiapp/web-acp-agent';
```

The single entry point:

```ts
startAcpAgent(transport, services): AgentSideConnection
```

- `transport: { readable, writable }` — a byte-stream pair.  Browser today
  wraps a `MessagePort`; future Node bootstraps wrap stdio / HTTP-SSE.
- `services` — pluggable interfaces:
  - `SessionStore` (persistence; browser ships an IndexedDB/Dexie impl)
  - `FeatureStore` (per-session feature flags)
  - `McpToggleStore` (per-session MCP server / tool toggles)
  - `VolumeRegistry` (mount-point ↔ ZenFS backend map)
  - `LlmProvider` (defaults to `BodhiProvider`)
  - plus build metadata (`buildVersion`, `acpSdkVersion`, `isDev`).

All four interfaces ship with type definitions; the agent ships zero
browser-only deps (`@zenfs/dom`, `dexie`, `idb-keyval`, `MessagePort`,
`Worker`, FSA types, DOM globals) so consumers can re-implement against any
runtime that has WHATWG streams + `crypto.randomUUID()` + `fetch`.

## Architecture pointer

See [`ai-docs/web-acp/specs/web-acp/index.md`](../../ai-docs/web-acp/specs/web-acp/index.md)
for the layering and per-module specs. Anything that lived under
`packages/web-acp/src/{acp,agent,features,mcp/toggle-store,mcp/url-canonical}`
is now here.

## Hard constraints

- Zero imports from `packages/web-agent/` or `packages/coding-agent/` (browser
  bundling + frozen-spike rules apply, see repo `CLAUDE.md`).
- No browser-only deps. The verification step in the extraction plan greps for
  `@zenfs/dom`, `dexie`, `idb-keyval`, `MessagePort`, `FileSystemDirectoryHandle`,
  `navigator.storage`, and `window.` — all must return zero.
