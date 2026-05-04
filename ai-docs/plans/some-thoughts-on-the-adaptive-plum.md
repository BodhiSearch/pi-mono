# Simplify the `@bodhiapp/web-acp-agent` embed API

## Context

`@bodhiapp/web-acp-agent` is positioned to ship to npm and be consumed
by a wide range of hosts: in-browser Web Workers, in-process Node TTY
CLIs, Node HTTP/SSE backends, even constrained devices like a
Raspberry Pi. The current embed API does not match that ambition. To
boot the agent today the host has to walk a seven-step assembly
ritual:

1. Construct a `BodhiProvider` (or any `LlmProvider`).
2. Wrap it via `createStreamFn(provider, () => ({}))` — a ritual
   whose `() => ({})` second arg is meaningless boilerplate to the
   host.
3. Pass that into `createInlineAgent(streamFn)`.
4. Build a services bag via `assembleServices({ inline, bodhi, ... })`.
5. Call `startAcpAgent(transport, services, options)` with an
   `onAdapter: a => { adapter = a }` callback because the SDK's
   `AgentSideConnection` constructor builds the adapter inside a
   synchronous factory and the helper has no other way to expose it.
6. Manage that captured `adapter` reference solely so it can call
   `adapter.dispose()` at shutdown.
7. Stamp three pieces of build metadata (`isDev`, `buildVersion`,
   `acpSdkVersion`) — the last of which is internal to the agent's
   own dependency choice.

The `tutorial-cli-client/src/agent/embed.ts` review made the cost
concrete: an 87-line file where ~30 lines are this ritual. The
`web-acp` worker shim repeats the same ritual and discards
`startAcpAgent`'s return value entirely — evidence that the current
return shape isn't pulling its weight. We have no production
release; two in-scope downstream hosts; backwards compatibility is
not a constraint.

