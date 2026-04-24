# web-acp

**Source of truth:** `packages/web-acp/src/`

**Status:** living document — update as part of any plan that
changes the source folder. Reflects the **M3 exit state** —
multi-volume mount + `just-bash` `bash` tool (M2), the
`_bodhi/features/*` toggle surface (M2), the `fs/*` IDE-
integration seam (M2), and MCP-over-Streamable-HTTP with
per-session toggles (M3) all shipped; see
[`../../milestones/m2-tools.md`](../../milestones/m2-tools.md)
and [`../../milestones/m3-mcp.md`](../../milestones/m3-mcp.md).

## Purpose

`web-acp` is a browser-native agent harness that speaks
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP)
JSON-RPC 2.0 as its **internal** wire protocol. The host app
(Vite + React) runs the ACP **client**; a dedicated Web Worker
runs the ACP **agent** backed by `@mariozechner/pi-agent-core`.
The two halves talk over a single `MessageChannel` wrapped as a
byte-stream pair and framed by the ACP SDK's `ndJsonStream`.

The module is the extraction target for a future standalone
library (working name `@bodhiapp/bodhi-web-acp`). M0 exists to
prove the framing end-to-end against a real LLM before the
feature milestones (sessions, tools, tree, compaction, resources,
extensions, polish) enter.

Two invariants drive the design:

- **ACP is the only internal protocol.** The worker and the main
  thread communicate exclusively through ACP methods and
  notifications (`initialize`, `authenticate`, `session/new`,
  `session/prompt`, `session/update`, `session/cancel`, plus the
  `bodhi/listModels` extension method). No bespoke JSON-RPC, no
  ad-hoc `postMessage` envelopes beyond the single `init` kickoff.
- **Provider-agnostic agent core.** The worker knows how to drive
  `pi-agent-core`'s `Agent` against any `LlmProvider`. The Bodhi
  specifics (token handling, catalog flattening) live behind the
  `LlmProvider` boundary in [`./agent.md`](./agent.md). Swapping
  provider means swapping that one class, not the worker harness.

## Navigation

Start with **[startup-sequence](./startup-sequence.md)** — it is
the clearest single view of how the pieces hang together. Then
drill into the per-module specs:

| File | Scope |
| --- | --- |
| [`startup-sequence.md`](./startup-sequence.md) | End-to-end wiring: page load → worker spawn → ACP handshake → Bodhi authenticate → `bodhi/listModels` → session/prompt turn. The authoritative reference for "what happens when". |
| [`acp.md`](./acp.md) | `src/acp/` — `AcpClient`, `AcpAgentAdapter`, the `bodhi-token` auth method, the `bodhi/listModels` extension method, ACP ↔ `pi-agent-core` streaming translation. |
| [`agent.md`](./agent.md) | `src/agent/` — `agent-worker.ts` (Worker entry), `InlineAgent` (`pi-agent-core` wrapper), `BodhiProvider` (`LlmProvider` implementation), `createStreamFn` (pi-ai bridge). |
| [`sessions.md`](./sessions.md) | `src/agent/session-store.ts` — Dexie-backed worker-owned session persistence (schema, CRUD, invariants, replay contract with `session/load`). |
| [`transport.md`](./transport.md) | `src/transport/worker-stream.ts` — `MessagePort` ↔ `ReadableStream`/`WritableStream` bridge consumed by `ndJsonStream`. |
| [`hook.md`](./hook.md) | `src/hooks/useAcp.ts` — the React hook that drives the main-thread side of the ACP connection, owns the singleton worker, and surfaces chat state to `ChatDemo`. |
| [`vault.md`](./vault.md) | `src/vault/`, `src/agent/volume-*.ts`, `src/agent/system-prompt.ts`, `src/transport/volume-control.ts`, `src/hooks/useVolumes.ts`, `src/components/volumes/`, `src/acp/fs-handlers.ts` — multi-volume mount architecture, FSA handle persistence, the main-thread volume-control channel, the worker-side `VolumeRegistry`, and the main-thread `fs/*` IDE-integration seam (M2). |
| [`tools.md`](./tools.md) | `src/agent/tools/` — the `bash` AgentTool, `VolumeFileSystem` adapter over ZenFS, `MountableFs` composition, cancellation & truncation, ACP `tool_call` / `tool_call_update` translation (M2). |
| [`features.md`](./features.md) | `src/features/`, `src/components/features/` — per-session feature-toggle store (Dexie v2 `features` table), `_bodhi/features/*` ACP extension methods, DEV-only gating for `forceToolCall` (M2). |
| [`mcp.md`](./mcp.md) | `src/mcp/`, `src/agent/mcp/` — main-thread MCP catalog + `McpServerHttp` composition, worker-side `@modelcontextprotocol/sdk` client, refcounted connection pool, tool adapter, `_meta.bodhi.mcp` lifecycle events (M3). |

