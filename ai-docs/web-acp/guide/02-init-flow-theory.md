# Chapter 2 — How web-acp-agent implements ACP

> Goal: trace the four calls our CLI makes, distinguishing **what is
> ACP-core** (defined by the spec, every ACP-compliant agent
> implements it) from **what web-acp-agent adds as an extension**
> (using ACP's reserved extension mechanisms). Each method comes
> with: ACP spec reference, agent handler `file:method`, client call
> site `file:method`.

## 2.1 ACP, briefly

ACP (Agent Client Protocol) is a JSON-RPC 2.0 protocol with a fixed
core surface and two **explicitly-reserved extension hooks**:

| Mechanism              | What it is                                                                   | Spec                                                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `_meta` field          | Every ACP type carries `_meta: { [key: string]: unknown }` for vendor data   | [`extensibility.mdx` § The `_meta` Field](../../../agent-client-protocol/docs/protocol/extensibility.mdx) |
| `_`-prefixed methods   | Method names starting with `_` are reserved for vendor extensions            | [`extensibility.mdx` § Extension Methods](../../../agent-client-protocol/docs/protocol/extensibility.mdx) |
| Custom auth method IDs | Agents declare auth methods in `initialize` response; IDs are vendor-defined | [`initialization.mdx`](../../../agent-client-protocol/docs/protocol/initialization.mdx)                   |

web-acp-agent uses all three. Below, every "extension" callout maps
back to one of these three mechanisms — we never invent a sub-protocol.

## 2.2 The four calls our CLI makes

```
  ACP core              web-acp-agent
  ────────              ─────────────
  initialize    ─────►  declares auth method id "bodhi-token"
  authenticate  ─────►  reads _meta.{ token, baseUrl } (vendor shape)
  extMethod     ─────►  routes "_bodhi/server/info" to handler
  (close)       ─────►  AcpAgentAdapter.dispose()
```

The wire structure is ACP. The *contents* the wire carries (what
`bodhi-token` means; what `_meta` should hold; what `_bodhi/server/info`
returns) are the agent's choices.

## 2.3 Method 1: `initialize`

**ACP-core.** Spec: [`initialization.mdx`](../../../agent-client-protocol/docs/protocol/initialization.mdx).
The first call on every connection. Negotiates protocol version,
exchanges capabilities, and lets the agent advertise its auth methods.

**Where it lives:**

- Agent handler: `packages/web-acp-agent/src/acp/handlers/initialize.ts:handleInitialize`
- Client call: `packages/tutorial-cli-client/src/agent/embed.ts:initialize` (inside the returned `EmbeddedAgent`)
- Top-level invoker: `packages/tutorial-cli-client/src/bootstrap.ts:startAgent`

**What's ACP-core in the response:** `protocolVersion`, `agentInfo
{ name, title, version }`, `agentCapabilities`, `authMethods[]`.

**What's web-acp-agent's choice:** the *contents* of those fields:

- Agent name `@bodhiapp/web-acp-agent`, title `Bodhi Web ACP Agent`.
- One auth method ID: `bodhi-token`. The constant lives at
  `packages/web-acp-agent/src/wire/index.ts` (`BODHI_AUTH_METHOD_ID`).
  Per ACP, agents are free to define any auth method id — this is the
  one our agent advertises, and the only one it accepts.
- Capabilities like `loadSession`, `mcpCapabilities.http`, etc. are
  ACP-core fields; the values reflect what this agent supports.

**No network call** happens during `initialize` — it's pure
declarative metadata exchange. Spec-mandated as the first call before
anything else.

## 2.4 Method 2: `authenticate`

**ACP-core.** Spec: [`overview.mdx` § authenticate](../../../agent-client-protocol/docs/protocol/overview.mdx)
+ [`schema.mdx` § Authenticate](../../../agent-client-protocol/docs/protocol/schema.mdx).
Called by the client to satisfy whatever auth method the agent
advertised. The wire shape (`{ methodId, _meta }`) is ACP-core.

**Where it lives:**

- Agent handler: `packages/web-acp-agent/src/acp/handlers/initialize.ts:handleAuthenticate`
- Client call: `packages/tutorial-cli-client/src/agent/embed.ts:authenticate`
- Top-level invoker: `packages/tutorial-cli-client/src/bootstrap.ts:startAgent`

**What's ACP-core:** the method exists, takes `methodId: string` (must
match an advertised id) plus an optional `_meta`. Returns an empty
object on success.

**What's web-acp-agent's extension** (riding ACP's `_meta` mechanism):

- The shape of `_meta`: `{ token: string, baseUrl: string }` — typed
  as `BodhiAuthenticateMeta` at `packages/web-acp-agent/src/wire/index.ts`.
- Behaviour: `handleAuthenticate` reads `_meta`, calls
  `services.bodhi.setAuthToken({ provider: "bodhi", token, baseUrl })`,
  clears the cached model catalog, returns `{}`.
- **No network call**. The agent stashes credentials inside its
  `BodhiProvider` instance and returns. Any subsequent call that
  actually touches BodhiApp will surface success/failure.

This is why we need a third call to confirm connectivity.

## 2.5 Method 3: `extMethod("_bodhi/server/info", {})`

**ACP-core mechanism, web-acp-agent extension method.**

Spec: [`extensibility.mdx` § Extension Methods](../../../agent-client-protocol/docs/protocol/extensibility.mdx).
ACP reserves any method name starting with `_` for vendor extensions.
The dispatch surface (`extMethod` on the SDK client) is core; the
specific method `_bodhi/server/info` is web-acp-agent's.

**Where it lives:**

- Wire constant: `packages/web-acp-agent/src/wire/index.ts` — `BODHI_SERVER_INFO_METHOD`, `BodhiServerInfoResponse`
- Agent dispatch: `packages/web-acp-agent/src/acp/engine/ext-methods/index.ts:dispatchExtMethod`
- Agent handler: `packages/web-acp-agent/src/acp/engine/ext-methods/server-info.ts:serverInfo`
- HTTP call: `packages/web-acp-agent/src/agent/bodhi-provider.ts:fetchServerInfo`
- Client call: `packages/tutorial-cli-client/src/agent/embed.ts:serverInfo`
- Top-level invoker: `packages/tutorial-cli-client/src/dispatcher.ts:emitStatus` (and `bootstrap.ts:startAgent` on first connect)

**What this method does on the agent side:** issues an authenticated
`GET ${baseUrl}/bodhi/v1/info` and returns the response body verbatim
(snake_case fields preserved). Throws on non-2xx — no try/catch
swallow — so the caller sees a JSON-RPC error if BodhiApp can't be
reached.

That throw-on-failure property is why we use this and not
`session/new`: see §2.7.

## 2.6 The fourth call: dispose / close

The SDK's `AgentSideConnection.dispose()` tears down the JSON-RPC
dispatch loop. Not a wire call — just a process-level cleanup hook.

- Agent side: `packages/web-acp-agent/src/acp/agent-adapter.ts:AcpAgentAdapter#dispose`
- Captured at bootstrap via the `onAdapter` callback to `startAcpAgent`.
- Invoked from `packages/tutorial-cli-client/src/agent/embed.ts:close`
- Triggered by `/quit` in `packages/tutorial-cli-client/src/bootstrap.ts`.

## 2.7 Why not `session/new` for the connectivity check?

ACP's `session/new` is the canonical "are you alive?" gesture — it
forces the agent to fetch its model catalog. But web-acp-agent's
`tryEnsureModels` (`packages/web-acp-agent/src/acp/handlers/adapter-context.ts:tryEnsureModels`)
**swallows** catalog-fetch errors and returns `[]`. This is
deliberate — sessions create successfully even with no models, and
the user can fix auth without the call dying.

For the host, this means an empty `models[]` is ambiguous: bad auth,
BodhiApp down, or genuinely empty catalog. To get a clean
"connection works" signal we route through `_bodhi/server/info` which
*doesn't* swallow.

## 2.8 Reference index

ACP submodule (cloned at the repo root as a git submodule):

- [`agent-client-protocol/docs/protocol/overview.mdx`](../../../agent-client-protocol/docs/protocol/overview.mdx) — connection lifecycle, the four-step kickoff (initialize → authenticate → session setup → prompt turn).
- [`agent-client-protocol/docs/protocol/initialization.mdx`](../../../agent-client-protocol/docs/protocol/initialization.mdx) — `initialize` request/response, capability bitmaps, auth method declaration.
- [`agent-client-protocol/docs/protocol/extensibility.mdx`](../../../agent-client-protocol/docs/protocol/extensibility.mdx) — `_meta`, `_`-prefixed methods, advertising custom capabilities.
- [`agent-client-protocol/docs/protocol/schema.mdx`](../../../agent-client-protocol/docs/protocol/schema.mdx) — wire-level types (the SDK we use generates from this).

web-acp-agent specs:

- `ai-docs/web-acp/specs/web-acp-agent/index.md` — package shape + ext-method registry.
- `ai-docs/web-acp/specs/web-acp-agent/acp.md` — the wire-shim layer.

Tutorial-CLI client-side call sites (file:method form):

- `packages/tutorial-cli-client/src/agent/embed.ts:createEmbeddedAgent` — builds the `EmbeddedAgent` with `initialize / authenticate / serverInfo / close`.
- `packages/tutorial-cli-client/src/bootstrap.ts:startAgent` — drives the four-call sequence after auth completes.
- `packages/tutorial-cli-client/src/dispatcher.ts:emitStatus` — re-runs `serverInfo` on `/bodhiapp:status`.

Chapter 4 covers how the `EmbeddedAgent` is wired to a real ACP
transport on both sides (in-memory duplex, services bag, SDK
connection objects) — i.e. what the agent runtime needs to actually
function inside the CLI process.
