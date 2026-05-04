# web-acp-agent

**Source of truth:** `packages/web-acp-agent/src/`.

**Status:** living document — update as part of any plan that
changes the source folder. The package ships as the
**transport-agnostic ACP agent runtime** consumed by the browser
host (`packages/web-acp/`), the Node TTY CLI
(`packages/cli-acp-client/`), and any future host (HTTP/SSE,
Node stdio).

## Purpose

`@bodhiapp/web-acp-agent` is the runtime half of an
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP)
agent. It owns:

- the **wire shim** that implements ACP's `Agent` interface;
- the **per-handler ACP method files** under `acp/handlers/`
  (`initialize`, `authenticate`, the session CRUD verbs,
  `setSessionConfigOption`, `unstable_setSessionModel`, `cancel`);
- the **engine layer** (session lifecycle, prompt turn,
  built-in dispatch, the small `_bodhi/*` extension-method
  registry);
- the **`pi-agent-core` wrapper** + `pi-ai` provider plumbing
  (`InlineAgent`, `BodhiProvider`, `createStreamFn`);
- the **MCP** client + connection pool + tool adapter;
- the **`bash` tool** + `VolumeFileSystem` over ZenFS;
- the **vault command + built-in command** loaders / expander;
- the **storage interfaces** (`SessionStore`, `FeatureStore`,
  `McpToggleStore`) — host runtimes ship the implementations;
- the **`VolumeRegistry`** interface + a `ZenfsVolumeRegistry`
  default — host runtimes ship the FS factory;
- the **single `startAgent({ transport, provider, ... })`
  bootstrap** at `api/start-agent.ts` plus an in-process
  `createInMemoryDuplex()` utility for embedded hosts.

The agent is consumed via byte-stream pairs (a `transport` of
`{ readable: ReadableStream<Uint8Array>, writable:
WritableStream<Uint8Array> }`) framed by the SDK's
`ndJsonStream`. Browser hosts wrap a `MessagePort`; Node hosts
wrap stdio / `TransformStream` pairs; HTTP/SSE hosts wrap an
SSE response. The framing layer never sees the transport
directly — it only sees the stream pair.

## Hard constraints

- **No browser-only runtime deps.** No `@zenfs/dom`,
  `idb-keyval`, `dexie`, `MessagePort`, `Worker`,
  `FileSystemDirectoryHandle`, `navigator.storage`, or
  `window.*` referenced at runtime. Verified by grep guards in
  CI. Concrete runtime deps allowed: `@agentclientprotocol/sdk`,
  `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`,
  `@modelcontextprotocol/sdk`, `@sinclair/typebox`,
  `@zenfs/core`, `just-bash`, `zod` (see
  `packages/web-acp-agent/package.json`).
  `@bodhiapp/bodhi-js-react` lives in `devDependencies` —
  the agent uses `import type` only against
  `@bodhiapp/bodhi-js-react/api` so the type-shape lookup
  doesn't bring browser-only React code into the runtime.
- **No node-only deps either.** The agent runs in a Web Worker
  today; that runtime has no `fs`, `child_process`, `path`, or
  any other node-builtin. Future Node hosts can supply ZenFS
  backends that wrap node `fs` (see
  `packages/cli-acp-client/src/services/cwd-volume.ts` for the
  `PassthroughFS` pattern); the agent itself stays pure.
- **No React.** UI is the host's job; the agent emits ACP
  notifications and answers ACP requests, nothing else.
- **ACP is the wire protocol.** Every host ↔ agent message is a
  request, response, or notification defined by
  `agent-client-protocol/schema/schema.json`, plus the small
  `_bodhi/*` extension surface listed in
  `acp/engine/ext-methods/index.ts:HANDLERS` and the two
  `_bodhi/*` notifications listed in `wire/index.ts`. No
  bespoke RPC.

## Public surface

The barrel at `packages/web-acp-agent/src/index.ts` is the only
import path production hosts should reach for. Notable groupings
(the file is the source of truth — read it when wiring a host):

- **Boot.** `startAgent`, `createInMemoryDuplex` (from `api/`).
- **Boot types.** `AcpTransport`, `StartAgentOptions`,
  `StartAgentHandle`, `InMemoryDuplex`.
