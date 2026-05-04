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
- the **single `startAcpAgent(transport, services, options)`
  bootstrap** at `bootstrap.ts:startAcpAgent`.

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
import path consumers should reach for. Notable groupings (the
file is the source of truth — read it directly when wiring a
host):

- **Bootstrap.** `startAcpAgent`, `AcpTransport`,
  `StartAcpAgentOptions` (from `bootstrap.ts`).
- **Wire shim.** `AcpAgentAdapter`, `AcpAgentAdapterOptions`.
- **Services bag + assembly.** `AcpAdapterServices`,
  `AssembleServicesOptions`, `assembleServices`,
  `StreamOverridesRef`.
- **Permissions stub.** `requestPermissionStub` (returns
  `cancelled`; see [`acp.md`](./acp.md) § permissions).
- **Pure wire helpers.** `toAvailableCommand`, `toolTitle`.
- **LLM provider.** `BodhiProvider`, `BODHI_PROVIDER_TAG`,
  `apiFormatOfModel`, `LlmAuthCredential`, `LlmProvider`.
- **Inline agent.** `createInlineAgent`, `InlineAgent`,
  `InlineAgentSetModelOptions`.
- **Stream fn.** `createStreamFn`, `StreamOptionOverrides`,
  `StreamOverrideProvider`.
- **Commands.** Vault loader / expander / front-matter parser
  + the type set (`CommandDef`, `CommandSource`, `CommandsFs`,
  `CommandsFsEntry`, `CommandsLoaderInput`,
  `canonicalCommandName`, `createZenfsCommandsFs`,
  `ExpansionResult`, `expandCommand`, `FrontMatter`,
  `loadCommandsFromVolumes`, `loadPromptsFromVolumes`,
  `ParseResult`, `PROMPTS_DIR_RELPATH`,
  `COMMANDS_DIR_RELPATH`, `parseFrontMatter`).
- **Built-ins.** `BuiltinAction`, `BuiltinCommand`,
  `BuiltinHandlerCtx`, `BuiltinMcpInstance`, `BuiltinResult`,
  `builtinAvailableCommands`, `findBuiltin`, `isBuiltinName`.
- **MCP runtime.** `createMcpClient`, `createMcpAgentTool`,
  `McpConnectionPool`, `mcpToolName`,
  `MCP_TOOL_NAME_SEPARATOR`, plus the descriptor / event /
  pool-listener types.
- **Tools.** `createBashTool`, `BASH_OUTPUT_BYTE_LIMIT`,
  `BashToolDeps`, `BashToolDetails`, `BashToolInput`. (Note:
  `VolumeFileSystem` is internal to the bash tool and is not
  re-exported; consumers don't construct it directly.)
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
- **Wire constants.** Re-exported from `wire/index.ts`:
  `BODHI_AUTH_METHOD_ID`,
  `BODHI_GET_SESSION_METHOD`,
  `BODHI_GET_SESSION_METHOD_LEGACY`,
  `BODHI_VOLUMES_LIST_METHOD`,
  `BODHI_MCP_TOGGLES_SET_METHOD`,
  `BODHI_SESSIONS_DELETE_METHOD`,
  `BODHI_SERVER_INFO_METHOD`,
  `BODHI_MCP_STATE_NOTIFICATION_METHOD`,
  `BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`,
  `BODHI_FEATURE_BASH_ENABLED_CONFIG_ID`,
  `BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID`,
  `BODHI_FEATURE_CONFIG_CATEGORY`.
- **Wire types.** `BodhiAuthenticateMeta`,
  `BodhiGetSessionRequest/Response`,
  `BodhiVolumeDescriptor`, `BodhiVolumesListResponse`,
  `BodhiMcpToggleSnapshot`,
  `BodhiMcpTogglesSetRequest/Response`,
  `BodhiSessionsDeleteRequest/Response`,
  `BodhiServerInfoResponse`,
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
> directly from `@agentclientprotocol/sdk`. See the comment at
> `packages/web-acp-agent/src/index.ts:123`.
>
> Engine internals (`AcpSessionRuntime`, `PromptTurnDriver`,
> `ExtMethodHost`, `SessionState`, the per-handler ACP method
> modules under `acp/handlers/`, the `_bodhi/*` ext-method
> modules, `walkEntries`, `composeSystemPrompt`, the
> `BUILTIN_COMMANDS` registry, `tokenizeBash`,
> `VolumeFileSystem`) are documented in the topic files for
> orientation but are **not** re-exported on the public barrel —
> consumers should never import them directly from
> `@bodhiapp/web-acp-agent`.

## Folder layout

```
packages/web-acp-agent/src/
├── index.ts                       # public barrel
├── bootstrap.ts                   # startAcpAgent(transport, services, options)
├── acp/
│   ├── agent-adapter.ts           # AcpAgentAdapter — thin Agent-interface dispatch
│   ├── feature-config.ts          # SessionConfigOption builder + configId↔key map
│   ├── permissions.ts             # requestPermissionStub (returns cancelled)
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
│       └── ext-methods/           # six _bodhi/* + legacy bodhi/getSession
│           ├── index.ts           # dispatchExtMethod(method, params, host)
│           ├── schemas.ts         # Zod validators
│           ├── get-session.ts     # _bodhi/session/get + bodhi/getSession (legacy alias)
│           ├── volumes-list.ts    # _bodhi/volumes/list
│           ├── mcp-toggles-set.ts # _bodhi/mcp/toggles/set
│           ├── sessions-delete.ts # _bodhi/sessions/delete
│           └── server-info.ts     # _bodhi/server/info — passes through GET /bodhi/v1/info
├── agent/
│   ├── inline-agent.ts            # createInlineAgent — pi-agent-core wrapper
│   ├── bodhi-provider.ts          # BodhiProvider (LlmProvider impl)
│   ├── stream-fn.ts               # createStreamFn(provider) — pi-ai bridge
│   ├── system-prompt.ts           # composeSystemPrompt(volumes)
│   ├── volume-registry.ts         # VolumeInit, VolumeRegistry, ZenfsVolumeRegistry
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
│   ├── feature-store.ts           # FeatureStore interface + FEATURE_DEFAULTS
│   └── mcp-toggle-store.ts        # McpToggleStore interface + helpers
├── mcp/
│   └── url-canonical.ts           # canonicalizeMcpUrl, deriveSlugFromUrl
├── wire/
│   └── index.ts                   # ACP method/notification constants + Bodhi*
│                                  #   request/response/notification shapes
└── test-utils/                    # vitest helpers (`seed-volume`, `setup`)
    ├── seed-volume.ts             # InMemory + ZenFS test helper
    ├── setup.ts                   # vitest global setup (Worker shim)
    └── index.ts                   # exports SeedSpec, buildSeedInit
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
   transport to `startAcpAgent`, every byte across the stream
   pair is `ndJsonStream`-framed JSON-RPC 2.0. The two
   `extNotification` channels (`_bodhi/mcp/state`,
   `_bodhi/builtin/action`) and the small `_bodhi/*`
   ext-method surface ride the same JSON-RPC stream. No
   bespoke side channel.
2. **Single bootstrap per host.** The transport is set up once;
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
