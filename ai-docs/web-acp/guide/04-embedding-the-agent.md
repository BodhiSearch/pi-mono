# Chapter 4 — Embedding the agent

> Goal: show what `@bodhiapp/web-acp-agent` needs to run and what a
> host (the tutorial CLI) has to bring to make it run. After the
> "adaptive plum" simplification the boot surface is one verb:
> `startAgent({ transport, provider, ... })`. Embedded hosts also
> use `createInMemoryDuplex()` to wire a paired client connection.

## 4.1 The two halves of an embedded ACP setup

```
┌────── tutorial-cli-client (host process) ────────────────────────────┐
│                                                                       │
│  CLIENT SIDE                                          AGENT SIDE      │
│  ───────────                                          ──────────      │
│  ClientSideConnection ◄── ndJsonStream ──► startAgent({transport})    │
│       │                       │                       │               │
│  Client handler:         in-memory duplex        (engine, internal)   │
│  • sessionUpdate()       (TransformStream             │               │
│  • requestPermission     pair: client↔agent)     BodhiProvider ───► BodhiApp
│       │                                          (setAuthToken pings  │
│  EmbeddedAgent facade:                            /bodhi/v1/info,     │
│  • initialize                                     return rides        │
│  • authenticate (returns server info in _meta)    AuthenticateResponse│
│  • close                                          ._meta.bodhi.       │
│                                                   providerInfo)       │
└───────────────────────────────────────────────────────────────────────┘
```

Same Node process, two halves, joined by an in-memory byte-stream
duplex. Same code runs over a `MessagePort` (browser worker) or any
other byte-stream transport — see
`agent-client-protocol/docs/protocol/transports.mdx` for the wire
contract.

## 4.2 Agent-side: what `startAgent` needs

The whole boot is a single call. From
`packages/tutorial-cli-client/src/agent/embed.ts`:

```ts
const duplex = createInMemoryDuplex();
const { dispose } = startAgent({
  transport: duplex.agent,
  provider: new BodhiProvider(),
});
```

Two required fields, four optional. Full surface from
`packages/web-acp-agent/src/api/types.ts`:

| Field | Required? | What it powers |
|-------|-----------|----------------|
| `transport` | yes | byte-stream pair carrying ACP JSON-RPC frames |
| `provider` | yes | `LlmProvider` impl (auth + model catalog; default `BodhiProvider`) |
| `volumes` | no | initial `VolumeInit[]` mounted before the first prompt; runtime mount/unmount via `handle.mount`/`unmount` |
| `sessions` | no | per-session transcript store; default is in-memory |
| `preferences` | no | unified per-session prefs (feature toggles, MCP toggles); default is in-memory |
| `buildVersion` | no | reported via `/version` (default `"0.0.0"`) |

The tutorial CLI passes only the two required fields. Consequence:
- Sessions live in memory; closing the process loses them.
- Preferences live in memory.
- No volumes mounted; the agent's `bash` tool doesn't register.

That's enough to exercise `initialize` and `authenticate` — which
is all the tutorial needs. Persisting sessions or mounting a vault
is purely additive: inject your own `SessionStore` /
`PreferenceStore` / `volumes: VolumeInit[]`.

What `startAgent` does behind the call (the host never sees these):
1. Wraps `transport` with `ndJsonStream`.
2. Builds a `StreamOverridesRef` + `createStreamFn(provider, ...)`
   + `createInlineAgent(streamFn)`.
3. Constructs an internal `ZenfsVolumeRegistry` and mounts the
   supplied `volumes`.
4. Picks in-memory defaults for any store you didn't supply.
5. Calls `assembleServices(...)` internally.
6. Constructs `AgentSideConnection` with the engine
   (`AcpAgentAdapter`) inside its synchronous factory.
7. Returns `{ dispose, mount, unmount }`.

### Connectivity probe — folded into `authenticate`

