# web-acp-agent

**Source of truth:** `packages/web-acp-agent/src/`.

**Status:** living document — update as part of any plan that
changes the source folder. The package shipped post-M4 phase B
as the **transport-agnostic ACP agent runtime**: same code
consumed by the browser-host worker (`packages/web-acp/`), the
Node TTY CLI (`packages/cli-acp-client/`), and a future
HTTP/SSE backend host.

> **ACP 0.21 migration delta (M1–M7).** The wire surface changed
> as part of the migration tracked at
> [`../../../plans/reviewed-the-acp-compliance-report-peaceful-journal.md`](../../../plans/reviewed-the-acp-compliance-report-peaceful-journal.md):
>
> - **Removed** wire constants: `BODHI_LIST_MODELS_METHOD`,
>   `BODHI_LIST_SESSIONS_METHOD`, `BODHI_FEATURES_LIST_METHOD`,
>   `BODHI_FEATURES_SET_METHOD`. Removed types:
>   `BodhiModelDescriptor`, `BodhiListModelsResponse`,
>   `BodhiSessionSummary`, `BodhiListSessionsResponse`,
>   `BodhiFeatureBag`, `BodhiFeaturesListResponse`,
>   `BodhiFeaturesSetRequest`, `BodhiFeaturesSetResponse`. Deleted
>   handlers: `ext-methods/{list-models,list-sessions,features-list,features-set}.ts`.
> - **Added** wire constants: `BODHI_MCP_STATE_NOTIFICATION_METHOD`
>   (`_bodhi/mcp/state`),
>   `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`
>   (`_bodhi/builtin/action`),
>   `BODHI_FEATURE_BASH_ENABLED_CONFIG_ID`,
>   `BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID`,
>   `BODHI_FEATURE_CONFIG_CATEGORY`. Added types:
>   `BodhiMcpStateNotificationParams`,
>   `BodhiBuiltinActionNotificationParams`,
>   `BodhiSessionInfoMeta`, `BodhiLoadSessionMeta`.
> - **Standard ACP methods now handled** (M1):
>   `Agent.listSessions`, `Agent.closeSession`,
>   `Agent.unstable_setSessionModel`,
>   `Agent.setSessionConfigOption` (boolean discriminator).
>   `InitializeResponse.agentInfo` stamped.
> - **Per-session model**: agent reads `currentModelId` from
>   `SessionState`. `_meta.bodhi.modelId` no longer consulted.
> - **MCP lifecycle**: `broadcastMcpPoolEvent` emits
>   `extNotification("_bodhi/mcp/state", ...)` instead of empty
>   `agent_message_chunk` with `_meta.bodhi.mcp`.
> - **Builtin actions**: `command` tag stays on
>   `agent_message_chunk._meta.bodhi.builtin`; the optional
>   `action` rides
>   `extNotification("_bodhi/builtin/action", ...)`.
> - **`bodhi/getSession` deferred (M5)** — still live in this
>   spec; collapse blocked by the agent's replay path only
>   re-emitting `'notification'` entries. See
>   `packages/web-acp/TECHDEBT.md` § "M5 deferred".
>
> Per-topic prose may not yet reflect every change above; trust the
> source tree where prose conflicts.

## Purpose