- **LLM provider.** `BodhiProvider`, `BODHI_PROVIDER_TAG`,
  `apiFormatOfModel`, `LlmAuthCredential`, `LlmProvider`.
- **Volumes.** `VolumeInit`, `VolumeRegistry`,
  `ZenfsVolumeRegistry`, `VolumeRegistryListener`,
  `VolumeSnapshot`. Hosts construct the registry, pre-mount,
  and pass it to `startAgent({ registry })` so multi-connection
  hosts can share one registry across calls (see
  [volumes.md](volumes.md) for rationale).
- **Commands surface for host UIs.** `canonicalCommandName`,
  `COMMANDS_DIR_RELPATH`, `PROMPTS_DIR_RELPATH`, `CommandDef`,
  `CommandSource`, `FrontMatter`, `builtinAvailableCommands`,
  `isBuiltinName`.
- **Storage interfaces (host implements).** `SessionStore`,
  `SessionEntry`, `SessionEntryKind`, `SessionRow`,
  `SessionSummary`, `TurnPayload`, `BuiltinPayload`,
  `deriveTitle`; `PreferenceStore` (unifies legacy
  `FeatureStore` + `McpToggleStore`); `FeatureDefaults`,
  `FeatureKey`, `FeatureSnapshot`, `FEATURE_DEFAULTS`,
  `isFeatureKey`; `McpToggleSnapshot`, `EMPTY_MCP_TOGGLES`,
  `isServerEnabled`, `isToolEnabled`.
- **Wire constants.** Re-exported from `wire/index.ts`:
  `BODHI_AUTH_METHOD_ID`,
  `BODHI_VOLUMES_LIST_METHOD`,
  `BODHI_MCP_TOGGLES_SET_METHOD`,
  `BODHI_SESSIONS_DELETE_METHOD`,
  `BODHI_MCP_STATE_NOTIFICATION_METHOD`,
  `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`,
  `BODHI_FEATURE_BASH_ENABLED_CONFIG_ID`,
  `BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID`,
  `BODHI_FEATURE_CONFIG_CATEGORY`.
- **Wire types.** `BodhiAuthenticateMeta`,
  `BodhiAuthenticateResponseMeta`,
  `BodhiVolumeDescriptor`, `BodhiVolumesListResponse`,
  `BodhiMcpToggleSnapshot`,
  `BodhiMcpTogglesSetRequest/Response`,
  `BodhiSessionsDeleteRequest/Response`,
  `BodhiServerInfoResponse` (the value type the host casts
  `_meta.bodhi.providerInfo` to),
  `BodhiMcpStateNotificationParams`,
  `BodhiBuiltinActionNotificationParams`,
  `BodhiBuiltinAction<K, P>` family
  (`BodhiBuiltinCopyAction`, `BodhiBuiltinMcpAddAction`,
  `BodhiBuiltinMcpRemoveAction`, `AnyBodhiBuiltinAction`,
  `BodhiBuiltinTag`, `BodhiMcpUrlParams`),
  `BodhiMcpInstanceDescriptor`, `BodhiSessionMeta`,
  `BodhiSessionInfoMeta`, `BodhiLoadSessionMeta`.
- **Misc.** `canonicalizeMcpUrl`, `deriveSlugFromUrl`.