A second piece of accidental complexity sits below the embed line:
`packages/web-acp/` advertises `fs/{read,write}TextFile` client
capabilities and ships a duplicate `MainZenfs` mount on the main
thread plus a volume-control sidechannel that keeps the two ZenFS
instances in sync. Nothing actually uses these — the agent owns
files (volumes mount inside the worker; the bash tool reads through
them directly), and `fs/*` was carried as a speculative "future IDE
integration" seam. The duplicate mount is also a real concurrency
hazard (two ZenFS instances over the same FSA handle). Removing the
fs/* advertisement collapses this entire sub-system in one move.

ACP wire compliance is preserved end-to-end: the protocol envelope
shape, every `_bodhi/*` extension method/notification, and the
`Agent` interface implemented over `AgentSideConnection` are all
unchanged. The two e2e suites
(`packages/web-acp/e2e/`, `packages/tutorial-cli-client/e2e/`) act
as black-box gate-checks; they MUST pass without test-code changes.
`packages/ws-acp-client/` and `packages/cli-acp-client/` are out of
scope and will be migrated separately.

### What we collapse vs. what we just hide

The plan is honest about which layers genuinely go away and which
are only being moved off the boundary:

| Layer | Treatment | Why |
| --- | --- | --- |
| `createStreamFn` + `createInlineAgent` (3-call ritual) | **Collapsed.** Host never calls them again. | Both hosts wire them identically; zero variation surface. |
| `assembleServices` + `AcpAdapterServices` bag | **Collapsed.** Host passes flat options. | The bag is a `{ ...defaults, ...overrides }` spread; no logic to preserve. |
| `onAdapter` callback + `let adapter` capture | **Collapsed.** Helper closes over the adapter for `dispose`. | The SDK constructor constraint is real; making the host pay for it is not. |
| `StreamOverridesRef` for `forceToolCall` | **Hidden, kept internal.** | The per-turn override path is real (DEV-only e2e determinism); the host never had a reason to see it. |
| `acpSdkVersion` metadata | **Removed from boundary.** | The package owns its own SDK pin. Hosts shouldn't synchronize a string with their dep. |
| `AcpAgentAdapter` class | **Hidden, kept internal.** | It's the SDK's required `Agent`-interface implementation — structurally necessary. |
| `AcpSessionRuntime` / `PromptTurnDriver` / `ext-methods/*` / `builtin-dispatch.ts` | **Unchanged.** | These were just split out of a 1,254-LoC god class; folding them back undoes that work. |
| `fs/{read,write}TextFile` client capability | **Collapsed.** Files deleted on web-acp side. | Architecture has flipped to agent-owned files; the seam is dead code. |
| Main-thread `MainZenfs` duplicate mount | **Deleted.** | Only existed to back the dead `fs/*` handlers. |
| `volume-channel.ts` + `volume-control.ts` sync sidechannel | **Deleted.** | Only existed to keep the two ZenFS instances in sync. |
| Worker-side `attachVolumeChannel` listener | **Deleted.** | Same. |
| `requestPermission` field on `Client` handler | **Deleted everywhere.** | Permission flow is fully stubbed and deferred (see `ai-docs/web-acp/milestones/deferred.md`); the bash tool runs commands as-is. When permissions return, they re-enter as a coherent end-to-end feature. |
| `requestPermissionStub` export from agent package | **Deleted.** | No remaining caller after the host stops carrying a `requestPermission` field. |
| Agent-side `ctx.requestPermission` plumbing in `acp/engine/` | **Deleted.** | No handler ever calls it; cleaning up keeps the agent honest. |

Net: host-visible layers drop from ~7 to **1 (`startAgent`)**.
Internal engine layers stay because they earned the split.
Web-acp's client side loses ~3 files plus an entire concurrency
hazard.

## Goals

1. **A single `startAgent({ transport, provider, ... })` call** boots
   the agent runtime over any byte-stream transport. One options
   shape, one return shape, no callback gymnastics.
2. **No assembly ritual.** `createInlineAgent`, `createStreamFn`,
   `assembleServices`, `AcpAgentAdapter`, `requestPermissionStub`,
   `StreamOverridesRef`, `McpConnectionPool`, `CommandsFs`,
   wire-utility helpers, and the `_bodhi/*` engine internals leave
   the public barrel.
3. **A small `createInMemoryDuplex()` utility** for in-process
   embedded hosts. Agnostic to who's on either end of the duplex;
   does not pretend to know about clients.
4. **`fs/*` client capability removed everywhere.** Web-acp drops
   `fs-handlers.ts`, `MainZenfs`, the volume-control sidechannel,
   the worker-side mount listener. Both hosts advertise
   `clientCapabilities: {}`.
5. **SDK types come from `@agentclientprotocol/sdk` directly.** The
   agent package does not re-export them. Hosts pin their own
   peer dependency.
6. **Both in-scope e2e suites pass with zero test-code changes.**

## The new public surface

After this plan lands, `packages/web-acp-agent/src/index.ts`
exports:

```ts
// boot — the only verb hosts call
export { startAgent }                      from "./api/start-agent";
export { createInMemoryDuplex }            from "./api/in-memory-duplex";
export type { StartAgentOptions, StartAgentHandle, AcpTransport, InMemoryDuplex } from "./api/types";

// providers (default + interface — host picks or implements)
export { BodhiProvider, BODHI_PROVIDER_TAG, apiFormatOfModel } from "./agent/bodhi-provider";
export type { LlmProvider, LlmAuthCredential } from "./agent/bodhi-provider";

// storage interfaces — host implements when it wants persistence
export type {
  SessionStore, SessionEntry, SessionEntryKind, SessionRow,
  SessionSummary, TurnPayload, BuiltinPayload,
} from "./storage/session-store";
export { deriveTitle } from "./storage/session-store";
export type { FeatureStore, FeatureKey, FeatureSnapshot, FeatureDefaults } from "./storage/feature-store";
export { FEATURE_DEFAULTS, isFeatureKey } from "./storage/feature-store";
export type { McpToggleStore, McpToggleSnapshot } from "./storage/mcp-toggle-store";
export { EMPTY_MCP_TOGGLES, isServerEnabled, isToolEnabled } from "./storage/mcp-toggle-store";

// volumes — host wires FS backends inward
export type { VolumeInit, VolumeRegistry, VolumeRegistryListener, VolumeSnapshot } from "./agent/volume-registry";
export { ZenfsVolumeRegistry } from "./agent/volume-registry";

// commands surface that the host UI reads about (e.g. canonical name util)
export { canonicalCommandName, COMMANDS_DIR_RELPATH, PROMPTS_DIR_RELPATH } from "./agent/commands";
export type { CommandDef, CommandSource, FrontMatter } from "./agent/commands";

// `_bodhi/*` wire constants + request/response types — needed by every host
//   to drive authenticate / serverInfo / volumes/list / etc.
export * from "./wire";

// MCP url helper used by host UIs to canonicalize wishlist entries
export { canonicalizeMcpUrl, deriveSlugFromUrl } from "./mcp/url-canonical";
```

**Dropped from the barrel** (becomes internal to the package):

- `startAcpAgent`, `StartAcpAgentOptions` — replaced
- `AcpAgentAdapter`, `AcpAgentAdapterOptions`
- `assembleServices`, `AcpAdapterServices`, `AssembleServicesOptions`,
  `StreamOverridesRef`
- `createInlineAgent`, `InlineAgent`, `InlineAgentSetModelOptions`
- `createStreamFn`, `StreamOptionOverrides`, `StreamOverrideProvider`
- `requestPermissionStub` — file deleted entirely, including the
  `acp/permissions.ts` module on both agent + web-acp sides
- `toAvailableCommand`, `toolTitle` — pure wire helpers
- `loadCommandsFromVolumes`, `loadPromptsFromVolumes`, `expandCommand`,
  `parseFrontMatter`, `createZenfsCommandsFs`, `CommandsFs`,
  `CommandsFsEntry`, `CommandsLoaderInput`, `ExpansionResult`,
  `ParseResult` — vault-command engine internals
- `BuiltinAction`, `BuiltinCommand`, `BuiltinHandlerCtx`,
  `BuiltinMcpInstance`, `BuiltinResult`, `builtinAvailableCommands`,
  `findBuiltin`, `isBuiltinName` — built-in dispatch internals
- `createMcpClient`, `createMcpAgentTool`, `McpConnectionPool`,
  `McpToolAdapterDeps`, `mcpToolName`, `MCP_TOOL_NAME_SEPARATOR`,
  and the `McpClient*` / `McpEvent` / `McpPoolListener` types — MCP
  runtime internals
- `createBashTool`, `BASH_OUTPUT_BYTE_LIMIT`, `BashToolDeps`,
  `BashToolDetails`, `BashToolInput` — tool internals
- `FeatureRow`, `McpTogglesRow` — storage row shapes that don't
  cross the host boundary

A test-utils submodule (`@bodhiapp/web-acp-agent/test-utils`) keeps
`SeedSpec` / `buildSeedInit` exposed for vitest harnesses; nothing
production-side imports from it.

### `startAgent` signature

```ts
export interface AcpTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

export interface StartAgentOptions {
  /** Byte-stream transport carrying ACP JSON-RPC frames. Required. */
  transport: AcpTransport;

  /** LLM provider (auth + model catalog). Required. */
  provider: LlmProvider;

  /** Volume registry. Defaults to a fresh empty `ZenfsVolumeRegistry()`. */
  registry?: VolumeRegistry;

  /** Storage adapters. Each defaults to an internal in-memory impl. */
  sessions?: SessionStore;
  features?: FeatureStore;
  mcpToggles?: McpToggleStore;

  /** Build metadata advertised on `initialize()`. Both optional. */
  isDev?: boolean;          // default false; gates `forceToolCall`
  buildVersion?: string;    // default "0.0.0"
  // NOTE: `acpSdkVersion` is removed from the host-facing options.
  //       The package pins it internally based on its own dep.
}