## Overview

### Scope in (M0 → M2, all shipped)

1. Spawn exactly one agent Web Worker per tab.
2. Establish a `MessageChannel`-backed ACP connection using
   `@agentclientprotocol/sdk@0.17.0`'s `ClientSideConnection` +
   `AgentSideConnection` + `ndJsonStream`.
3. Announce one auth method (`bodhi-token`) and the extension
   methods (`bodhi/listModels`, `bodhi/listSessions`,
   `bodhi/getSession`); everything Bodhi-specific rides through
   ACP's standard `_meta` / `extMethod` escape hatches. The stable
   `session/load` request is advertised via
   `agentCapabilities.loadSession = true` so clients can resume
   persisted sessions using the ACP-native path.
4. Forward the Bodhi access token from `@bodhiapp/bodhi-js-react`
   to the worker on every auth-state change.
5. Fetch the Bodhi model catalog from inside the worker; surface
   `{id, apiFormat}` descriptors to the main thread.
6. Stream assistant turns over `session/update`
   (`agent_message_chunk`) notifications as `pi-agent-core`
   produces them.
7. Keep the existing Playwright chat e2e (`chat.spec.ts`) green —
   the UI contract of `ChatDemo` is unchanged.

### Scope out (deferred)

- Session rename / delete UI (M1.x).
- Permission bridge — just-bash transform plugin →
  `session/request_permission` — carved out of M2.3; see
  [`../../milestones/deferred.md`](../../milestones/deferred.md).
- Provider-native tool passthrough (OpenAI `web_search`,
  Anthropic `web_search` / computer-use, etc.) — carved out of
  M3.3; see
  [`../../milestones/deferred.md`](../../milestones/deferred.md).
- Slash commands / prompt templates / skills (**M4**).
- `/vault/.bodhi/extensions/` runtime (**M5**).
- Session tree — `session/fork` (unstable, flag-gated) +
  `bodhi/listSessions` tree view (**M6**).
- Context compaction (**M7**).
- Diagnostics panel, HTML export, library extraction (**M8**).
- Second (test-double) transport implementation. M0 shipped one
  transport; the swappability assertion is carried forward as a
  hardening follow-up (see
  [`../../milestones/m0-foundation.md`](../../milestones/m0-foundation.md)).

### Actors & integration points

- **`AppContent` / `BodhiProvider` (`src/App.tsx`):** owns Bodhi
  auth state via `@bodhiapp/bodhi-js-react`. Auto-opens the setup
  modal when the client isn't connected. The Bodhi access token
  reaches the worker only after this component mounts and the SDK
  reports `auth.accessToken`.
- **`useAcp` (`src/hooks/useAcp.ts`):** main-thread singleton that
  spawns the worker, wires the ACP connection, translates Bodhi
  auth state into `authenticate` + `listModels` calls, and
  surfaces chat state to `ChatDemo`. Detail in [`hook.md`](./hook.md).
- **`agent-worker.ts` (`src/agent/agent-worker.ts`):** Web Worker
  entry. Receives the `init` message with the `MessagePort`,
  wraps it as byte-streams, hands them to
  `AgentSideConnection` + `AcpAgentAdapter`. Detail in
  [`agent.md`](./agent.md).
- **`@agentclientprotocol/sdk`:** owns JSON-RPC framing, method
  correlation, and the `ndJsonStream` parser/serialiser. We never
  hand-roll envelopes.