> SDK types (e.g. `Agent`, `Client`, `LoadSessionRequest`) are
> intentionally **not** re-exported. Consumers import them
> directly from `@agentclientprotocol/sdk`.
>
> **Test-only surface** is exported separately at
> `@bodhiapp/web-acp-agent/test-utils`: `AcpAgentAdapter`,
> `AcpAgentAdapterOptions`, `AcpAdapterServices`,
> `AssembleServicesOptions`, `assembleServices`,
> `createInlineAgent`, `InlineAgent`, `createStreamFn`,
> `McpConnectionPool`, `CommandsFs`, `CommandsFsEntry`,
> `createZenfsCommandsFs`, `createInMemoryPreferenceStore`,
> `mcpToggleStoreOverPreferences`, `SeedSpec`, `buildSeedInit`.
> Host test suites use these to drive the engine layer directly
> without going through `startAgent`. Production code never
> imports them.
>
> Engine internals (`AcpSessionRuntime`, `PromptTurnDriver`,
> `ExtMethodHost`, `SessionState`, the per-handler ACP method
> modules under `acp/handlers/`, the `_bodhi/*` ext-method
> modules, `walkEntries`, `composeSystemPrompt`, the
> `BUILTIN_COMMANDS` registry, `findBuiltin`, `tokenizeBash`,
> `VolumeFileSystem`, the `agent/internal/{feature,mcp-toggle}-prefs.ts`
> typed accessors over `PreferenceStore`, stream-fn options,
> the bash-tool internals, all command loader/expander helpers)
> are documented in the topic files for orientation but are
> **not** exported anywhere.
>
> Permission flow has been removed entirely (no
> `requestPermissionStub`, no agent-side permission plumbing) —
> the SDK still requires `Client.requestPermission` so each host
> inlines a one-line cancelled-outcome stub.
>
> `_bodhi/server/info` extension method removed in the
> `provider-agnostic-embed-simplification` plan. The connectivity
> probe now rides as a side effect of `LlmProvider.setAuthToken`,
> surfacing on `AuthenticateResponse._meta.bodhi.providerInfo`.
>
> `_bodhi/session/get` (and its legacy un-prefixed alias
> `bodhi/getSession`) removed in the post-2026-05-04 ACP-compliance
> sweep. Transcript + toggles ride natively on
> `LoadSessionResponse._meta.bodhi.{messages, mcpToggles, title}`
> per `BodhiLoadSessionMeta`. `Agent.listSessions` now honours
> cursor pagination — cursor is base64(`page=N&per_page=10&
> sort_by=updated_at&sort_seq=desc`); see
> `acp/handlers/list-sessions-cursor.ts`.

## Folder layout