`@bodhiapp/web-acp-agent` is the runtime half of an
[Agent Client Protocol](https://agentclientprotocol.com/) (ACP)
agent. It owns:

- the **wire shim** that implements ACP's `Agent` interface;
- the **engine layer** (session lifecycle, prompt turn,
  built-in dispatch, `_bodhi/*` extension methods);
- the **`pi-agent-core` wrapper** + `pi-ai` provider plumbing
  (`InlineAgent`, `BodhiProvider`, `createStreamFn`);
- the **MCP** client + connection pool + tool adapter;
- the **`bash` tool** + `VolumeFileSystem` over ZenFS;
- the **vault command + built-in command** loaders / expander;
- the **storage interfaces** (`SessionStore`, `FeatureStore`,
  `McpToggleStore`) — host runtimes ship the implementations;
- the **`VolumeRegistry`** interface + a `ZenfsVolumeRegistry`
  default — host runtimes ship the FS factory;
- the **single `startAcpAgent(transport, services, options)`
  bootstrap** at `bootstrap.ts:startAcpAgent`.

The agent is consumed via byte-stream pairs (a `transport` of
`{ readable: ReadableStream<Uint8Array>, writable:
WritableStream<Uint8Array> }`) framed by the SDK's
`ndJsonStream`. Browser hosts wrap a `MessagePort`; Node hosts
wrap stdio / TransformStream pairs; HTTP/SSE hosts wrap an
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
  `agent-client-protocol/schema/schema.json`, plus the
  `_`-prefixed extension methods listed in `wire/index.ts`. No
  bespoke RPC.

## Public surface

The barrel at `packages/web-acp-agent/src/index.ts` is the only
import path consumers should reach for. Notable groupings:

- **Bootstrap.** `startAcpAgent`, `AcpTransport`,
  `StartAcpAgentOptions` (from `bootstrap.ts`).
- **Wire shim + engine.** `AcpAgentAdapter`,
  `AcpAgentAdapterOptions`, `AcpAdapterServices`,
  `AssembleServicesOptions`, `assembleServices`,
  `StreamOverridesRef`, `AcpSessionRuntime`, `ExtMethodHost`,
  `SessionState`, `requestPermissionStub`, plus the pure
  helpers in `acp/wire-utils.ts`.
- **LLM provider.** `BodhiProvider`, `BODHI_PROVIDER_TAG`,
  `apiFormatOfModel`, `LlmAuthCredential`, `LlmProvider`.
- **Inline agent.** `createInlineAgent`, `InlineAgent`,
  `InlineAgentSetModelOptions`.
- **Stream fn.** `createStreamFn`, `StreamOptionOverrides`,
  `StreamOverrideProvider`.
- **System prompt.** `composeSystemPrompt`.
- **Commands.** Vault loader / expander / front-matter parser
  + the type set (`CommandDef`, `CommandSource`, `CommandsFs`,
  `CommandsFsEntry`, `CommandsLoaderInput`,
  `canonicalCommandName`, `createZenfsCommandsFs`,
  `ExpansionResult`, `expandCommand`, `FrontMatter`,
  `loadCommandsFromVolumes`, `loadPromptsFromVolumes`,
  `ParseResult`, `PROMPTS_DIR_RELPATH`,
  `COMMANDS_DIR_RELPATH`, `parseFrontMatter`,
  `tokenizeBash`, `InvalidCommandPathError`, `isValidSegment`,
  `FrontMatterError`, `CanonicalNameInput`).
- **Built-ins.** `BuiltinAction`, `BuiltinCommand`,
  `BuiltinHandlerCtx`, `BuiltinMcpInstance`, `BuiltinResult`,
  `builtinAvailableCommands`, `findBuiltin`, `isBuiltinName`,
  `BUILTIN_COMMANDS`.
- **MCP runtime.** `createMcpClient`, `createMcpAgentTool`,
  `McpConnectionPool`, `mcpToolName`,
  `MCP_TOOL_NAME_SEPARATOR`, plus the descriptor / event /
  pool-listener types.
- **Tools.** `createBashTool`, `BASH_OUTPUT_BYTE_LIMIT`,
  `VolumeFileSystem`, plus `BashToolDeps`, `BashToolDetails`,
  `BashToolInput`.
- **Volumes.** `VolumeInit`, `VolumeRegistry`,
  `VolumeRegistryListener`, `VolumeSnapshot`,
  `ZenfsVolumeRegistry`.
- **Storage interfaces (host implements).** `SessionStore`,
  `SessionEntry`, `SessionEntryKind`, `SessionRow`,
  `SessionSummary`, `TurnPayload`, `BuiltinPayload`,
  `FeatureRow`, `McpTogglesRow`, `deriveTitle`;
  `FeatureStore`, `FeatureDefaults`, `FeatureKey`,
  `FeatureSnapshot`, `FEATURE_DEFAULTS`, `isFeatureKey`;
  `McpToggleStore`, `McpToggleSnapshot`, `EMPTY_MCP_TOGGLES`,
  `isServerEnabled`, `isToolEnabled`.
- **Wire constants + types.** Re-exported via `wire/index.ts`:
  `BODHI_AUTH_METHOD_ID`, `BODHI_LIST_MODELS_METHOD`,
  `BODHI_LIST_SESSIONS_METHOD`, `BODHI_GET_SESSION_METHOD`,
  `BODHI_VOLUMES_LIST_METHOD`, `BODHI_FEATURES_LIST_METHOD`,
  `BODHI_FEATURES_SET_METHOD`,
  `BODHI_MCP_TOGGLES_SET_METHOD`,
  `BODHI_SESSIONS_DELETE_METHOD`, plus every Bodhi*
  request/response shape and the `BodhiBuiltinAction<K, P>`
  discriminated-union family (`BodhiBuiltinCopyAction`,
  `BodhiBuiltinMcpAddAction`, `BodhiBuiltinMcpRemoveAction`,
  `AnyBodhiBuiltinAction`, `BodhiBuiltinMeta`,
  `BodhiBuiltinTag`).
- **Misc.** `canonicalizeMcpUrl`, `deriveSlugFromUrl`.

> Engine internals (`PromptTurnDriver`, `AcpSessionRuntime`,
> `ExtMethodHost`, `SessionState`, the per-handler
> ext-method modules, `assembleServices`) are documented in
> `acp.md` for orientation but are **not** re-exported on the
> public barrel — consumers should never import them directly
> from `@bodhiapp/web-acp-agent`.

## Folder layout

```
packages/web-acp-agent/src/
├── index.ts                       # public barrel
├── bootstrap.ts                   # startAcpAgent(transport, services, options)
├── acp/
│   ├── agent-adapter.ts           # AcpAgentAdapter — Agent-interface dispatch shim
│   ├── permissions.ts             # requestPermissionStub (deferred)
│   ├── wire-utils.ts              # pure ACP wire helpers (extractSessionMeta, …)
│   └── engine/                    # engine layer
│       ├── services.ts            # AcpAdapterServices + assembleServices()
│       ├── session-runtime.ts     # AcpSessionRuntime — per-session lifecycle owner
│       ├── prompt-driver.ts       # PromptTurnDriver — single prompt-turn loop
│       ├── builtin-dispatch.ts    # tryHandleBuiltin (early-return before LLM)
│       ├── types.ts               # SessionState, ExtMethodHost
│       └── ext-methods/           # handler-per-file: 6 use `_bodhi/*` (features-list, features-set, mcp-toggles-set, sessions-delete, volumes-list); 3 use legacy `bodhi/*` (list-models, list-sessions, get-session)
│           ├── index.ts           # dispatchExtMethod(method, params) registry
│           ├── list-models.ts, list-sessions.ts, get-session.ts
│           ├── volumes-list.ts
│           ├── features-list.ts, features-set.ts
│           ├── mcp-toggles-set.ts
│           └── sessions-delete.ts
├── agent/
│   ├── inline-agent.ts            # createInlineAgent — pi-agent-core wrapper
│   ├── bodhi-provider.ts          # BodhiProvider (LlmProvider impl) + flatten logic
│   ├── stream-fn.ts               # createStreamFn(provider) — pi-ai bridge
│   ├── system-prompt.ts           # composeSystemPrompt(volumes)
│   ├── volume-registry.ts         # VolumeInit, VolumeRegistry, ZenfsVolumeRegistry
│   ├── commands/
│   │   ├── loader.ts              # loadCommandsFromVolumes / loadPromptsFromVolumes
│   │   ├── expander.ts            # expandCommand
│   │   ├── front-matter.ts        # parseFrontMatter (minimal YAML)
│   │   ├── path.ts                # canonicalCommandName <mount>:<name>
│   │   ├── types.ts               # CommandDef, CommandSource, …
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
│   ├── feature-store.ts           # FeatureStore interface + FEATURE_DEFAULTS
│   └── mcp-toggle-store.ts        # McpToggleStore interface + helpers
├── mcp/
│   └── url-canonical.ts           # canonicalizeMcpUrl, deriveSlugFromUrl
├── wire/
│   └── index.ts                   # ACP method constants + Bodhi* request/response shapes (the canonical barrel; consumers import from the package root via `src/index.ts`)
└── test-utils/                    # vitest helpers (`seed-volume`, `setup`); exposed via the `./test-utils` package export
    ├── seed-volume.ts             # InMemory + ZenFS test helper
    └── setup.ts                   # vitest global setup
```

The split is deliberate: `acp/` is the wire surface, `agent/`
is the runtime, `storage/` defines the host-implementable
interfaces, `mcp/` + `wire/` are shared types. Every file
reachable through `index.ts` is part of the public contract;
everything else is internal.

## Global guarantees & invariants

1. **ACP-only across the boundary.** After the host hands the
   transport to `startAcpAgent`, every byte across the stream
   pair is `ndJsonStream`-framed JSON-RPC 2.0. No bespoke
   side channel.
2. **Single `init` per host.** The transport is set up once;
   `startAcpAgent` returns the live `AgentSideConnection`. No
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
   `forceToolCall` is the canonical example — the agent throws
   when a non-DEV host tries to enable it.

## Navigation

| File | Scope |
| --- | --- |
| [`acp.md`](./acp.md) | `acp/agent-adapter.ts:AcpAgentAdapter` (wire shim) + the engine layer in `acp/engine/` (services, session-runtime, prompt-driver, builtin-dispatch, ext-methods/). |
| [`agent.md`](./agent.md) | `agent/inline-agent.ts`, `agent/bodhi-provider.ts`, `agent/stream-fn.ts`, `agent/system-prompt.ts`. The `LlmProvider` interface lives in `bodhi-provider.ts` alongside the default impl. |
| [`sessions.md`](./sessions.md) | `storage/session-store.ts:SessionStore` interface + entry shapes (`SessionEntry`, `TurnPayload`, `BuiltinPayload`, `SessionRow`, `SessionSummary`) + the agent's replay contract for `session/load`. |
| [`volumes.md`](./volumes.md) | `agent/volume-registry.ts` — `VolumeInit`, `VolumeRegistry`, `ZenfsVolumeRegistry`. |
| [`tools.md`](./tools.md) | `agent/tools/bash-tool.ts:createBashTool` + `agent/tools/volume-filesystem.ts:VolumeFileSystem`. |
| [`commands.md`](./commands.md) | `agent/commands/` — vault commands (loader / expander / front-matter / path) + `agent/commands/builtins/` (`/help`, `/version`, `/info`, `/copy`, `/mcp`). |
| [`features.md`](./features.md) | `storage/feature-store.ts:FeatureStore` interface + `FEATURE_DEFAULTS` + `isFeatureKey` + the agent-side `_bodhi/features/*` handlers. |
| [`mcp.md`](./mcp.md) | `agent/mcp/` — client / connection pool / tool adapter. `storage/mcp-toggle-store.ts:McpToggleStore` interface + `_bodhi/mcp/toggles/set` handler. `mcp/url-canonical.ts`. |
| [`startup-sequence.md`](./startup-sequence.md) | Host-neutral ACP boot + per-session lifecycle. The wire-flow narrative valid for any host (browser, CLI, future HTTP). |

## Host runtimes that consume this package

- `packages/web-acp/` — browser host, Web Worker transport. Spec at [`../web-acp-client/index.md`](../web-acp-client/index.md).
- `packages/cli-acp-client/` — Node TTY host, in-memory `TransformStream` duplex. Spec at [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
- *Future:* HTTP/SSE host, Node stdio host. Same `startAcpAgent` entry point.

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