export interface StartAgentHandle {
  /** Tear the agent down. Idempotent. */
  dispose(): Promise<void>;
}

export function startAgent(options: StartAgentOptions): StartAgentHandle;
```

What `startAgent` does internally (host never sees these):

1. Wraps `transport` with `ndJsonStream`.
2. Constructs a `StreamOverridesRef`, builds `createStreamFn(provider,
   () => ref.current)`, wraps with `createInlineAgent`.
3. Picks defaults for `registry`, `sessions`, `features`,
   `mcpToggles` if not supplied. (In-memory implementations live
   inside the package — see "In-memory store defaults" below.)
4. Calls the existing `assembleServices` internally with the inline
   agent + provider + stores + registry + streamOverrides ref.
5. Constructs `AgentSideConnection` with the
   `(conn) => new AcpAgentAdapter(conn, services, options)` factory.
6. Returns `{ dispose: () => adapter.dispose() }` — the adapter
   reference is closed-over inside the helper; the host never
   touches it.

### `createInMemoryDuplex` signature

```ts
export interface InMemoryDuplex {
  /** Pass to `startAgent({ transport: this.agent, ... })`. */
  agent: AcpTransport;
  /** Wire to a `ClientSideConnection` via `ndJsonStream(client.writable, client.readable)`. */
  client: AcpTransport;
}