```
packages/web-acp-agent/src/
├── index.ts                       # public barrel (production hosts)
├── api/
│   ├── start-agent.ts             # startAgent({ transport, provider, ... })
│   ├── in-memory-duplex.ts        # createInMemoryDuplex() utility
│   ├── types.ts                   # AcpTransport, StartAgentOptions, StartAgentHandle, InMemoryDuplex
│   ├── sdk-version.ts             # internal: pinned ACP SDK version string
│   └── index.ts                   # api barrel
├── acp/
│   ├── agent-adapter.ts           # AcpAgentAdapter — thin Agent-interface dispatch
│   ├── feature-config.ts          # SessionConfigOption builder + configId↔key map
│   ├── wire-utils.ts              # pure ACP wire helpers
│   ├── handlers/                  # per-method ACP handlers (one file per concern)
│   │   ├── adapter-context.ts     # AcpAdapterContext shared bag + model helpers
│   │   ├── initialize.ts          # initialize / authenticate
│   │   └── session-crud.ts        # newSession / loadSession / listSessions /
│   │                              #   closeSession / unstable_setSessionModel /
│   │                              #   setSessionConfigOption / cancel
│   └── engine/                    # engine layer
│       ├── services.ts            # AcpAdapterServices + assembleServices()
│       ├── session-runtime.ts     # AcpSessionRuntime — per-session lifecycle owner
│       ├── prompt-driver.ts       # PromptTurnDriver — single prompt-turn loop
│       ├── builtin-dispatch.ts    # tryHandleBuiltin (early-return before LLM)
│       ├── replay.ts              # walkEntries(entries, callbacks) — shared replay walker
│       ├── types.ts               # SessionState, ExtMethodHost
│       └── ext-methods/           # _bodhi/* extension methods
│           ├── index.ts           # dispatchExtMethod(method, params, host)
│           ├── schemas.ts         # Zod validators
│           ├── volumes-list.ts    # _bodhi/volumes/list
│           ├── mcp-toggles-set.ts # _bodhi/mcp/toggles/set (writes through PreferenceStore)
│           └── sessions-delete.ts # _bodhi/sessions/delete
├── agent/
│   ├── inline-agent.ts            # createInlineAgent — pi-agent-core wrapper
│   ├── bodhi-provider.ts          # BodhiProvider (LlmProvider impl); setAuthToken pings /info
│   ├── stream-fn.ts               # createStreamFn(provider) — pi-ai bridge
│   ├── system-prompt.ts           # composeSystemPrompt(volumes)
│   ├── volume-registry.ts         # VolumeInit + VolumeRegistry/ZenfsVolumeRegistry (public — host pre-mounts, passes to startAgent)
│   ├── internal/                  # typed accessors over PreferenceStore (engine-only)
│   │   ├── feature-prefs.ts       # readFeatureSnapshot / writeFeature
│   │   └── mcp-toggle-prefs.ts    # readMcpToggles / setMcpServerToggle / setMcpToolToggle
│   ├── commands/
│   │   ├── loader.ts              # loadCommandsFromVolumes / loadPromptsFromVolumes
│   │   ├── expander.ts            # expandCommand
│   │   ├── front-matter.ts        # parseFrontMatter (minimal YAML-ish)
│   │   ├── path.ts                # canonicalCommandName <mount>:<name>
│   │   ├── types.ts               # CommandDef, CommandSource
│   │   ├── index.ts               # barrel
│   │   └── builtins/
│   │       ├── index.ts           # registry + isBuiltinName / findBuiltin
│   │       ├── types.ts           # BuiltinHandler, BuiltinHandlerCtx, …
│   │       └── help.ts, version.ts, info.ts, copy.ts, mcp.ts
│   ├── mcp/
│   │   ├── client.ts              # createMcpClient (Streamable HTTP)
│   │   ├── connection-pool.ts     # McpConnectionPool (refcounted)
│   │   ├── tool-adapter.ts        # createMcpAgentTool
│   │   └── index.ts               # barrel
│   └── tools/
│       ├── bash-tool.ts           # createBashTool — single LLM-facing tool
│       └── volume-filesystem.ts   # VolumeFileSystem — IFileSystem over ZenFS
├── storage/
│   ├── session-store.ts           # SessionStore interface + entry/row shapes
│   ├── preference-store.ts        # PreferenceStore interface (sessionId+key → unknown)
│   ├── feature-defaults.ts        # FeatureKey, FeatureSnapshot, FEATURE_DEFAULTS, isFeatureKey
│   ├── mcp-toggle-shape.ts        # McpToggleSnapshot, EMPTY_MCP_TOGGLES, isServerEnabled, isToolEnabled
│   └── in-memory/                 # internal default impls used when host omits a store
│       ├── session-store.ts
│       ├── preference-store.ts
│       ├── preference-adapters.ts # mcpToggleStoreOverPreferences (test-utils only)
│       └── index.ts
├── mcp/
│   └── url-canonical.ts           # canonicalizeMcpUrl, deriveSlugFromUrl
├── wire/
│   └── index.ts                   # ACP method/notification constants + Bodhi*
│                                  #   request/response/notification shapes
└── test-utils/                    # vitest helpers + advanced engine surface
    ├── seed-volume.ts             # InMemory + ZenFS test helper
    ├── setup.ts                   # vitest global setup (Worker shim)
    └── index.ts                   # SeedSpec, buildSeedInit, AcpAgentAdapter,
                                   #   assembleServices, InlineAgent, McpConnectionPool,
                                   #   CommandsFs, createZenfsCommandsFs (test-only)
```

The split is deliberate: `acp/` is the wire surface (with
`handlers/` for the standard ACP methods and `engine/` for the
per-session machinery), `agent/` is the LLM-driving runtime,
`storage/` defines the host-implementable interfaces, and
`mcp/` + `wire/` are shared types. Every file reachable through
`index.ts` is part of the public contract; everything else is
internal.

## Global guarantees & invariants

1. **ACP-only across the boundary.** After the host hands the
   transport to `startAgent`, every byte across the stream
   pair is `ndJsonStream`-framed JSON-RPC 2.0. The two
   `extNotification` channels (`_bodhi/mcp/state`,
   `_bodhi/builtin/action`) and the small `_bodhi/*`
   ext-method surface ride the same JSON-RPC stream. No
   bespoke side channel.
2. **Single bootstrap per host.** The transport is set up once;
   `startAgent` returns the live `AgentSideConnection`. No
   re-init protocol.
3. **Structured-clone safety.** Every payload is plain JSON.
   No closures, class instances with methods, or non-cloneable
   values cross the boundary — important for browser
   `MessagePort` hosts and for any future
   `postMessage`-shaped transport.
4. **Storage interfaces are host-pluggable.** `SessionStore`,
   `FeatureStore`, `McpToggleStore` are interfaces only in this
   package. Host runtimes ship Dexie/IndexedDB
   (`packages/web-acp/src/runtime/storage-dexie/`), in-memory
   (`packages/cli-acp-client/src/services/stores.ts`), or
   future SQLite implementations.
