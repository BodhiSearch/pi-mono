# worker-agent

**Source of truth:** `packages/web-agent/src/worker-agent/`

**Status:** living document — update as part of any plan that changes the source folder.

## Purpose

`worker-agent` is a self-contained, browser-runtime coding-agent harness designed to live inside a Web Worker. It is the extraction target for a future standalone library (working name `@bodhiapp/bodhi-web-agent`): everything a host application needs to run an LLM coding agent — session state, message streaming, filesystem tools, MCP proxy tools, session persistence, context compaction, and the RPC wire protocol — is packaged here without any host-specific coupling.

Two invariants drive the design:

- **Host-agnostic.** The worker exposes a plain-data RPC API. The host spawns the Worker (or accepts the in-process fallback), forwards a `FileSystemDirectoryHandle`, services MCP tool upcalls, and rotates auth credentials. It does not observe React, Bodhi, or any concrete auth scheme, and it no longer pushes the model catalog — the worker-owned `LlmProvider` fetches it on demand.
- **Provider-agnostic.** LLM authentication **and** the model catalog are both injected through a single `LlmProvider` interface at boot. The concrete implementation (e.g. [`worker-bodhi`](../worker-bodhi/index.md)) lives outside this folder and is the only place aware of a given auth scheme or catalog endpoint.

## Navigation