`LlmProvider.setAuthToken` returns a `Promise<unknown>`. The agent
calls it during `handleAuthenticate`, captures the return value,
and surfaces it on `AuthenticateResponse._meta.bodhi.providerInfo`.
For `BodhiProvider`, `setAuthToken` pings `/bodhi/v1/info` after
storing credentials and returns the response payload — so the host
gets connectivity info as a free side effect of authenticating, no
separate `/server/info` call needed.

```ts
const authResp = await conn.authenticate({ methodId: BODHI_AUTH_METHOD_ID, _meta: { token, baseUrl } });
const info = readBodhiServerInfo(authResp); // typed cast helper
```

Auth-fundamentally-invalid (401/403) errors propagate as
`authenticate` failures. Transient connectivity errors are the
provider's call — for a hard probe failure we propagate; for a
soft warning the provider can return a discriminated shape and let
the host decide.

### Transport contract

```ts
interface AcpTransport {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}
```

Browser worker hosts adapt a `MessagePort` to this shape; embedded
hosts use `createInMemoryDuplex()`; future HTTP/SSE hosts adapt an
SSE response. The agent package's framing layer never sees the
transport directly — only the stream pair.

## 4.3 Client-side: what an embedded host writes

Three things, all standard ACP SDK use:

### 4.3.1 An in-memory duplex

```ts
import { createInMemoryDuplex } from "@bodhiapp/web-acp-agent";
const duplex = createInMemoryDuplex();
```

`agent` goes to `startAgent({ transport })`; `client` goes to the
SDK's `ndJsonStream`. The helper does not know which half hosts
which side — that's the embedder's wiring choice.

### 4.3.2 An ndJson-framed client stream

```ts
import { ndJsonStream } from "@agentclientprotocol/sdk";
const stream = ndJsonStream(duplex.client.writable, duplex.client.readable);
```

> SDK types are imported directly from `@agentclientprotocol/sdk`,
> not from `@bodhiapp/web-acp-agent`. The agent package
> deliberately doesn't re-export them.

### 4.3.3 A `Client` handler

ACP is bidirectional — the agent calls back into the client. The
SDK requires a `Client` object on connection construction:

```ts
import type { Client } from "@agentclientprotocol/sdk";

const handler: Client = {
  // SDK requires `requestPermission`; agent never invokes it.
  async requestPermission() {
    return { outcome: { outcome: "cancelled" } };
  },
  async sessionUpdate() {},
};
```

Two fields:
- `sessionUpdate(...)` — streamed chunks during a prompt turn.
  This tutorial doesn't call `prompt`, so the no-op is safe.
- `requestPermission(...)` — the SDK's `Client` interface
  requires this field. The agent doesn't currently issue any
  permission requests (the destructive-command bridge is deferred —
  see `ai-docs/web-acp/milestones/deferred.md`), so a one-line
  cancelled-outcome stub satisfies the type and the wire.

Two methods we don't even stub: `fs/read_text_file`,
`fs/write_text_file`. The agent owns its own filesystem (volumes
mount inside the runtime), so `clientCapabilities` advertises
neither — see § 4.5.

### 4.3.4 A `ClientSideConnection`

```ts
import { ClientSideConnection } from "@agentclientprotocol/sdk";
const conn = new ClientSideConnection(() => handler, stream);
```

The SDK wrapper exposes `initialize`, `authenticate`, `extMethod`,
`newSession`, `prompt`, and friends.

## 4.4 Putting it together

`createEmbeddedAgent()` in
`packages/tutorial-cli-client/src/agent/embed.ts` is ~50 lines.
The shape:

1. **Build duplex + start agent** —
   `createInMemoryDuplex()` then `startAgent({ transport, provider })`
   captures `dispose` for teardown.
2. **Wire client side** — `ndJsonStream(...)`, build the `Client`
   handler, construct `ClientSideConnection`.