5. **`VolumeRegistry` is host-pluggable.** The default
   `ZenfsVolumeRegistry` works for any ZenFS-shaped backend;
   hosts construct the FS instances and pass them inside
   `VolumeInit{ fs, initialize? }`.
6. **`LlmProvider` is host-overridable.** `BodhiProvider` is
   the default; alternate providers implement the same
   interface (`getApiKeyAndHeaders`, `getAvailableModels`,
   optional `setAuthToken`).
7. **DEV-only feature gates ride `AcpAgentAdapterOptions.isDev`.**
   `forceToolCall` is the canonical example — the agent
   throws JSON-RPC error `-32004` when a non-DEV host tries to
   enable it via `setSessionConfigOption`.

## Navigation

| File | Scope |
| --- | --- |
| [`acp.md`](./acp.md) | `acp/agent-adapter.ts:AcpAgentAdapter` (wire shim) + the per-handler files under `acp/handlers/` (initialize/authenticate, session CRUD, `setSessionConfigOption`, `unstable_setSessionModel`, `cancel`) + the engine layer in `acp/engine/` (services, session-runtime, prompt-driver, builtin-dispatch, replay, ext-methods/) + `acp/wire-utils.ts` + `acp/permissions.ts`. |
| [`agent.md`](./agent.md) | `agent/inline-agent.ts`, `agent/bodhi-provider.ts`, `agent/stream-fn.ts`, `agent/system-prompt.ts`. The `LlmProvider` interface lives in `bodhi-provider.ts` alongside the default impl. |
| [`sessions.md`](./sessions.md) | `storage/session-store.ts:SessionStore` interface + entry shapes (`SessionEntry`, `TurnPayload`, `BuiltinPayload`, `SessionRow`, `SessionSummary`) + the agent's replay contract for `loadSession`. |
| [`volumes.md`](./volumes.md) | `agent/volume-registry.ts` — `VolumeInit`, `VolumeRegistry`, `ZenfsVolumeRegistry`. |
| [`tools.md`](./tools.md) | `agent/tools/bash-tool.ts:createBashTool` + `agent/tools/volume-filesystem.ts:VolumeFileSystem`. |
| [`commands.md`](./commands.md) | `agent/commands/` — vault commands (loader / expander / front-matter / path) + `agent/commands/builtins/` (`/help`, `/version`, `/info`, `/copy`, `/mcp`). |
| [`features.md`](./features.md) | `storage/feature-store.ts:FeatureStore` interface + `FEATURE_DEFAULTS` + `isFeatureKey` + the `acp/feature-config.ts` builder + the `Agent.setSessionConfigOption` flow handled in `handlers/session-crud.ts`. |
| [`mcp.md`](./mcp.md) | `agent/mcp/` — client / connection pool / tool adapter. `storage/mcp-toggle-store.ts:McpToggleStore` interface + `_bodhi/mcp/toggles/set` handler. `_bodhi/mcp/state` notification surface. `mcp/url-canonical.ts`. |
| [`startup-sequence.md`](./startup-sequence.md) | Host-neutral ACP boot + per-session lifecycle. The wire-flow narrative valid for any host (browser, CLI, future HTTP). |

## Host runtimes that consume this package

- `packages/web-acp/` — browser host, Web Worker transport. Spec at [`../web-acp-client/index.md`](../web-acp-client/index.md).
- `packages/cli-acp-client/` — Node TTY host, in-memory `TransformStream` duplex. Spec at [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
- *Future:* HTTP/SSE host, Node stdio host. Same `startAgent` entry point.

## Change procedure

Any plan that modifies files under
`packages/web-acp-agent/src/` MUST include an explicit task to
update the matching topic file(s) in this folder. State that
task in the plan, not as a follow-up. When the surface is
unchanged (pure internal refactor), state that explicitly in
the plan rather than skipping the check.

Editing checklist:

1. Identify which topic file(s) cover the affected code.
2. Update content in the same commit as the code change.
3. If a new module is added (e.g. a new `_bodhi/*` extension
   method, a second LLM provider implementation), create a new
   topic file or extend the relevant one and link it from this
   `index.md`.
4. If a topic file becomes dead (a module is deleted), remove
   the file and update navigation.

See repo `CLAUDE.md § Functional specs` for the hard rule.
