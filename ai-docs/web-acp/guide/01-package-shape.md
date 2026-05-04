# Chapter 1 — Package shape & seams

> Goal of this chapter: understand **what `@bodhiapp/web-acp-agent` is**,
> **what it owns vs. delegates**, and **why the seams are where they are**.
> Subsequent chapters dive into the wire surface, the engine, the
> pi-agent-core embedding, the BodhiApp auth/catalog plumbing, and a full
> turn trace.

## 1.1 The one-line claim

`@bodhiapp/web-acp-agent` is a **transport-agnostic, runtime-neutral ACP
agent runtime**. It owns everything from the JSON-RPC wire shim down to
the `pi-agent-core` `Agent` instance, the MCP client pool, the bash tool,
and the slash-command loader. It owns **none** of the runtime services
those need: persistence, filesystem backends, transports, or auth flow.
Hosts (browser worker, Node CLI, future HTTP-SSE backend) supply those
through five injectable interfaces and a byte-stream pair.

The package was extracted post-M4 phase B specifically to validate that
the agent code runs unchanged across two materially different hosts:

```mermaid
flowchart LR
  subgraph H1[web-acp host — browser]
    W[Web Worker]
    DX[(Dexie / IndexedDB)]
    FSA[FSA volumes]
    MP[MessagePort transport]
  end
  subgraph H2[cli-acp-client host — Node TTY]
    P[Node process]
    Mem[(in-memory stores)]
    PT[PassthroughFS volume]
    DUP[in-memory duplex]
  end
  subgraph A[ @bodhiapp/web-acp-agent ]
    SA[startAcpAgent]
    AA[AcpAgentAdapter]
    EN[engine layer]
    IA[InlineAgent — pi-agent-core]
    MCP[McpConnectionPool]
    BT[bash tool — just-bash]
  end
  W -->|services + transport| SA
  P -->|services + transport| SA
  SA --> AA --> EN --> IA
  EN --> MCP
  EN --> BT
```

Same agent bytes, different host bytes above the transport. That is the
load-bearing claim the package's design exists to make true.

## 1.2 Public surface — one function, several types

`packages/web-acp-agent/src/index.ts` re-exports two layers:

- **The boot API.** `startAcpAgent` plus `AcpTransport` /
  `StartAcpAgentOptions`. This is what 99% of hosts call.
- **The toolkit.** The `Bodhi*` wire constants and request/response
  types (`wire/`), the assembly seam (`AcpAgentAdapter`,
  `assembleServices`, `AssembleServicesOptions`,
  `StreamOverridesRef`), the five service interfaces (`SessionStore`,
  `FeatureStore`, `McpToggleStore`, `VolumeRegistry`, `LlmProvider`),
  the concrete `BodhiProvider`, the `InlineAgent` factory + types,
  MCP types + `McpConnectionPool`, command loaders + built-in
  registry, the `bash` tool factory + `ZenfsVolumeRegistry`, and the
  small `requestPermissionStub` + two pure wire helpers
  (`toAvailableCommand`, `toolTitle`). Engine internals
  (`AcpSessionRuntime`, `PromptTurnDriver`, `ExtMethodHost`,
  `SessionState`, the per-handler ACP method modules under
  `acp/handlers/`, the per-method `_bodhi/*` ext-method files,
  `composeSystemPrompt`, `VolumeFileSystem`) are deliberately **not
  re-exported** — they are private to the package even though tests
  reach for them via relative paths.

The boot function — see `bootstrap.ts:startAcpAgent`:

```ts
function startAcpAgent(
  transport: AcpTransport,                 // { readable, writable }
  services: AcpAdapterServices,            // assembled bag
  options: StartAcpAgentOptions            // { isDev, buildVersion, acpSdkVersion, onAdapter? }
): AgentSideConnection
```

