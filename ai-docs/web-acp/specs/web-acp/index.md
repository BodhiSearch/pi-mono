# web-acp

**Source of truth.** Two packages today:

- `packages/web-acp-agent/src/` — the **transport-agnostic ACP
  agent runtime** (extracted post-M4 phase B). Owns the worker-
  side wire shim (`acp/agent-adapter.ts`), the engine layer
  (`acp/engine/{services,session-runtime,prompt-driver,
  builtin-dispatch,ext-methods}`), the `pi-agent-core` wrapper
  (`agent/inline-agent.ts`), `BodhiProvider`, vault-sourced and
  built-in slash commands, the MCP client / pool / tool-adapter,
  the `bash` tool, the ZenFS-based volume registry, and the
  in-package store *interfaces* (`SessionStore`, `FeatureStore`,
  `McpToggleStore`). Zero browser-only deps. See
  [`packages/web-acp-agent/README.md`](../../../packages/web-acp-agent/README.md).
- `packages/web-acp/src/` — the **browser host runtime** that
  embeds the agent as a Web Worker. Owns React (`hooks/`,
  `components/`), the Dexie store implementations
  (`runtime/storage-dexie/`), the FSA-backed volume backends
  (`runtime/volumes-fsa/`), the `MessagePort` byte-stream
  bridge (`runtime/transport/worker-stream.ts`), the host-side
  ACP wire/engine split (`acp/{runtime,streaming-reducer,
  builtin-dispatch,fs-handlers,permissions,…}`), and the
  `agent-worker.ts` boot shim that wires those host adapters to
  `startAcpAgent` from the agent package.