Start with **[overview](#overview)** below. Then drill into the module-level specs:

| File | Scope |
| --- | --- |
| [`agent-session.md`](./agent-session.md) | The `AgentSession` wrapper over `pi-agent-core`'s `Agent`. |
| [`worker-host.md`](./worker-host.md) | `WorkerAgentHost` — the `AgentSessionHost` implementation tying everything together. |
| [`llm-provider.md`](./llm-provider.md) | `LlmProvider` / `LlmAuthCredential` / `createStreamFn` — the provider-agnostic auth + catalog surface. |
| [`rpc.md`](./rpc.md) | RPC wire protocol, `RpcClient`, `RpcServer`, `Transport`, in-process + Worker transports. |
| [`worker-boot.md`](./worker-boot.md) | Worker init protocol, main-thread `getAgentWorker`, Worker-entry `agent-worker.ts`. |
| [`sessions.md`](./sessions.md) | `SessionStore` interface, Dexie + memory stores, `SessionManager`, entry shapes, session tree. |
| [`compaction.md`](./compaction.md) | Token estimation, cut selection, summarisation, lifecycle events. |
| [`vault-tools.md`](./vault-tools.md) | Filesystem tools, ZenFS operations, vault mounting (FSA + dev seed). |
| [`mcp-proxy.md`](./mcp-proxy.md) | MCP tool descriptors + main-thread upcall protocol. |

## Overview

### Scope in

1. Agent session lifecycle — prompt, abort, reset, streaming events.
2. Model catalog routing — list/set active model by `(provider, modelId)`, resolved against `LlmProvider.getAvailableModels()` on demand. The worker does **not** cache a seeded registry.
3. Filesystem tools mounted over a ZenFS backend: `read`, `write`, `edit`, `ls`, `glob`, `grep`.
4. Vault mounting — FSA directory handle or in-memory seed, surfaced to the main thread over a Port channel.
5. MCP tool proxying — descriptors registered in the worker, execution upcalls back to the main thread.
6. Session persistence — Dexie (IndexedDB) store with an in-memory fallback; append-only DAG of typed entries.
7. Session tree — fork, navigate to leaf, list, delete, rename.
8. Context compaction — threshold-driven auto + manual trigger, cutting on user-message turn boundaries.
9. LLM provider abstraction — `LlmProvider` interface (auth + catalog), `createStreamFn` factory, `LlmAuthCredential` rotation envelope.
10. RPC wire protocol — typed commands, responses, events (agent, session-loaded, compaction, tool upcall).
11. Transport pairs — in-process (`MessageChannel`) and Worker (`MessagePort`).
12. Worker boot protocol — tagged init message transferring `agentPort` and `vfsPort`.
13. Extension type scaffolding — placeholder types for a future extension host.

### Scope out

1. Authentication flows (OAuth, token storage, refresh).
2. Direct LLM catalog fetching inside `worker-agent/` — the catalog comes from the injected `LlmProvider`; the worker itself never talks to an endpoint.
3. Bodhi-specific base URLs, endpoints, or headers.
4. Main-thread lifecycle (React hooks, providers, FSA handle persistence).
5. Node-only primitives (`fs`, `child_process`, `jiti`, `pi-tui`). See **Hard constraint** in `CLAUDE.md`.

### Actors & integration points

- **Host (main thread):** consumes `RpcClient`, supplies `FileSystemDirectoryHandle`, reads models via `getAvailableModels`, services MCP tool upcalls via `setToolCallHandler`, pushes auth credentials via `setAuthToken`, mounts a ZenFS `Port` backend against `vfsPort`. The host no longer pushes a catalog.
- **Concrete provider (outside `worker-agent/`):** implements `LlmProvider`. Wired into `streamFn`, the compaction summariser, catalog RPC, and session-restore model resolution at boot; receives credential rotations via the `set_auth_token` RPC.
- **pi-agent-core:** provides the `Agent` runtime driven by `AgentSession`.
- **pi-ai:** provides `streamSimple` / `completeSimple` and the `Model<Api>` catalog shape.
- **ZenFS + `@zenfs/dom`:** filesystem; `WebAccess` wraps FSA handles, `InMemory` backs the dev seed.
- **Dexie:** IndexedDB backing for session persistence.

### Folder layout

```
packages/web-agent/src/worker-agent/
├── index.ts                  # public barrel
├── core/
│   ├── agent-session.ts
│   ├── compaction/           # token-estimate, prepare, summarize, prompts, serialize, file-ops
│   ├── extensions/           # type scaffolding (not wired yet)
│   ├── session/              # store, memory-store, dexie-store, session-manager, types, ids, tree
│   └── tools/                # read/write/edit/ls/glob/grep + truncation + file-mutation-queue
├── fs/                       # zenfs-provider, zenfs-operations, path-utils
├── llm/                      # types (LlmProvider/LlmAuthCredential), stream (createStreamFn)
├── rpc/                      # rpc-types, rpc-client, rpc-server, transport, error, transports/
└── worker/                   # init-protocol, agent-worker (Worker entry), boot (main-thread), worker-host
```

### Public surface

The barrel at `packages/web-agent/src/worker-agent/index.ts` defines the extraction boundary. Notable groupings:

- Agent session: `AgentSession`, `AgentSessionOptions`.
- LLM provider: `LlmProvider`, `LlmAuthCredential`, `createStreamFn`.
- RPC: `RpcServer`, `RpcClient`, `Transport`, `createInProcessTransportPair`, `createWorkerTransportPair`, command/response/event types, error helpers.
- Worker boot: `getAgentWorker`, `disposeAgentWorker`, `_resetAgentWorkerForTests`, `WorkerAgentHost`, `AgentWorkerInit`, `AGENT_WORKER_INIT_TYPE`, `isAgentWorkerInit`.
- Session persistence: `SessionManager`, `MemorySessionStore`, `DexieSessionStore`, `WebAgentDB`, `DEFAULT_DB_NAME`, all entry types, `generateSessionId`, `generateEntryId`.
- Vault filesystem: `createVaultTools`, `createZenfsVaultOperations`, operations interfaces, `fs`, `VAULT_MOUNT`, `mountVaultPort`, `unmountVault`, `isVaultMounted`, `resolveVaultPath`, `VaultPathError`.

Changes to the barrel are part of the extraction contract — a plan that adds or removes an export must justify it.

## Global guarantees & invariants

1. **No coupling to any specific LLM auth scheme or catalog endpoint.** `worker-agent/` must not import from `worker-bodhi/` or name any Bodhi-specific constant. The only surface is `LlmProvider` (auth + catalog). The only exceptions are the two boot shims (`worker/agent-worker.ts`, `worker/boot.ts`) that instantiate the concrete provider.
2. **No node-only imports.** Browser-safe only — no `fs`, `child_process`, `jiti`, `pi-tui`.
3. **No dependency on `packages/coding-agent`.** Enforced at repo level (`CLAUDE.md`).
4. **Structured-clone safety.** All RPC payloads survive `postMessage`; no functions cross the transport.
5. **Turn-boundary persistence.** Message persistence, auto-compaction, and `session_loaded` re-emission are serialised through a single write chain so parent-id links can never dangle under concurrent events.
6. **Dev/test parity.** The in-process and Worker transports expose the same `Transport` shape and the same `RpcClient` behaviour, modulo the absence of a real `vfsPort` in the in-process fallback.

## Non-goals

- Streaming protocol translation (handled by `pi-ai`).
- Token refresh or revocation (concrete auth provider's responsibility).
- Extension sandboxing — will arrive as a separate milestone with its own spec.

## Change procedure

Any plan that modifies files under `packages/web-agent/src/worker-agent/` MUST include an explicit task to update the matching topic file(s) in this folder. State that task in the plan, not as a follow-up. When the functional/technical surface is unchanged (e.g. a purely internal refactor), state that explicitly in the plan rather than skipping the check.

Editing checklist:

1. Identify which topic file(s) cover the affected code.
2. Update content in the same PR as the code change.
3. If a new module is added, create a new topic file and link it from this `index.md`.
4. If a topic file becomes dead (a module is deleted), remove it and update the navigation.

See `CLAUDE.md § Functional specs` for the hard rule.