export function createInMemoryDuplex(): InMemoryDuplex;
```

A 6-line utility that hands back a pair of `TransformStream`-backed
byte-stream pairs. It does NOT know whether either end will host an
agent or a client. Embedded hosts use it; remote hosts ignore it.

### What an embedded host writes (tutorial-cli-client/embed.ts)

```ts
import type { Client, InitializeResponse } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
  BODHI_AUTH_METHOD_ID,
  BODHI_SERVER_INFO_METHOD,
  BodhiProvider,
  type BodhiServerInfoResponse,
  createInMemoryDuplex,
  startAgent,
} from "@bodhiapp/web-acp-agent";

export async function createEmbeddedAgent() {
  const duplex = createInMemoryDuplex();
  const { dispose } = startAgent({
    transport: duplex.agent,
    provider: new BodhiProvider(),
  });

  const stream = ndJsonStream(duplex.client.writable, duplex.client.readable);
  const handler: Client = {
    async sessionUpdate() {},
  };
  const conn = new ClientSideConnection(() => handler, stream);

  return {
    initialize: () =>
      conn.initialize({ protocolVersion: 1, clientCapabilities: {} }),
    authenticate: (opts: { token: string; baseUrl: string }) =>
      conn.authenticate({ methodId: BODHI_AUTH_METHOD_ID, _meta: opts }),
    serverInfo: async () =>
      (await conn.extMethod(BODHI_SERVER_INFO_METHOD, {})) as BodhiServerInfoResponse,
    close: async () => {
      await dispose();
      await closeStream(duplex.client.writable);
      await closeStream(duplex.agent.writable);
    },
  };
}
```

87 LoC → ~40 LoC. The `Client` handler is 4 lines and visible —
the host owns the policy decision of what to do on
`sessionUpdate` / `requestPermission`. `clientCapabilities: {}` —
no `fs/*` advertisement.

### What the worker host writes (web-acp/agent-worker.ts)

```ts
async function startAgentInWorker(port: MessagePort, volumes: HostVolumeInit[]) {
  const transport = createMessagePortStream(port);
  const provider = new BodhiProvider();
  const db = await openSessionDb();
  const registry = new ZenfsVolumeRegistry();

  for (const v of volumes) {
    await registry.mount(toAgentVolumeInit(v));
  }

  startAgent({
    transport,
    provider,
    registry,
    sessions: createStoreFromDb(db),
    features: createFeatureStore(db),
    mcpToggles: createMcpToggleStore(db),
    isDev: import.meta.env.DEV,
    buildVersion: appVersion,
  });
}
```

~96 LoC → ~25 LoC. No more `streamOverrides` ref, no
`createInlineAgent`/`createStreamFn`, no `assembleServices`, no
`attachVolumeChannel` (the volume-control sidechannel is gone with
`fs/*`).

### In-memory store defaults

So the host can pass *only* a `provider` and have a working agent,
the package ships internal in-memory implementations of
`SessionStore`, `FeatureStore`, and `McpToggleStore` at
`packages/web-acp-agent/src/storage/in-memory/`. They mirror the
shapes already in
`packages/cli-acp-client/src/services/stores.ts` (which we'll keep
as the model — small, well-tested). They are NOT exported on the
public barrel; they exist only to back the `??` defaults inside
`startAgent`. Hosts that need persistence ship their own (e.g.
`web-acp`'s Dexie-backed adapters).

## Files to modify

### Agent package (`packages/web-acp-agent/src/`)

| Path | Change |
| --- | --- |
| `bootstrap.ts` | **Delete.** Logic moves into `api/start-agent.ts`. |
| `api/start-agent.ts` | **New.** Implements `startAgent`. Inlines the inline-agent + stream-fn + assembleServices ritual; constructs `AcpAgentAdapter` without exposing it; returns `{ dispose }`. |
| `api/in-memory-duplex.ts` | **New.** ~6-line utility. |
| `api/types.ts` | **New.** Houses `AcpTransport`, `StartAgentOptions`, `StartAgentHandle`, `InMemoryDuplex`. |
| `acp/agent-adapter.ts` | Keep file. Drop from public barrel; add `@internal` JSDoc. No behavioural change. |
| `acp/engine/services.ts` | Keep `assembleServices` as a non-exported helper called by `start-agent.ts`. Drop from public barrel. |
| `acp/permissions.ts` | **Delete.** Permission flow removed end-to-end. |
| `agent/inline-agent.ts` | Keep file. Drop from public barrel. |
| `agent/stream-fn.ts` | Keep file. Drop from public barrel. `StreamOverridesRef` becomes a non-exported type used only by `start-agent.ts`. |
| `storage/in-memory/session-store.ts` | **New.** Port from `packages/cli-acp-client/src/services/stores.ts`. |
| `storage/in-memory/feature-store.ts` | **New.** |
| `storage/in-memory/mcp-toggle-store.ts` | **New.** |
| `storage/in-memory/index.ts` | **New.** Internal-only barrel. |
| `index.ts` | Rewrite per "the new public surface" listing above. |

### Browser host (`packages/web-acp/src/`)

| Path | Change |
| --- | --- |
| `agent/agent-worker.ts` | Replace ritual with single `startAgent({ ... })` call. Drop `streamOverrides` local state. Drop `attachVolumeChannel(scope, registry)` call (the volume-control channel goes away with `fs/*`). Worker shim shrinks ~96 → ~25 LoC. |
| `acp/runtime.ts` | Drop `wrapVolumeControl(...)` and the main-thread `MainZenfs` setup. Set `clientCapabilities: {}` in the `Client` handler. The handler keeps only `sessionUpdate` (no `requestPermission`) plus the existing `extNotification` / `_bodhi/*` notification routing. Remove the `fs/*` handler wiring. |
| `acp/permissions.ts` | **Delete.** Permission flow removed end-to-end. |
| `acp/fs-handlers.ts` | **Delete.** No more `fs/{read,write}TextFile` advertisement. |
| `vault/main-zenfs.ts` | **Delete.** Main-thread duplicate mount only existed to back fs-handlers. |
| `runtime/volumes-fsa/volume-channel.ts` | **Delete.** Worker-side mount/unmount listener only existed to keep the duplicate ZenFS in sync. |
| `runtime/volumes-fsa/volume-control.ts` | **Delete.** Main-thread client for the sync sidechannel. |
| `runtime/volumes-fsa/index.ts` | Drop the deleted modules' exports. |
| `hooks/useVolumes.ts` | Simplify — no more main-thread `MainZenfs` operations or volume-control round-trips. Volumes flow into the worker as part of the `init` message exactly as today; the worker's `ZenfsVolumeRegistry` is the only mount. Mount/unmount-after-init becomes a worker-side concern only; if the existing UX adds/removes volumes mid-session, that's a separate `MessagePort` message we'll add to the agent-worker init protocol (one inbound message type, no client-control sidechannel). |

The Dexie store wrappers (`runtime/storage-dexie/*`),
volume conversion (`runtime/volumes-fsa/{types,backends}.ts`),
transport bridge (`runtime/transport/worker-stream.ts`), and
main-thread `ClientSideConnection`/`AcpClient` wiring are
unchanged.

### CLI tutorial host (`packages/tutorial-cli-client/src/`)

| Path | Change |
| --- | --- |
| `agent/embed.ts` | Rewrite using `startAgent` + `createInMemoryDuplex` per the snippet above. 87 → ~40 LoC. |
| `agent/duplex.ts` | **Delete.** The package's `createInMemoryDuplex` replaces it. |

The CLI's command dispatcher (`dispatcher.ts`), auth flow
(`auth/`), bootstrap (`bootstrap.ts`), and emitter (`emitter.ts`)
are untouched.

### Documentation (must ship in the same change)

| Path | Change |
| --- | --- |
| `ai-docs/web-acp/guide/04-embedding-the-agent.md` | Rewrite. The "agent-side requirements" / "client-side requirements" framing stays; code samples flip to `startAgent` + `createInMemoryDuplex`. The §4.5 vitest-time alias note stays. |
| `ai-docs/web-acp/specs/web-acp-agent/index.md` | Update Public surface, Folder layout (`api/` added; `bootstrap.ts` removed), and Hard constraints sections. Mark dropped exports. |
| `ai-docs/web-acp/specs/web-acp-agent/acp.md` | Note `AcpAgentAdapter` is internal; `assembleServices` is internal. |
| `ai-docs/web-acp/specs/web-acp-client/index.md` | Update worker-shim description. Remove fs-handlers / MainZenfs / volume-channel / volume-control sections. |
| `ai-docs/web-acp/specs/web-acp-client/transport.md` | Remove the volume-control sidechannel rationale (no longer exists). |
| `ai-docs/web-acp/specs/web-acp-client/volumes.md` | Update — main-thread `MainZenfs` is gone; worker `ZenfsVolumeRegistry` is the only mount. |
| `ai-docs/web-acp/specs/web-acp-client/acp.md` | Drop the `fs-handlers.ts` description. Update `Client` handler shape. |
| `ai-docs/web-acp/steering/02-architecture.md` | Update "Filesystem posture (post just-bash)" — `fs/*` is no longer advertised; the IDE-integration seam is dropped. Update the layer-cake ASCII to remove client-side `fs/*` arrows. |
| `ai-docs/web-acp/milestones/index.md` | Update the "ACP compliance at a glance" table: filesystem row changes from "agent-owned; fs/* advertised but unused by built-ins" to "agent-owned; fs/* not advertised". |

The `cli-acp-client/index.md` and the `ws-acp-client` README are
intentionally NOT updated — those packages will be migrated
separately and the doc/code mismatch is the marker that they need
work.

## What we're explicitly NOT changing

- The ACP wire surface for everything except `clientCapabilities`.
  Every JSON-RPC method, notification, and `_bodhi/*` extension
  stays byte-identical.
- `BodhiProvider` and `LlmProvider`. The interface is intact; we
  keep `BodhiProvider` as the default impl bundled in the package.
  Future breakout into `@bodhiapp/web-acp-bodhi-provider` is a
  separate decision.
- The engine layer (`acp/engine/session-runtime.ts`,
  `prompt-driver.ts`, `builtin-dispatch.ts`, `replay.ts`,
  `ext-methods/`). Internal as today.
- The volume / commands / MCP / tools subsystems on the agent side.
  No behavioural change.
- The Dexie storage in `packages/web-acp/`. Hosts that want real
  persistence still ship their own `*Store` implementations.
- `packages/ws-acp-client/` and `packages/cli-acp-client/`. Out of
  scope.

## Verification

Both e2e suites are gate-checks. Tests are black-box; they MUST
pass without test-code changes.

1. **Agent package compiles + lints clean.**
   - `cd packages/web-acp-agent && npx tsgo --noEmit`
   - `cd packages/web-acp-agent && npm run check`
   - The grep guards in CI (no `@zenfs/dom`, `idb-keyval`, `dexie`,
     `MessagePort`, `Worker`, `FileSystemDirectoryHandle`,
     `navigator.storage`, `window.*` at runtime) still pass.

2. **Web-acp host: full e2e suite.**
   - `cd packages/web-acp && npm run check`
   - `cd packages/web-acp && npm test`
   - `cd packages/web-acp && npm run test:e2e` (mandatory per
     `CLAUDE.md`). Exercises React + worker + Dexie + LLM
     round-trip, plus volume mount/unmount UX. The new `startAgent`
     call must produce a functionally identical agent runtime; the
     `MainZenfs` removal must not break volume rendering or any
     UX that lists/inspects mounted volumes.

3. **CLI tutorial host: full e2e suite.**
   - `cd packages/tutorial-cli-client && npm run check`
   - `cd packages/tutorial-cli-client && npm test`
   - `cd packages/tutorial-cli-client && npm run test:e2e`
     - Single Playwright spec at `e2e/auth.spec.ts`: OAuth login
       round-trip + `/token` claims + `/bodhiapp:status` (which
       calls `BODHI_SERVER_INFO_METHOD` through the embedded
       agent) + `/quit`.

4. **Manual smoke** — `cd packages/web-acp && npm run dev`, mount a
   vault, send a prompt, watch the assistant reply. Confirms the
   `MainZenfs` removal didn't regress vault UX.

5. **Sanity grep** — confirm the new public surface is the only
   import path:
   `rg "from \"@bodhiapp/web-acp-agent\"" packages/web-acp/src/ packages/tutorial-cli-client/src/`
   should show only the symbols listed in the new barrel. Nothing
   imports `startAcpAgent`, `AcpAgentAdapter`, `assembleServices`,
   `createInlineAgent`, `createStreamFn`, `requestPermissionStub`,
   `StreamOverridesRef` anywhere outside the agent package itself.

## Sequencing

Land in one branch, four commits:

1. **Agent package: introduce new API and in-memory defaults.** Add
   `api/`, add `storage/in-memory/`, leave the old `bootstrap.ts`
   exports in place but mark deprecated. Both hosts unchanged.
2. **Web-acp: switch worker to `startAgent` + drop `fs/*`.** Switch
   `packages/web-acp/src/agent/agent-worker.ts` to the new API.
   Delete `acp/fs-handlers.ts`, `vault/main-zenfs.ts`,
   `runtime/volumes-fsa/volume-channel.ts`,
   `runtime/volumes-fsa/volume-control.ts`. Update
   `acp/runtime.ts`, `acp/permissions.ts`,
   `runtime/volumes-fsa/index.ts`, `hooks/useVolumes.ts`. Run
   `npm run test:e2e` to confirm green.
3. **Tutorial-cli-client: switch embed to new API.** Rewrite
   `agent/embed.ts`, delete `agent/duplex.ts`. Run
   `npm run test:e2e` to confirm green.
4. **Agent package: shrink the barrel + docs.** Delete
   `bootstrap.ts`; drop the dropped-symbol set from `index.ts`; add
   `@internal` JSDoc to former public types. Update all the doc
   files listed in "Documentation". Re-run both e2e suites.

If any e2e step fails, fix the host migration before proceeding —
do not weaken the new API to accommodate a host bug.