A second host runtime — `packages/cli-acp-client/` — embeds the
same agent package in a Node TTY process over an in-memory
duplex; see [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
The wire is byte-identical to the browser worker's; the proof
that the agent runtime is genuinely host-neutral.

**Topic-file note.** Most topic files below were authored before
the agent extraction and still cite paths under
`packages/web-acp/src/agent/`, `…/src/acp/engine/`,
`…/src/features/`, or `…/src/mcp/toggle-store.ts`. The post-M4
phase B extraction completed the cutover: those subtrees no
longer exist in `packages/web-acp/src/`, and every duplicated
type / engine file lives only at `packages/web-acp-agent/src/`
(same relative layout). When a topic file says e.g.
`packages/web-acp/src/agent/inline-agent.ts`, read it as
`packages/web-acp-agent/src/agent/inline-agent.ts`. Topic files
are progressively rewritten to the new paths as we revise them.

**Status:** living document — update as part of any plan that
changes the source folder. Reflects the **M4 phase B exit
state** — multi-volume mount + `just-bash` `bash` tool (M2),
the `_bodhi/features/*` toggle surface (M2), the `fs/*` IDE-
integration seam (M2), MCP-over-Streamable-HTTP with per-session
toggles (M3), vault-sourced slash commands (M4 phase A), and
agent-handled built-in slash commands `/help` `/version`
`/session` `/copy` (M4 phase B) all shipped; see
[`../../milestones/m2-tools.md`](../../milestones/m2-tools.md),
[`../../milestones/m3-mcp.md`](../../milestones/m3-mcp.md), and
[`../../milestones/m4-commands-and-skills.md`](../../milestones/m4-commands-and-skills.md).

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
| [`acp.md`](./acp.md) | Agent-side wire shim + engine layer at **`packages/web-acp-agent/src/acp/{agent-adapter,engine/{services,session-runtime,prompt-driver,builtin-dispatch,ext-methods}}`**, plus host-side `src/acp/client.ts` and the `bodhi-token` auth method. ACP ↔ `pi-agent-core` streaming translation. |
| [`agent.md`](./agent.md) | Host-side `src/agent/agent-worker.ts` (Worker boot shim that calls `startAcpAgent` from `@bodhiapp/web-acp-agent`). Agent-side `InlineAgent`, `BodhiProvider`, `createStreamFn` live in **`packages/web-acp-agent/src/agent/`**. |
| [`sessions.md`](./sessions.md) | Dexie-backed `SessionStore` impl at **`src/runtime/storage-dexie/session-store.ts`** satisfying the agent-package interface. Schema, CRUD, invariants, replay contract with `session/load`. |
| [`transport.md`](./transport.md) | `src/runtime/transport/worker-stream.ts` — `MessagePort` ↔ `ReadableStream`/`WritableStream` bridge consumed by `ndJsonStream`. |
| [`hook.md`](./hook.md) | `src/hooks/useAcp.ts` (thin facade) + the per-concern slice hooks under `src/hooks/useAcp{Runtime,Auth,Models,Features,Mcp,Session,Streaming}.ts` + the host-side ACP plumbing under `src/acp/{runtime,streaming-reducer,builtin-dispatch,message-shape,session-meta,permissions}.ts`. The wire/engine split mirrors the agent-side `acp/engine/` cut now living in `@bodhiapp/web-acp-agent`. |
| [`vault.md`](./vault.md) | `src/vault/`, **`src/runtime/volumes-fsa/`** (HostVolumeInit, `toAgentVolumeInit`, `attachVolumeChannel`, `createVolumeControl`), `src/hooks/useVolumes.ts`, `src/components/volumes/`, `src/acp/fs-handlers.ts` — multi-volume mount architecture, FSA handle persistence, the main-thread volume-control channel, and the main-thread `fs/*` IDE-integration seam (M2). The agent-side `VolumeRegistry` interface + `ZenfsVolumeRegistry` impl live in `@bodhiapp/web-acp-agent`. |
| [`tools.md`](./tools.md) | Agent-side `bash` AgentTool, `VolumeFileSystem` adapter over ZenFS, `MountableFs` composition, cancellation & truncation, ACP `tool_call` / `tool_call_update` translation — all at **`packages/web-acp-agent/src/agent/tools/`** (M2). |
| [`features.md`](./features.md) | `src/runtime/storage-dexie/feature-store.ts` (host-side Dexie impl) + `src/components/features/` — per-session feature-toggle store, `_bodhi/features/*` ACP extension methods, DEV-only gating for `forceToolCall` (M2). The interface + `FEATURE_DEFAULTS` live in `@bodhiapp/web-acp-agent`. |
| [`mcp.md`](./mcp.md) | `src/mcp/` (main-thread MCP catalog + `McpServerHttp` composition + UI), `src/runtime/storage-dexie/mcp-toggle-store.ts` (host-side Dexie impl). Agent-side worker MCP client, refcounted connection pool, tool adapter, `_meta.bodhi.mcp` lifecycle events all live in `@bodhiapp/web-acp-agent` (M3). |
| [`commands.md`](./commands.md) | Agent-side `packages/web-acp-agent/src/agent/commands/` — vault-sourced slash commands (M4 phase A) + agent-handled built-ins `/help` `/version` `/info` `/copy` `/mcp` (M4 phase B), the `_meta.bodhi.builtin` envelope, the `'builtin'` `SessionEntry` kind, and the host-side client-action dispatch under `src/acp/builtin-dispatch.ts`. |

## Overview

### Scope in (M0 → M4 phase B, all shipped)

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
- Prompt templates (M4.2) and skills (M4.3) — sub-milestones of
  M4 not yet started; vault-sourced commands (M4 phase A) and
  agent-handled built-ins (M4 phase B) **shipped**, see
  [`./commands.md`](./commands.md).
- State-mutation built-ins (`/name`, `/model`, `/new`,
  `/resume`, `/settings`, `/login`, `/logout`) — next slice of
  M4 phase B; not yet shipped.
- `<mount>/.pi/extensions/` runtime (**M5**).
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
- **`useAcp` (`src/hooks/useAcp.ts`):** thin facade that composes
  seven slice hooks (`useAcp{Runtime,Auth,Models,Features,Mcp,
  Session,Streaming}`) and the host-side ACP plumbing under
  `src/acp/{runtime,streaming-reducer,builtin-dispatch,…}`.
  Spawns the worker, wires the ACP connection, translates Bodhi
  auth state into `authenticate` + `listModels` calls, drives the
  prompt-turn loop through a typed `streamingReducer`, and
  surfaces chat state to `ChatDemo`. Detail in
  [`hook.md`](./hook.md).
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

Post-cleanup (the agent-extraction PR finished the wiring flip):
the duplicated engine layer + agent runtime files are gone from
`packages/web-acp/src/`. What remains is the host-side ACP wire
half + React + the host-specific Dexie/FSA/MessagePort
adapters under `runtime/`. Everything agent-side comes from
`@bodhiapp/web-acp-agent`.

```
packages/web-acp/src/
├── acp/                       # Host-side ACP wire/engine split (no engine layer here — agent owns it)
│   ├── index.ts               # public constants + SDK re-exports
│   ├── methods.ts             # `_bodhi/*` extension method name barrel
│   ├── client.ts              # AcpClient (main-thread wrapper over ClientSideConnection)
│   ├── fs-handlers.ts         # main-thread `fs/readTextFile` / `fs/writeTextFile` handlers
│   ├── runtime.ts             # AcpRuntime singleton + per-tab session/auth state
│   ├── streaming-reducer.ts   # Pure reducer for session/update + turn lifecycle (host)
│   ├── builtin-dispatch.ts    # Pure dispatchBuiltinAction (copy / mcp-add / mcp-remove)
│   ├── permissions.ts         # session/request_permission stub (deferred)
│   ├── message-shape.ts       # Empty/get/withAssistantText helpers, userMessage, …
│   ├── session-meta.ts        # authKeyOf, toBodhiModelInfo, composeSessionMeta
│   └── wire-utils.ts          # ACP wire helpers (extractSessionMeta, filterHttpServers, …)
├── agent/
│   └── agent-worker.ts        # Web Worker entry: opens Dexie, builds FSA registry, calls startAcpAgent from @bodhiapp/web-acp-agent
├── runtime/                   # Host adapters that satisfy the agent-package interfaces
│   ├── storage-dexie/         # Dexie/IndexedDB SessionStore + FeatureStore + McpToggleStore impls
│   │   ├── db.ts              # SessionStoreDb (v3 schema)
│   │   ├── session-store.ts   # createSessionStore / createStoreFromDb
│   │   ├── feature-store.ts   # createFeatureStore
│   │   ├── mcp-toggle-store.ts # createMcpToggleStore
│   │   └── index.ts           # barrel
│   ├── volumes-fsa/           # FSA-backed volume host (handle ↔ agent VolumeInit)
│   │   ├── types.ts           # HostVolumeInit (host-shaped, FSA handle | seed) + VolumeSeed
│   │   ├── backends.ts        # toAgentVolumeInit() — converts HostVolumeInit → agent's VolumeInit
│   │   ├── volume-channel.ts  # worker-side raw-postMessage mount/unmount listener
│   │   ├── volume-control.ts  # main-thread client for the volume-control channel
│   │   └── index.ts           # barrel
│   └── transport/
│       └── worker-stream.ts   # MessagePort ↔ ReadableStream/WritableStream byte-stream bridge
├── mcp/                       # Main-thread MCP surface
│   ├── types.ts               # McpInstanceView, McpConnectionState, BodhiMcpUpdateMeta
│   ├── useMcpInstances.ts     # React hook over bodhiClient.mcps.list() (live fetch)
│   ├── compose-mcp-servers.ts # pure compose(instances, jwt, baseUrl, toggles?)
│   ├── requested-mcps-store.ts # IndexedDB-backed wishlist of MCP URLs requested at login
│   ├── url-canonical.ts       # canonicalizeMcpUrl helper (also re-exported by agent package)
│   └── McpPanel.tsx           # status chips + per-server/per-tool toggle UI
├── vault/
│   ├── fsa-handle-store.ts    # idb-keyval-backed FSA handle persistence
│   └── main-zenfs.ts          # main-thread ZenFS duplicate-mount manager (fs/* IDE-integration seam)
├── hooks/
│   ├── useAcp.ts              # Thin facade composing the slice hooks; owns isAuthenticated gating
│   ├── useAcpRuntime.ts       # ensureRuntime + useVolumes wrapper
│   ├── useAcpAuth.ts          # Bodhi auth observation, model load, token-rotation session/load rebuild
│   ├── useAcpModels.ts        # selectedModel, ensureDefaultModel, applyLastModel, loadModels
│   ├── useAcpFeatures.ts      # _bodhi/features/* slice
│   ├── useAcpMcp.ts           # mcpToggles, composeCurrentMcpServers, dispatchAction, setMcpToggle
│   ├── useAcpSession.ts       # ensureSession, loadSession, clearMessages, deleteSession + lifecycle effects
│   ├── useAcpStreaming.ts     # session/update listener + sendMessage/stop/clearError driving the reducer
│   └── useVolumes.ts          # React hook; manages multi-volume state
├── components/                # shadcn/ui + ChatDemo + volumes/VolumesPanel + features/FeaturePanel + mcp/McpPanel
├── lib/                       # bodhi-models, agent-model, builtin-format, utils
├── types/                     # UI-level types (chat.ts)
└── App.tsx, main.tsx, env.ts, vite-env.d.ts
```

The split under `src/` is deliberate: `acp/` (host-side wire),
`agent/agent-worker.ts` (boot shim), and `runtime/` form the
host-runtime layer that wires `@bodhiapp/web-acp-agent` to the
browser. `hooks/`, `components/`, `lib/`, `mcp/`, `vault/`, and
`types/` are the reference-app surface that stays here when the
host-runtime becomes its own package.

### Public surface (today)

After the post-M4 phase B agent extraction, **the agent-side
public surface lives in `@bodhiapp/web-acp-agent`** (see
`packages/web-acp-agent/src/index.ts`): `AcpAgentAdapter`,
`AcpAdapterServices`, `assembleServices`, `StreamOverridesRef`,
`AcpSessionRuntime`, `PromptTurnDriver`, `InlineAgent`,
`createInlineAgent`, `BodhiProvider`, `createStreamFn`,
`SessionStore`, `FeatureStore`, `McpToggleStore`,
`VolumeRegistry` / `ZenfsVolumeRegistry`, `VolumeInit`, plus the
`startAcpAgent` bootstrap.

`web-acp` does not yet export a public barrel — it is still the
reference app embedding the agent package. The files that will
form the **host-runtime** library boundary when this package is
extracted (M8) are:

- `src/acp/index.ts` — `BODHI_AUTH_METHOD_ID`,
  `BODHI_LIST_MODELS_METHOD`, `BODHI_LIST_SESSIONS_METHOD`,
  `BODHI_GET_SESSION_METHOD`, `BodhiAuthenticateMeta`,
  `BodhiModelDescriptor`, `BodhiListModelsResponse`,
  `BodhiSessionSummary`, `BodhiListSessionsResponse`,
  `BodhiGetSessionRequest`, `BodhiGetSessionResponse`, plus
  re-exported SDK types (`LoadSessionRequest` /
  `LoadSessionResponse`). This is the host-side ACP wire surface.
- `src/acp/client.ts` — `AcpClient`.
- `src/agent/agent-worker.ts` — `AgentWorkerInitMessage` + the
  Worker boot shim that calls `startAcpAgent` from the agent
  package.
- `src/runtime/storage-dexie/` — Dexie-backed `SessionStore` /
  `FeatureStore` / `McpToggleStore` impls satisfying the agent
  package's interfaces.
- `src/runtime/volumes-fsa/` — `HostVolumeInit`,
  `toAgentVolumeInit`, `attachVolumeChannel`,
  `createVolumeControl`. The FSA-side bridge that constructs an
  agent-package `VolumeInit` from a browser FSA handle or seed.
- `src/runtime/transport/worker-stream.ts` —
  `createMessagePortStream`, `PortByteStream`.

Changes that move, rename, or remove any of these need a matching
update in the spec file that covers them.

## Global guarantees & invariants

1. **One worker per tab.** `src/acp/runtime.ts` holds the worker,
   client, and `initialize` promise at module scope; StrictMode's
   double-mount and React fast-refresh both re-enter the effect
   but never spawn a second worker. Detail in [`hook.md`](./hook.md).
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