- **`@mariozechner/pi-agent-core`:** owns the single-turn agent
  loop driving `pi-ai`. `InlineAgent` is the thinnest wrapper
  that survives structured-clone (see [`agent.md`](./agent.md)).
- **`@bodhiapp/bodhi-js-react`:** owns OAuth-2.1 login, token
  storage / rotation, and the per-tab Bodhi client state. `useAcp`
  observes `auth.accessToken` and `bodhiClient.getState()` and
  never talks to an auth server itself.

### Folder layout

```
packages/web-acp/src/
├── acp/
│   ├── index.ts           # public constants + SDK re-exports
│   ├── methods.ts         # `_bodhi/*` extension method name barrel (M2)
│   ├── client.ts          # AcpClient (main-thread wrapper over ClientSideConnection)
│   ├── fs-handlers.ts     # main-thread `fs/readTextFile` / `fs/writeTextFile` handlers (M2.3)
│   └── agent-adapter.ts   # AcpAgentAdapter (agent-side: Agent implementation)
├── agent/
│   ├── agent-worker.ts    # Web Worker entry; wires AcpAgentAdapter
│   ├── inline-agent.ts    # pi-agent-core wrapper
│   ├── bodhi-provider.ts  # BodhiProvider (LlmProvider implementation)
│   ├── session-store.ts   # Dexie-backed SessionStore (v3: sessions + features + mcpToggles)
│   ├── stream-fn.ts       # createStreamFn(provider) → pi-ai bridge
│   ├── volume-mount.ts    # VolumeRegistry (worker-side ZenFS mounts, M2)
│   ├── volume-channel.ts  # raw-postMessage volume-control bridge (M2)
│   └── system-prompt.ts   # composeSystemPrompt(volumes) (M2)
├── agent/mcp/             # worker-side MCP runtime (M3)
│   ├── client.ts          # createMcpClient (StreamableHTTPClientTransport)
│   ├── connection-pool.ts # McpConnectionPool (refcounted, fingerprint eviction)
│   └── tool-adapter.ts    # MCP tool descriptor → AgentTool<TSchema>
├── mcp/                   # main-thread MCP surface (M3)
│   ├── types.ts           # McpInstanceView, McpConnectionState, BodhiMcpUpdateMeta
│   ├── useMcpInstances.ts # React hook over bodhiClient.mcps.list() (live fetch)
│   ├── compose-mcp-servers.ts # pure compose(instances, jwt, baseUrl, toggles?)
│   ├── toggle-store.ts    # worker-side per-session mcpToggles store (Dexie v3)
│   └── McpPanel.tsx       # status chips + per-server/per-tool toggle UI
├── vault/
│   ├── fsa-handle-store.ts # idb-keyval-backed FSA handle persistence (M2)
│   └── main-zenfs.ts      # main-thread ZenFS duplicate-mount manager (M2.3)
├── features/
│   └── feature-store.ts   # per-session feature toggles (Dexie v2) (M2)
├── agent/tools/
│   ├── bash-tool.ts       # just-bash-backed `bash` AgentTool (M2)
│   └── volume-filesystem.ts # IFileSystem adapter over ZenFS (M2)
├── transport/
│   ├── worker-stream.ts   # MessagePort ↔ ReadableStream/WritableStream
│   └── volume-control.ts  # main-thread client for the volume-control channel (M2)
├── hooks/
│   ├── useAcp.ts          # React hook; owns the singleton worker + ACP client
│   └── useVolumes.ts      # React hook; manages multi-volume state (M2)
├── components/            # shadcn/ui + ChatDemo + volumes/VolumesPanel (M2)
├── lib/                   # bodhi-models, agent-model, utils
├── types/                 # UI-level types
└── App.tsx, main.tsx, env.ts
```

The split under `src/` is deliberate: `acp/`, `agent/`,
`transport/` form the extractable runtime; `hooks/`, `components/`,
`lib/`, `types/` stay with the reference app when the runtime
eventually becomes its own package.

### Public surface (today)

`web-acp` does not yet export a public barrel — M0 is the
reference app itself. The files that will form the library
boundary at extraction time (M7) are:

- `src/acp/index.ts` — `BODHI_AUTH_METHOD_ID`,
  `BODHI_LIST_MODELS_METHOD`, `BODHI_LIST_SESSIONS_METHOD`,
  `BODHI_GET_SESSION_METHOD`, `BodhiAuthenticateMeta`,
  `BodhiModelDescriptor`, `BodhiListModelsResponse`,
  `BodhiSessionSummary`, `BodhiListSessionsResponse`,
  `BodhiGetSessionRequest`, `BodhiGetSessionResponse`, plus
  re-exported SDK types (including `LoadSessionRequest` /
  `LoadSessionResponse`). This is the contract every ACP client
  of the worker consumes.
- `src/acp/client.ts` — `AcpClient`.
- `src/acp/agent-adapter.ts` — `AcpAgentAdapter`.
- `src/agent/inline-agent.ts` — `InlineAgent`, `createInlineAgent`.
- `src/agent/session-store.ts` — `SessionStore`, `createSessionStore`
  (M1, worker-only). Spec in [`./sessions.md`](./sessions.md).
- `src/agent/bodhi-provider.ts` — `BodhiProvider`,
  `BODHI_PROVIDER_TAG`, `apiFormatOfModel`, `LlmProvider`,
  `LlmAuthCredential`.
- `src/agent/stream-fn.ts` — `createStreamFn`.
- `src/agent/agent-worker.ts` — `AgentWorkerInitMessage`.
- `src/transport/worker-stream.ts` — `createMessagePortStream`,
  `PortByteStream`.

Changes that move, rename, or remove any of these need a matching
update in the spec file that covers them.

## Global guarantees & invariants

1. **One worker per tab.** `useAcp` holds the worker, client, and
   `initialize` promise at module scope; StrictMode's double-mount
   and React fast-refresh both re-enter the effect but never spawn
   a second worker. Detail in [`hook.md`](./hook.md).
2. **One-shot `init`.** The worker accepts exactly one
   `{type: 'init', agentPort}` message; subsequent inits are
   logged and ignored. Detail in [`agent.md`](./agent.md).
3. **ACP-only across the boundary.** After the `init` transfer,
   the `MessageChannel` carries nothing but `ndJsonStream`-framed
   JSON-RPC. No bespoke messages ride alongside.
4. **Bodhi specifics stay inside `agent/bodhi-provider.ts`.**
   `AcpAgentAdapter` is the only other file that names the Bodhi
   auth method id / extension method id, and it does so through
   constants exported from `acp/index.ts`.
5. **Structured-clone safety.** Payloads on both sides of the
   `MessagePort` are `Uint8Array` chunks; the writable stream
   allocates a fresh buffer per chunk and transfers it so the
   caller's buffer isn't detached mid-write. Detail in
   [`transport.md`](./transport.md).
6. **Chat UI contract unchanged.** `ChatDemo` reads the same hook
   return shape it did pre-rework; the e2e `chat.spec.ts` passes
   against the new stack without modification.

## Non-goals

- Second transport implementation (deferred — see M0 hardening
  follow-up).
- Node-compatible stdio transport — browsers only for M0; the
  ACP reference server / `pi-acp` (Node/stdio) is read for
  prior art but not depended on.
- Any direct import of `packages/web-agent/src/**`. `web-acp` is
  a clean re-implementation; the web-agent specs are a crib
  sheet, not a code dependency.

## Change procedure

Any plan that modifies files under `packages/web-acp/src/` MUST
include an explicit task to update the matching topic file(s) in
this folder. State that task in the plan, not as a follow-up.
When the functional/technical surface is unchanged (pure internal
refactor), state that explicitly in the plan rather than skipping
the check.

Editing checklist:

1. Identify which topic file(s) cover the affected code
   ([`acp.md`](./acp.md), [`agent.md`](./agent.md),
   [`transport.md`](./transport.md), [`hook.md`](./hook.md), or
   [`startup-sequence.md`](./startup-sequence.md) for any change
   that alters the boot / auth / prompt flow).
2. Update content in the same commit as the code change.
3. If a new module is added (e.g. a persistence layer at M1),
   create a new topic file and link it from this `index.md`.
4. If a topic file becomes dead (module deleted), remove it and
   update the navigation.

See `CLAUDE.md § Functional specs` for the hard rule.
