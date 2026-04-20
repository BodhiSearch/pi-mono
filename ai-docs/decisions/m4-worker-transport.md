# M4 — Worker transport decisions

Date: 2026-04-20

## D7. Single agent Worker hosts both AgentSession and ZenFS; dual MessageChannels

**Decision:** the page spawns exactly one Web Worker (Vite-bundled ES module worker, named `web-agent`). Inside it lives the AgentSession, the six vault tools, and the real ZenFS backend (WebAccess for production, InMemory for the dev seed). Communication between main and worker uses two separate MessageChannels:

- **ChannelA** — agent RPC. Existing `RpcServer`/`RpcClient`/`RpcEventEnvelope` protocol carries `prompt`, `abort`, `set_model`, `mount_vault`, `set_auth_token`, `set_mcp_tools`, `tool_call_response`, etc.
- **ChannelB** — ZenFS Port backend. Worker calls `attachFS(vfsPort, fs)`; main calls `Port.create({ port: vfsPort })`. Internal ZenFS protocol; we don't see or marshal individual fs ops.

Both ports are transferred together in a single tagged init message: `{ type: '__webAgent_init', agentPort, vfsPort, devSeed?, transferList: [agentPort, vfsPort] }`.

**Why:** dual channels keep each protocol clean of the other's shape. The Worker boot is the only place that knows about both. Vault tools execute fully Worker-side with no per-tool RPC hop. UI consumers (`useVaultTree`, `FileViewer`, `MarkdownEditor`) keep their existing `fs.promises.*` API — the Port backend is transparent to them. Phase 6 extraction stays clean: the package exports `getAgentWorker()` and the consumer wires the Provider; nothing about the API surface changes.

**Alternatives rejected:**
- *Single channel multiplexed with a discriminator*: ZenFS Port backend's protocol doesn't include our envelope tag and doesn't expect to share a port. Multiplexing means writing a protocol gateway; dual channels means zero protocol code.
- *Per-tool RPC proxy with ZenFS staying main-thread*: every read/write/edit becomes an extra postMessage hop, multiplied by tool calls per turn. Loss in throughput + main-thread contention; gain only in saving ~5 lines of channel setup.
- *Worker per session*: deferred. Single Worker per page is right while session count is 1; M5/M6 may revisit if multi-session UX needs isolation.

## D8. MCP tools upcall to main via the agent RPC channel; vault tools execute Worker-side

**Decision:** vault tools (the six fs tools) run entirely inside the Worker — their closures close over the Worker-local ZenFS instance, no RPC hop per call. MCP tools work differently: main thread builds plain `McpToolDescriptor` records (`{ name, description, parameters }`) and ships them to the Worker via `set_mcp_tools`. The Worker constructs proxy tools whose `execute` posts a `tool_call_request` event over ChannelA. Main's `RpcClient.setToolCallHandler` receives the upcall, runs the actual MCP HTTP call (using the bodhiClient + auth token from React context), and replies via `tool_call_response`.

**Why:** MCP clients are constructed via `createMcpClient(bodhiClient, mcp.path)` where `bodhiClient` is React-context-bound (auth tokens, session state). Hoisting MCP clients into the Worker would require re-implementing the auth refresh + bodhi-client construction Worker-side, and would couple the Worker to `@bodhiapp/bodhi-js-react`. The upcall pattern keeps the Worker dep-clean (no React-context awareness) and *also* establishes the exact pattern M8 extensions will use for sandboxed tools whose implementation lives outside the Worker boundary.

**Alternatives rejected:**
- *Hoist MCP clients into the Worker*: works but pulls bodhi-react into the Worker bundle and forces auth-rotation via `set_auth_token` semantics across two systems instead of one.
- *No upcall — proxy tools throw "not implemented"*: makes MCP tools unusable from the agent; defeats the existing M3 functionality.

## D9. Envelope-tagged transport with structured error round-trip — cribbed from Comlink

**Decision:** the new `worker.ts` transport posts every init payload as `{ type: '__webAgent_init', ... }`; the receiver's `isAgentWorkerInit` rejects anything that doesn't match. Error responses on the agent RPC channel ship a `SerializedError` payload `{ name, message, stack? }` (not a stringified message); the client `deserializeError` rehydrates it as a real `Error` so callers can `instanceof Error` and inspect the original stack frames.

**Why:** the agent RPC channel is dedicated today, but M8 will route extension messages through related channels into the same Worker; tagging the init envelope up front prevents future cross-talk debugging. Structured errors matter more across a real Worker boundary because the stack frames from inside the Worker are the only clue when something fails inside the agent loop or a tool — losing them to `String(err)` made the M3 debugging significantly harder than it needed to be.

**Alternatives rejected:**
- *Untagged init message*: works today, breaks the day a second protocol shares the global `self.onmessage`. Cheap to add now, hard to retrofit.
- *Comlink dependency*: 1.1KB and proven, but replacing the existing hand-rolled RPC dispatcher would mean rewriting `rpc-server.ts`, `rpc-client.ts`, `rpc-types.ts`, and the existing `rpc.test.ts` for marginal ergonomic gain. We crib the patterns (envelope tagging, structured errors) without the dependency.
- *Round-trip the entire `Error` object via structured clone*: Errors aren't structured-cloneable. Comlink uses the same `{ name, message, stack }` shape we adopted.