Internally it wraps the two byte streams in `ndJsonStream`, constructs an
`AgentSideConnection`, and inside its `toAgent` factory builds an
`AcpAgentAdapter` over the supplied services. `onAdapter` callback
returns the live adapter so the host can call `dispose()` later.

### Why a byte-stream pair, not a `MessagePort`

`MessagePort` is browser-only. `WHATWG ReadableStream` /
`WritableStream<Uint8Array>` is universal — it has implementations in
Node (`stream/web`), Deno, Bun, the browser, and any test harness that
implements `TransformStream`. The two host types this package targets
already have it:

- `web-acp` wraps `MessagePort` into a stream pair via
  `runtime/transport/worker-stream.ts:createMessagePortStream`.
- `cli-acp-client` builds two `TransformStream`s and crosses them
  head-to-tail via `acp/duplex.ts:createInMemoryDuplex`.

A future HTTP-SSE host plugs in the same way — only the streams change.

## 1.3 The five seams

Every dependency the agent has on the host runtime sits behind a typed
interface. The seams aren't accidental — each one is the boundary
between code that has to be portable and code that is necessarily
host-specific.

### Seam 1 — `LlmProvider` (auth + model catalog)

File: `agent/bodhi-provider.ts`. Interface:

```ts
interface LlmProvider {
  getApiKeyAndHeaders(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string,string> }>
  getAvailableModels(): Promise<Model<Api>[]>
  setAuthToken?(credential: LlmAuthCredential | null): void
}
```

The agent is otherwise auth-agnostic. `BodhiProvider` is the concrete
shipped implementation — it talks to the BodhiApp `/bodhi/v1/models`
endpoint (paginated `AliasResponse`s flattened into `pi-ai`'s
`Model<Api>` shape) and forwards the bearer token from
`setAuthToken`. Anything that implements the three methods above can
back the agent: a direct OpenAI client, a Vercel AI Gateway, a stub for
tests. Chapter 4 dives into this.

### Seam 2 — `SessionStore` (persistence)

File: `storage/session-store.ts`. The store persists three entry kinds
(`'notification' | 'turn' | 'builtin'`) keyed by `[sessionId, seq]` —
turn entries are the canonical replay source for `inline.restoreMessages`
on `session/load`; notification entries replay the streamed
`session/update` events for the UI; builtin entries persist
`/help`-style command exchanges without polluting the LLM context. The
agent package ships only the interface plus `deriveTitle()`; hosts ship
the concrete impl (Dexie/IndexedDB in the browser, in-memory `Map`s in
the CLI).

### Seam 3 — `FeatureStore` (per-session flags)

File: `storage/feature-store.ts`. Tiny key/value bag scoped to one ACP
session. Today's keys: `bashEnabled` (gates bash-tool registration) and
`forceToolCall` (DEV-only: pushes `tool_choice: 'required'` so e2e tests
can force tool calls). `FEATURE_DEFAULTS` plus a layered merge means new
keys roll out without a migration.

The wire surface for these flags is **native ACP**:
`Agent.setSessionConfigOption` plus the `configOptions` array on
`NewSessionResponse` / `LoadSessionResponse`, mapped via
`acp/feature-config.ts:FEATURE_CONFIG_ENTRIES`
(`_bodhi/features/{bashEnabled,forceToolCall}` config ids ↔
`FeatureKey`). The `_bodhi/features/list` and `_bodhi/features/set`
extension methods that previously carried this surface have been
retired (ACP 0.21 compliance migration). DEV-only enforcement of
`forceToolCall` sits in the `setSessionConfigOption` handler — a
non-DEV host that tries to enable it gets JSON-RPC error `-32004`.

### Seam 4 — `McpToggleStore` (per-session MCP enable/disable)

