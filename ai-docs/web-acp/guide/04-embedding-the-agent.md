# Chapter 4 — Embedding the agent (both sides)

> Goal: see what `@bodhiapp/web-acp-agent` actually needs to run, and
> what a host (the tutorial CLI) has to bring to make it run. The
> chapter is split into the two halves explicitly: **agent-side
> runtime requirements** and **client-side host requirements**, with
> the wire that joins them in the middle.

## 4.1 The two halves of an embedded ACP setup

```
┌────── tutorial-cli-client (host process) ────────────────────────────┐
│                                                                       │
│  CLIENT SIDE                                          AGENT SIDE      │
│  ───────────                                          ──────────      │
│  ClientSideConnection ◄── ndJsonStream ──► AgentSideConnection        │
│       │                       │                       │               │
│  Client handler:         in-memory duplex        AcpAgentAdapter      │
│  • sessionUpdate()       (TransformStream         (the engine)        │
│  • requestPermission     pair: client↔agent)          │               │
│       │                                          AcpAdapterServices   │
│  EmbeddedAgent                                   (the services bag)   │
│  facade:                                              │               │
│  • initialize                                    BodhiProvider ───► HTTPS BodhiApp
│  • authenticate                                  InlineAgent (pi-agent-core)
│  • serverInfo                                    McpConnectionPool
│  • close                                         CommandsFs           │
│                                                  ZenfsVolumeRegistry  │
└───────────────────────────────────────────────────────────────────────┘
```

Same Node process, two named halves. The transport between them is a
WHATWG `TransformStream` pair (no socket, no Worker). The exact same
client and agent code work over a network transport — see
`agent-client-protocol/docs/protocol/transports.mdx` for the
generalised model.

## 4.2 Agent-side: what the runtime needs

`startAcpAgent(transport, services, options)` from
`packages/web-acp-agent/src/bootstrap.ts` is the single boot call. To
satisfy it the host has to supply two things: a byte-stream transport
and a `services` bag.

### 4.2.1 The services bag

Defined as `AcpAdapterServices` at
`packages/web-acp-agent/src/acp/engine/services.ts`. The host
constructs it via `assembleServices(...)` (same file). Required vs
optional:

| Field             | Type                           | Required? | What it powers                              |
|-------------------|--------------------------------|-----------|---------------------------------------------|
| `inline`          | `InlineAgent` (pi-agent-core)  | yes       | The LLM turn loop (`prompt` request)        |
| `bodhi`           | `LlmProvider` impl             | yes       | Auth + model catalog + `_bodhi/server/info` |
| `mcpPool`         | `McpConnectionPool`            | defaults  | MCP server connections                      |
| `commandsFs`      | `CommandsFs`                   | defaults  | Vault `.pi/commands/` + `.pi/prompts/`      |
| `store`           | `SessionStore`                 | optional  | Persisted sessions (loadSession)            |
| `registry`        | `VolumeRegistry`               | optional  | The `bash` tool + `_bodhi/volumes/list`     |
| `features`        | `FeatureStore`                 | optional  | Per-session feature flags                   |
| `mcpToggles`      | `McpToggleStore`               | optional  | Per-session MCP enable bits                 |
| `streamOverrides` | `StreamOverridesRef`           | optional  | Per-turn `tool_choice` overrides            |

What the tutorial CLI passes (see
`packages/tutorial-cli-client/src/agent/embed.ts:createEmbeddedAgent`):

```ts
const services = assembleServices({
  inline,
  bodhi: provider,
  registry: new ZenfsVolumeRegistry(),  // empty — no mounted volumes
});
```

Just `inline`, `bodhi`, and an empty volume registry. Everything else
takes the default or is omitted. Consequences:

- **No `store`** — sessions are in-memory; `Agent.listSessions` /
  `loadSession` won't return persisted rows. Fine: we never call them.
- **Empty `registry`** — the `bash` tool finds zero volumes and stays
  unregistered in the agent's tool catalog. Fine: we never call
  `prompt`, so no tools are invoked.