3. **Return facade** — an `EmbeddedAgent` with `initialize`,
   `authenticate`, `close`. `authenticate` returns the
   `AuthenticateResponse`; the host reads
   `_meta.bodhi.providerInfo` for connectivity info (see § 4.2
   "Connectivity probe").

The bootstrap glue is
`packages/tutorial-cli-client/src/bootstrap.ts:startAgent` (the
host's outer name, not the agent package's verb). After
`runAuthIfNeeded` returns the JWT, it instantiates the
`EmbeddedAgent`, walks `initialize → authenticate`, reads the
provider info off the auth response, and emits the connectivity
ack before the REPL prompt renders.

## 4.5 Filesystem capabilities — agent-owned, not client-delegated

Standard ACP delegates filesystem reads/writes to the client via
`fs/read_text_file` and `fs/write_text_file`. We took a different
posture: the agent owns its own filesystem (volumes mount inside
the runtime; the bash tool reads/writes through them directly).
Both hosts therefore advertise `clientCapabilities: {}` — no
`fs/*` claims. The architectural rationale is in
`ai-docs/web-acp/steering/02-architecture.md` § "ACP architectural
postures".

## 4.6 Test-time vitest alias

The package no longer ships its own vitest config. If a future
unit test imports from `@bodhiapp/web-acp-agent`, it may trip on
`@zenfs/core/vfs` (subpath-resolution gap). The alias used by
similar packages in this repo:

```ts
"@zenfs/core/vfs": path.resolve(
  __dirname, "../../node_modules/@zenfs/core/dist/vfs/index.js",
),
```

## 4.7 What scales when we extend

Each optional in §4.2 is the extension point for a future tutorial
step:

| Capability we want                          | Pass into `startAgent` |
|---------------------------------------------|------------------------|
| Persistent sessions across runs             | `sessions: SessionStore`   |
| `bash` tool over a `$cwd` mount             | `volumes: [{ mountName, fs, … }]` |
| Per-session feature flags (`forceToolCall`) | `preferences: PreferenceStore` (settable via `setSessionConfigOption`) |
| Pre-approved MCP server toggles             | `preferences: PreferenceStore` (set via `_bodhi/mcp/toggles/set`) |

On the client side, the additions are equally additive: implement
`Client.sessionUpdate` to render streaming chunks, expose
`prompt(...)` on the `EmbeddedAgent` facade, and the next layer
of features is on. None of these require touching the duplex /
framing / connection plumbing.

## 4.8 Reference

ACP submodule:

- [`agent-client-protocol/docs/protocol/transports.mdx`](../../../agent-client-protocol/docs/protocol/transports.mdx) — wire framing and the byte-stream contract.
- [`agent-client-protocol/docs/protocol/overview.mdx`](../../../agent-client-protocol/docs/protocol/overview.mdx) — connection lifecycle.

Agent package:

- `packages/web-acp-agent/src/api/start-agent.ts:startAgent`
- `packages/web-acp-agent/src/api/in-memory-duplex.ts:createInMemoryDuplex`
- `packages/web-acp-agent/src/api/types.ts` — `StartAgentOptions`,
  `StartAgentHandle`, `AcpTransport`, `InMemoryDuplex`

Test-only surface (subpath import `@bodhiapp/web-acp-agent/test-utils`):

- `AcpAgentAdapter`, `assembleServices`, `createInlineAgent`,
  `InlineAgent`, `createStreamFn`, `McpConnectionPool`,
  `CommandsFs`, `createZenfsCommandsFs` — for tests that drive
  the engine layer directly without going through `startAgent`.

Embedded host:

- `packages/tutorial-cli-client/src/agent/embed.ts:createEmbeddedAgent`
- `packages/tutorial-cli-client/src/bootstrap.ts:startAgent`

Browser worker host:

- `packages/web-acp/src/agent/agent-worker.ts` — same `startAgent`
  call shape, with Dexie-backed stores and an FSA-backed volume
  registry for persistence.