File: `storage/mcp-toggle-store.ts`. Two-level toggles: per-server slug
and per-tool. Defaults are **on** — absent keys mean "not explicitly
disabled" — so a newly-discovered server/tool opts in automatically.
The store interface is independent of the MCP catalog itself; the
catalog comes from upstream Bodhi or a host-side fetch and is composed
with the toggles via the internal `wire-utils.ts:filterHttpServers`
helper. Mutations ride the surviving `_bodhi/mcp/toggles/set`
extension method (one of only four `_bodhi/*` ext-methods left
post-ACP-0.21 — see § 1.4).

### Seam 5 — `VolumeRegistry` (filesystem mounts)

File: `agent/volume-registry.ts`. The registry maps `mountName →
ZenFS FileSystem` and mounts each at `/mnt/<mountName>`. **The agent
does not import `@zenfs/dom`**; it accepts a pre-constructed
`FileSystem` from the host. That's what makes the same registry work
behind:

- a `WebAccess`-wrapped `FileSystemDirectoryHandle` (browser), or
- a `PassthroughFS` over `node:fs` rooted at `$cwd` (CLI), or
- an `InMemory` ZenFS backend (tests).

`ZenfsVolumeRegistry` is the shipped implementation — listeners fire
on every `mount` / `unmount` so the adapter can refresh the system
prompt and emit ACP notifications. Chapter 5 covers volumes + bash in
detail.

## 1.4 What the agent owns

Everything below the five seams. Concretely:

| Folder / file                                                            | Responsibility                                                                                                                                                                            |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acp/agent-adapter.ts`                                                   | ACP `Agent` implementation — pure dispatch shim; constructs `AcpSessionRuntime` + `PromptTurnDriver` + a shared `AcpAdapterContext` and routes each SDK callback at a per-method handler  |
| `acp/handlers/adapter-context.ts`                                        | `AcpAdapterContext` deps bag + model-resolution helpers (`tryEnsureModels`, `buildModelState`, `resolveSeededModelId`)                                                                    |
| `acp/handlers/initialize.ts`                                             | `Agent.initialize` + `Agent.authenticate` handlers (capability advertisement, `bodhi-token` auth method, `agentInfo`)                                                                     |
| `acp/handlers/session-crud.ts`                                           | `newSession` / `loadSession` / `listSessions` / `closeSession` / `unstable_setSessionModel` / `setSessionConfigOption` / `cancel` handlers — all native ACP, no `_bodhi/*` ride           |
| `acp/feature-config.ts`                                                  | Maps `FeatureKey` ↔ ACP config IDs (`_bodhi/features/{bashEnabled,forceToolCall}`); builds the `configOptions` array stamped on `newSession`/`loadSession` responses                      |
| `acp/engine/session-runtime.ts`                                          | Per-session state owner — session map, MCP pool refcounts, command loading, model-catalog cache, runtime dispose                                                                          |
| `acp/engine/prompt-driver.ts`                                            | One prompt-turn end-to-end (built-in dispatch → LLM stream → tool calls → finalisation), abort-if-active                                                                                  |
| `acp/engine/builtin-dispatch.ts`                                         | Built-in slash-command intercept used by the prompt driver — `/help` `/version` `/info` `/copy` `/mcp`                                                                                    |
| `acp/engine/replay.ts`                                                   | Shared replay walker over `SessionEntry[]` for `loadSession`                                                                                                                              |
| `acp/engine/ext-methods/`                                                | The four surviving `_bodhi/*` handlers — `volumes/list`, `session/get` (+ `bodhi/getSession` legacy alias for one release), `mcp/toggles/set`, `sessions/delete` — plus Zod schemas       |
| `acp/engine/services.ts`                                                 | `assembleServices()` — deps bag the adapter consumes                                                                                                                                      |
| `acp/wire-utils.ts`                                                      | Pure helpers — re-exports `toAvailableCommand`, `toolTitle`; internal helpers (`extractSessionMeta`, `filterHttpServers`, builtin envelope builders) used by handlers / engine            |
| `acp/permissions.ts`                                                     | `requestPermissionStub` — current placeholder that returns `cancelled` (permission bridge is deferred per `ai-docs/web-acp/milestones/deferred.md`)                                       |
| `wire/`                                                                  | Method-name constants for built-in (`bodhi-token`) + four `_bodhi/*` ext-methods + two `_bodhi/*` notifications, plus typed request/response/notification shapes                          |
| `agent/inline-agent.ts`                                                  | Thin wrapper around `pi-agent-core`'s `Agent` (`setModel`, `subscribe`, `prompt`, `cancel`, `restoreMessages`)                                                                            |
| `agent/bodhi-provider.ts`                                                | `LlmProvider` interface + `BodhiProvider` impl (BodhiApp catalog fetch + alias flattening + bearer-token forwarding); `LlmAuthCredential` rotation envelope                               |
| `agent/stream-fn.ts`                                                     | `createStreamFn(provider, consumeOverrides)` — bridges pi-agent-core's `StreamFn` to pi-ai's `streamSimple`; threads per-turn `toolChoice` overrides for `forceToolCall`                   |
| `agent/system-prompt.ts`                                                 | `composeSystemPrompt(volumes)` — assembles the agent's system prompt with mounted-volume descriptors                                                                                      |
| `agent/commands/`                                                        | Vault-sourced slash commands + prompt-templates loader / expander / front-matter parser / canonical naming                                                                                |
| `agent/commands/builtins/`                                               | Per-file built-in command handlers (`help`, `version`, `info`, `copy`, `mcp`) + the `BUILTIN_COMMANDS` registry                                                                           |
| `agent/mcp/`                                                             | `McpConnectionPool` (refcounted), `createMcpClient` (Streamable HTTP), `createMcpAgentTool` (MCP tool ↔ pi-agent-core `AgentTool` adapter)                                                |
| `agent/tools/bash-tool.ts`                                               | `just-bash`-backed single LLM-facing `bash` tool                                                                                                                                          |
| `agent/tools/volume-filesystem.ts`                                       | `IFileSystem` adapter over the ZenFS-mounted volume set (private — not on the public barrel)                                                                                              |
| `agent/volume-registry.ts`                                               | `VolumeRegistry` interface + `ZenfsVolumeRegistry` (multi-mount at `/mnt/<name>`)                                                                                                         |
| `mcp/url-canonical.ts`                                                   | Shared MCP URL canonicalisation (`canonicalizeMcpUrl`, `deriveSlugFromUrl`) — also used by hosts                                                                                          |
| `storage/{session-store,feature-store,mcp-toggle-store}.ts`              | Host-implementable interfaces + shape types + helpers (`deriveTitle`, `FEATURE_DEFAULTS`, `isFeatureKey`, `isServerEnabled`, `isToolEnabled`, `EMPTY_MCP_TOGGLES`)                         |

The package's hard constraints (verified by grep in CI) are:

- Zero imports from `packages/web-agent/` or `packages/coding-agent/`.
- No browser-only deps: `@zenfs/dom`, `dexie`, `idb-keyval`,
  `MessagePort`, `Worker`, `FileSystemDirectoryHandle`,
  `navigator.storage`, `window.*` — all must be absent.

## 1.5 Boot, drawn

Same wire / same agent / different hosts:

```mermaid
sequenceDiagram
    autonumber
    participant Host
    participant SA as startAcpAgent
    participant Conn as AgentSideConnection
    participant Adapter as AcpAgentAdapter
    participant Engine as engine layer
    participant Inline as InlineAgent (pi-agent-core)
    participant Provider as LlmProvider

    Host->>SA: startAcpAgent({readable,writable}, services, options)
    SA->>Conn: new AgentSideConnection(toAgent, ndJsonStream(...))
    Conn->>Adapter: new AcpAgentAdapter(conn, services, options)
    Adapter->>Engine: new AcpSessionRuntime + new PromptTurnDriver + AcpAdapterContext
    Note over Adapter: services.inline + bodhi + mcpPool + commandsFs <br/> + optional store/registry/features/mcpToggles
    Host-->>Adapter: ACP wire: initialize, authenticate, session/new, <br/> setSessionModel, setSessionConfigOption, prompt, ...
    Adapter->>Engine: route via per-method handler in acp/handlers/
    Engine->>Inline: setModel + prompt(text)
    Inline->>Provider: getApiKeyAndHeaders / streamSimple
    Provider-->>Inline: streamed deltas
    Inline-->>Engine: AgentEvent(s)
    Engine-->>Conn: session/update notifications
    Conn-->>Host: streamed bytes
```

The host's job stops at "supply the streams + the services bag". Nothing
on the agent side cares whether the streams are backed by a worker, a
TCP socket, or two arrays.

## 1.6 Concrete bootstraps (cheat sheet)

Both hosts import everything below the transport boundary from
`@bodhiapp/web-acp-agent` — `BodhiProvider`, `createInlineAgent`,
`createStreamFn`, `assembleServices`, `ZenfsVolumeRegistry`,
`startAcpAgent`. The host-specific code is the services-bag wiring
plus the transport adapter, nothing else.

### Browser — `web-acp` worker

`web-acp/src/agent/agent-worker.ts:startAgent` (the entire
`web-acp/src/agent/` folder is now this **one file**) builds:

- `BodhiProvider` (the `LlmProvider`)
- `InlineAgent` over `createStreamFn(provider, consumeOverrides)`
- Dexie-backed `SessionStore`, `FeatureStore`, `McpToggleStore` from
  `web-acp/src/runtime/storage-dexie/`
- `ZenfsVolumeRegistry` + an FSA-handle volume-control side-channel
  (`web-acp/src/runtime/volumes-fsa/`). Volumes arrive as
  `HostVolumeInit` (FSA handle | dev seed) and are converted to the
  agent's transport-agnostic `VolumeInit` (constructed `FileSystem`)
  via `toAgentVolumeInit` before mounting.
- `MessagePort` ↔ stream pair via
  `web-acp/src/runtime/transport/worker-stream.ts:createMessagePortStream`

…then `assembleServices(...)` and `startAcpAgent(transport, services,
{ isDev, buildVersion, acpSdkVersion })`. The build constants come
from Vite `define` globals on the host side and are forwarded across
the package boundary as plain options — the agent package never sees
Vite.

### Node TTY — `cli-acp-client`

`cli-acp-client/src/acp/embedded-host.ts:createEmbeddedHost` builds:

- `BodhiProvider` (same class) + `InlineAgent` (same factory)
- In-memory `Map`-backed `SessionStore`, `FeatureStore`, `McpToggleStore`
- `ZenfsVolumeRegistry` seeded with a `PassthroughFS` over `node:fs` at
  `$cwd` (mounted at `/mnt/cwd`)
- `createInMemoryDuplex()` returning two `TransformStream` pairs

…then `startAcpAgent(duplex.agent, services, options)`. The client
half of the duplex is wrapped by a `ClientSideConnection` inside the
same Node process — same bytes on both ends.

The diff between the two hosts is about 200 LoC of services-bag wiring
plus the transport adapter.

## 1.7 Reading order from here

| Chapter | Topic                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------- |
| 2       | ACP wire surface — `AcpAgentAdapter` ↔ engine split, what each ACP method does                                      |
| 3       | Engine internals — `AcpSessionRuntime`, `PromptTurnDriver`, builtin + ext-method dispatch                           |
| 4       | `InlineAgent` + `BodhiProvider` + `createStreamFn` — how `pi-agent-core` is embedded and how BodhiApp auth flows in |
| 5       | Volumes + bash + MCP — the tool surface and its host-supplied backends                                              |
| 6       | A full prompt turn, traced end-to-end with timings and notifications                                                |
| 7       | Tests, e2e seams, and how the two hosts validate transport-neutrality                                               |

---

### Notes / questions surfaced while drafting

- **Extraction is complete on both hosts** (commit `f6fd1859`,
  "clean up/decoupling of web-acp agent/client"). The browser worker's
  duplicate copies of `acp/{agent-adapter,engine/*,wire-utils}`,
  `agent/{bodhi-provider,inline-agent,stream-fn,system-prompt,
  session-store,commands,mcp,tools,volume-mount,volume-channel}`, plus
  `features/`, `mcp/toggle-store`, `transport/{worker-stream,
  volume-control}` are deleted. Everything below the transport lives
  only in `@bodhiapp/web-acp-agent`. `web-acp/src/agent/` contains
  exactly one file — `agent-worker.ts` — and it calls
  `startAcpAgent(...)` directly, same as `cli-acp-client`.
- **ACP 0.21 compliance migration has landed inside the agent
  package.** The wire surface has been pulled towards native ACP and
  away from `_bodhi/*` extensions:
  - **Native now:** `Agent.listSessions`, `Agent.closeSession`,
    `Agent.unstable_setSessionModel` (+ `SessionModelState`),
    `Agent.setSessionConfigOption` (+ `configOptions[]` on
    `NewSessionResponse` / `LoadSessionResponse`), `agentInfo` on
    `InitializeResponse`, explicit reducer arms for all 11
    `SessionUpdate` kinds.
  - **Retired `_bodhi/*` ext-methods:** `bodhi/listModels`,
    `bodhi/listSessions`, `_bodhi/features/list`,
    `_bodhi/features/set`. These were one-shot RPC methods that
    duplicated capabilities ACP now ships natively.
  - **Surviving `_bodhi/*` ext-methods (4):** `_bodhi/volumes/list`,
    `_bodhi/session/get` (with `bodhi/getSession` accepted as a
    deprecated alias for one release; one-time `console.warn` on
    first use), `_bodhi/mcp/toggles/set`, `_bodhi/sessions/delete`
    (the user-visible "delete" gesture; `Agent.closeSession` only
    frees in-memory state). All use Zod schemas and live as
    per-method files under `acp/engine/ext-methods/`.
  - **Side-channel notifications:** `_bodhi/mcp/state` (MCP
    lifecycle) and `_bodhi/builtin/action` (built-in command
    actions) ride `extNotification` — same `_`-prefixed namespacing
    rule. Per `milestones/index.md`, the planned `bodhi/getSession`
    collapse (M5 of the migration) is **deferred** because the
    incremental replay path turned out to be incomplete; see
    `packages/web-acp/TECHDEBT.md` § "M5 deferred".
- **Adapter is even thinner now.** `acp/agent-adapter.ts` is a pure
  dispatch shim — every ACP method delegates to a per-handler module
  under `acp/handlers/` (initialize, session-crud) sharing an
  `AcpAdapterContext` deps bag. The shim's only resident state is
  the runtime + driver + ctx triple it constructs.
- The volume seam in the browser host has a small **two-layer twist**:
  `web-acp/src/runtime/volumes-fsa/` defines `HostVolumeInit` (FSA
  handle | dev seed) that travels across the worker `init` postMessage
  in cloneable form; the worker's `agent-worker.ts:startAgent` then
  maps each via `toAgentVolumeInit` into the agent package's
  `VolumeInit` (which carries a fully-constructed ZenFS `FileSystem`).
  This keeps `@zenfs/dom` out of the agent package — the host
  constructs the `FileSystem`, the agent only mounts it.
- `LlmProvider` is the only seam **without** an "interface in the agent
  package, impl in the host" split — the concrete `BodhiProvider`
  ships inside the agent package itself. That's because the catalog-
  flattening logic is BodhiApp-specific and there's no other provider
  yet to motivate the split. A future OpenAI/Anthropic-direct provider
  would live alongside `BodhiProvider` in the agent package, not in a
  host.
