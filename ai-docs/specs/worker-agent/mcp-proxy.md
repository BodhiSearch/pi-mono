# mcp-proxy

**Source of truth:** `packages/web-agent/src/worker-agent/worker/worker-host.ts` (helper), `packages/web-agent/src/worker-agent/rpc/` (protocol)

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

MCP tools live on the main thread (they need access to the user's MCP servers via the Bodhi JS client or similar). The Worker runs the agent; when the agent decides to call an MCP tool, the Worker **upcalls** the main thread, waits for the result, and hands it back to the agent.

The protocol has three parts:

- **Descriptor registration** — main thread sends plain-data `McpToolDescriptor[]` via `set_mcp_tools`. The Worker constructs proxy `AgentTool`s that emit upcalls.
- **Upcall** — when the agent invokes a proxy tool, the Worker emits a `tool_call_request` event carrying `{callId, toolName, args}` and suspends the tool's `execute` promise.
- **Response** — the main thread resolves the tool call and replies with a `tool_call_response` command; the Worker resumes the matching promise.

### Why descriptors, not closures

`AgentTool.execute` is a function. Functions don't cross `postMessage`. The descriptor-plus-upcall pattern is the structured-clone-safe way to let the agent call something that physically lives in another realm.

### Responsibilities

- **Worker side:** maintain a proxy `AgentTool` per descriptor, route invocations to `ToolUpcallInvoker`, normalise non-`{content}` results into a text content block, union with vault tools on `refreshTools`.
- **Main side:** register a `ToolCallHandler` that executes MCP tool calls, send `set_mcp_tools` when the descriptor set changes.

### Non-responsibilities

- MCP server discovery / connection (main-thread concern).
- Tool parameter validation (pi-agent-core handles this against `descriptor.parameters`).

## Technical reference

### `McpToolDescriptor`

Defined in `rpc/rpc-types.ts`:

```
interface McpToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, unknown>;  // JSON schema
}
```

Structured-clone safe. No `execute` in the descriptor — that's the whole point of the proxy.

### Proxy construction (`worker/worker-host.ts`)

A file-local `buildMcpProxyTool(descriptor, invoker)` helper wraps each descriptor into an `AgentTool`:

- `name`, `description`, `parameters` come from the descriptor.
- `execute({ arguments }, signal)` calls `invoker(descriptor.name, arguments)`.
- The raw result may be anything. The proxy normalises:
  - If the result is already `{ content: [...] }`, forward it unchanged.
  - Otherwise, wrap as `{ content: [{ type: 'text', text: JSON.stringify(result) }] }`.
- Errors from the invoker propagate as tool errors.

`WorkerAgentHost.setMcpTools(descriptors, invoker)`:

1. `this.mcpTools = descriptors.map(d => buildMcpProxyTool(d, invoker))`.
2. `refreshTools()` — pushes `[...vaultTools, ...mcpTools]` to the `AgentSession`.

Replacing the descriptor set is a full replace; there is no incremental add/remove. The main thread recomputes the full set and pushes it.

### `ToolUpcallInvoker` and the upcall pipeline

Declared in `rpc/rpc-server.ts`:

- `ToolUpcallInvoker = (toolName: string, args: unknown) => Promise<unknown>`.
- `HostEventSink = (event: RpcSynthesisedEvent) => void`.

`RpcServer` supplies the invoker when constructing the host's setter, binding it to `invokeUpcall(toolName, args)`:

1. Allocate `callId = 'upcall-${++upcallCounter}'`.
2. Store `{resolve, reject}` in `upcallPending[callId]`.
3. `transport.send({ type: 'tool_call_request', callId, toolName, args })`.
4. Return the pending promise.

On inbound `tool_call_response`:

- Look up `upcallPending[callId]`; drop if missing (server-disposed).
- `ok: true` → `resolve(result)`.
- `ok: false` → `reject(deserializeError(error))`.

On `RpcServer.dispose`, all pending upcalls are rejected.

### Client side (`rpc/rpc-client.ts`)

- `setToolCallHandler(handler: ToolCallHandler | null)` — register the function that will satisfy upcalls.
- `setMcpTools(tools: McpToolDescriptor[])` — send the `set_mcp_tools` command.
- `dispatch` intercepts inbound `tool_call_request` envelopes:
  - If no handler is registered, immediately reply with `tool_call_response { ok: false, error: 'No tool call handler registered' }`.
  - Otherwise, `handler({toolName, args, signal?})` and forward the outcome:
    - Success → `{ ok: true, result }`.
    - Throw / reject → `{ ok: false, error: serializeError(err) }`.

The handler's result is passed back through the same transport; the Worker's proxy tool sees it as a normal resolution.

### `ToolCallHandler` shape

```
type ToolCallRequestPayload = {
  callId: string;
  toolName: string;
  args: unknown;
  signal?: AbortSignal;
};

type ToolCallHandler = (req: ToolCallRequestPayload) => Promise<unknown>;
```

Host apps implement this by wrapping their MCP client. The typical implementation (see `packages/web-agent/src/hooks/useMcpAgentTools.ts`) looks up the tool by name in a client-side registry and delegates to the MCP runtime.

## Guarantees

1. **Descriptor-only on the wire.** No `execute` closures cross the transport.
2. **Full replace semantics.** Each `set_mcp_tools` fully replaces the worker-side tool set. Incremental delta is not part of the protocol.
3. **Errors round-trip.** Tool-handler exceptions reach the agent as `AgentTool.execute` rejections; the Worker never swallows them.
4. **Upcall cleanup on dispose.** `RpcServer.dispose()` rejects every pending upcall so dangling promises don't leak.

## Integration

- **Main thread:**
  - `useMcpAgentTools` hook (outside `worker-agent/`) derives the current descriptor list + handler from the Bodhi JS client's MCP state.
  - On change, calls `rpcClient.setMcpTools(descriptors)` and `rpcClient.setToolCallHandler(handler)`.
- **Worker:**
  - `WorkerAgentHost.setMcpTools(descriptors, invoker)` is invoked by the RPC server from the `set_mcp_tools` command.
  - `buildMcpProxyTool` wraps each descriptor; `refreshTools` pushes the union to the agent.

## Tests

- `worker/worker-host.test.ts` — integration path: `setMcpTools` with a fake invoker, prompt a fake agent to call the tool, verify the upcall and result.
- `rpc/rpc-server.test.ts` — upcall correlation and error round-trip.
- `rpc/rpc-client.test.ts` — handler dispatch, missing-handler fallback.

## Change procedure

Any plan that edits the MCP proxy path (proxy wrapper, `McpToolDescriptor`, `tool_call_request` / `tool_call_response` envelopes, `ToolCallHandler`) must update this file and the related sections of [`rpc.md`](./rpc.md) in the same PR. Adding fields to the descriptor requires:

1. Extending `McpToolDescriptor` in `rpc/rpc-types.ts`.
2. Threading the field through `buildMcpProxyTool`.
3. Updating the main-thread handler(s).
4. Reflecting the change here.

See [`./index.md` § Change procedure](./index.md#change-procedure).