- **No `features` / `mcpToggles`** — feature config and per-session
  MCP enable bits stay at defaults; we don't surface them.
- **Defaulted `mcpPool` / `commandsFs`** — empty pool, empty commands
  filesystem; harmless.

The minimal services bag is enough because we exercise only
`initialize`, `authenticate`, and one extension method. Adding
features (prompts, sessions, volumes) is additive — drop the
implementation in.

### 4.2.2 The transport (`AcpTransport`)

Defined at `packages/web-acp-agent/src/bootstrap.ts:AcpTransport`:

```ts
interface AcpTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}
```

A pair of WHATWG byte streams. `startAcpAgent` wraps them in
`ndJsonStream` and hands them to `AgentSideConnection`. The transport
is the **only** thing the agent package knows about how it's
reached — swap a different pair, and the same agent code runs over
HTTP/SSE, a Worker `MessagePort`, stdio, or anything else that can
carry bytes.

## 4.3 Client-side: what the host has to bring

The host needs four things on the client side. All four live in
`packages/tutorial-cli-client/src/agent/embed.ts`.

### 4.3.1 An in-memory duplex (the byte-stream pair)

```ts
// src/agent/duplex.ts
const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
return {
  agent:  { readable: clientToAgent.readable, writable: agentToClient.writable },
  client: { readable: agentToClient.readable, writable: clientToAgent.writable },
};
```

Two `TransformStream`s, one per direction. Each side gets the
*other's* writable as its readable. Together they satisfy the
`AcpTransport` shape on both sides without leaving the process.

Why a function (not a constant): each embed needs its own pair so two
parallel embeds don't share state. (Not relevant for the tutorial
which only runs one, but the contract is reusable.)

### 4.3.2 An ndJson-framed client-side stream

```ts
import { ndJsonStream } from "@agentclientprotocol/sdk";
const clientStream = ndJsonStream(duplex.client.writable, duplex.client.readable);
```

`ndJsonStream` from the SDK is the framing layer. It turns the byte
streams into a `Stream<JSON-RPC message>`. The agent half is wrapped
internally by `startAcpAgent`; the client half is wrapped here.

> Note: SDK types are imported **directly from
> `@agentclientprotocol/sdk`**, not from `@bodhiapp/web-acp-agent`.
> The agent package deliberately doesn't re-export them
> (`packages/web-acp-agent/src/index.ts` line 123 has the explicit
> comment).

### 4.3.3 A `Client` handler object

ACP is bidirectional: the agent calls back into the client for some
things. The SDK requires a `Client` object on construction:

```ts
import type { Client } from "@agentclientprotocol/sdk";
import { requestPermissionStub } from "@bodhiapp/web-acp-agent";

const handler: Client = {
  requestPermission: requestPermissionStub,  // returns "cancelled"
  async sessionUpdate() {},                  // ignore streaming
};
```

What we stub:

- `sessionUpdate(...)` — streaming `agent_message_chunk` /
  `tool_call_update` notifications during a prompt turn. We don't
  call `prompt`, so nothing arrives; no-op is safe.
- `requestPermission(...)` — agent asking the user "may I run this
  destructive tool?". We use the agent package's exported stub which
  always returns `cancelled`. Safe default.

Two methods we don't even stub because the agent never calls them in
the calls we make: `fs/read_text_file`, `fs/write_text_file`. The
`Client` interface marks them optional, so omitting is fine.

### 4.3.4 A `ClientSideConnection`

```ts
import { ClientSideConnection } from "@agentclientprotocol/sdk";
const conn = new ClientSideConnection(() => handler, clientStream);
```

The SDK's wrapper around an ACP client connection. Exposes
`initialize`, `authenticate`, `extMethod`, `newSession`, `prompt`,
etc. — all the methods we discussed in Chapter 2.

The `() => handler` thunk is a holder pattern: `ClientSideConnection`
calls it synchronously during construction to obtain its `Client`
back-reference. Since our handler is created beforehand, the thunk
just returns it.

## 4.4 Putting it together

`createEmbeddedAgent()` in `embed.ts` is ~80 lines. Read it as four
ordered blocks:

1. **Build services bag** — `BodhiProvider`, `InlineAgent` via
   `createInlineAgent(createStreamFn(provider, () => ({})))`,
   `assembleServices({ inline, bodhi, registry })`.
2. **Open duplex + start agent** — `createInMemoryDuplex()`,
   `startAcpAgent(duplex.agent, services, { isDev: false,
   buildVersion, acpSdkVersion, onAdapter })`. The `onAdapter`
   callback captures the `AcpAgentAdapter` for `dispose()` later.
3. **Wire client side** — `ndJsonStream(client.writable,
   client.readable)`, build `Client` handler, construct
   `ClientSideConnection`.
4. **Return facade** — an `EmbeddedAgent` exposing only what the CLI
   uses: `initialize`, `authenticate`, `serverInfo`, `close`. Each is
   a thin wrapper over the underlying `conn` method (see Chapter 2
   for which calls these are).

The bootstrap glue is `packages/tutorial-cli-client/src/bootstrap.ts:startAgent`.
After `runAuthIfNeeded` returns the JWT, it instantiates the
`EmbeddedAgent`, walks `initialize → authenticate → serverInfo`, and
emits the connectivity ack before the REPL prompt renders.

## 4.5 The `vitest`-time alias (one footgun)

Removed in the latest cleanup — the package no longer ships a vitest
config. If a future unit test needs to import from
`@bodhiapp/web-acp-agent`, it will trip on
`@zenfs/core/vfs` (a known subpath-resolution gap). The alias used by
`packages/cli-acp-client/vitest.config.ts` is the canonical workaround:

```ts
"@zenfs/core/vfs": path.resolve(
  __dirname, "../../node_modules/@zenfs/core/dist/vfs/index.js",
),
```

## 4.6 What scales when we extend

Each agent-side optional in §4.2.1 is the extension point for a
future tutorial step:

| Capability we want                           | Service to add        |
|----------------------------------------------|-----------------------|
| Persistent sessions, list / load / fork      | `store: SessionStore` |
| `bash` tool over a `$cwd` mount              | `registry` (with mounts) |
| Per-session feature flags (`forceToolCall`)  | `features`            |
| Pre-approved MCP server toggles              | `mcpToggles`          |

On the client side, the additions are equally additive: implement
`Client.sessionUpdate` to handle streaming chunks, expose
`prompt(...)` on the `EmbeddedAgent` facade, and the next layer of
features is on. None of these changes require touching the
duplex / framing / connection plumbing.

## 4.7 Reference

ACP submodule:

- [`agent-client-protocol/docs/protocol/transports.mdx`](../../../agent-client-protocol/docs/protocol/transports.mdx) — wire framing and the byte-stream contract.
- [`agent-client-protocol/docs/protocol/overview.mdx`](../../../agent-client-protocol/docs/protocol/overview.mdx) — connection lifecycle.

Agent-side:

- `packages/web-acp-agent/src/bootstrap.ts:startAcpAgent`
- `packages/web-acp-agent/src/acp/engine/services.ts:assembleServices`
- `packages/web-acp-agent/src/acp/agent-adapter.ts:AcpAgentAdapter`

Client-side (tutorial CLI):

- `packages/tutorial-cli-client/src/agent/duplex.ts:createInMemoryDuplex`
- `packages/tutorial-cli-client/src/agent/embed.ts:createEmbeddedAgent`
- `packages/tutorial-cli-client/src/bootstrap.ts:startAgent`

Reference (richer) embed:

- `packages/cli-acp-client/src/acp/embedded-host.ts` — same shape with
  Sqlite stores + FSA volumes wired in. Use as a model when expanding
  the tutorial in later milestones. (Note: this file currently has a
  broken import — `ClientSideConnection` and `ndJsonStream` should
  come from `@agentclientprotocol/sdk`, not `@bodhiapp/web-acp-agent`.
  cli-acp-client's `tsc --noEmit` is a no-op due to the
  `files: [] + references` shape, so the bug isn't surfaced by its
  CI.)
