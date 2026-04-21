# rpc

**Source of truth:** `packages/web-agent/src/worker-agent/rpc/`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

The `rpc/` subtree is the wire protocol between the main thread and the Worker-side agent runtime. It has four parts:

- **Protocol shapes** (`rpc-types.ts`) — commands, responses, event envelopes.
- **Server** (`rpc-server.ts`) — translates incoming commands into `AgentSessionHost` method calls, wraps agent events + synthetic host events into envelopes.
- **Client** (`rpc-client.ts`) — issues correlated commands, dispatches envelopes to listeners, services main-thread tool upcalls.
- **Transport** (`transport.ts`, `transports/in-process.ts`, `transports/worker.ts`) — the pluggable `send`/`onMessage` boundary that sits under both sides.

The RPC layer is transport-agnostic and framework-agnostic. The same `RpcClient` works over an in-process `MessageChannel` (jsdom fallback) and a cross-thread Worker `MessagePort` (browser).

### Invariants

- **Structured-clone safe.** Every payload on the wire survives `postMessage`. No closures; no `AgentTool.execute` closures (MCP tools ship as plain descriptors and upcall).
- **Correlated request/response.** Commands carry an `id`, responses echo it. Events are unsolicited and carry no `id`.
- **Typed errors.** Errors are serialised via `serializeError` / `deserializeError`; callers get real `Error` instances on reject.

## Wire protocol

### Commands (main → worker)

Declared in `rpc-types.ts` as the `RpcCommand` union. Each command has an `id` field for correlation:

| Command | Payload | Purpose |
| --- | --- | --- |
| `prompt` | `message: string` | Start a turn. |
| `abort` | — | Cancel the current turn. |
| `reset` | — | Reset agent state. |
| `get_state` | — | Snapshot `RpcSessionState`. |
| `get_messages` | — | Full message list. |
| `set_model` | `provider`, `modelId` | Resolve + set active model. |
| `get_available_models` | — | List registry. |
| `set_available_models` | `models: Model<Api>[]` | Seed registry from main thread. |
| `set_system_prompt` | `prompt: string` | Configure system prompt. |
| `set_auth_token` | `credential: LlmAuthCredential \| null` | Rotate the auth credential. |
| `mount_vault` | `handle: FileSystemDirectoryHandle` | Mount FSA handle. |
| `unmount_vault` | — | Detach current mount. |
| `set_mcp_tools` | `tools: McpToolDescriptor[]` | Register MCP proxy tools. |
| `tool_call_response` | `callId`, `ok`, `result` or `error` | Reply to a Worker upcall. |
| `list_sessions` | — | Session list for the picker. |
| `load_session` | `sessionId` | Restore a session. |
| `new_session` | `parentSession?` | Create a session. |
| `delete_session` | `sessionId` | Delete; auto-lands on parent if active. |
| `set_session_name` | `name: string` | Rename. |
| `get_session_meta` | — | Active session's `SessionMeta`. |
| `fork_session` | `fromEntryId` | Fork at entry. |
| `navigate_to_leaf` | `entryId` | Ephemeral leaf move. |
| `compact_now` | — | Manual compaction trigger. |

### Responses (worker → main)

`RpcResponse` union in `rpc-types.ts`. Every command has a matching `{ id, type: 'response', command, success: true, data? }` variant; failures collapse into `{ id, type: 'response', command, success: false, error: SerializedError }`.

Commands that return payloads (`get_state`, `get_messages`, `set_model`, `get_available_models`, `list_sessions`, `new_session`, `fork_session`, `get_session_meta`) populate `data`.

### Events (worker → main, unsolicited)

`RpcEventEnvelope` union:

- `RpcAgentEventEnvelope` (`type: 'event'`) — wraps one pi-agent-core `AgentEvent` plus a state snapshot (`messages`, `isStreaming`, `streamingMessage`, `errorMessage`) so the main thread can reflect UI state off a single envelope without follow-up `get_*` commands.
- `RpcToolCallRequest` (`type: 'tool_call_request'`) — MCP tool upcall; `{callId, toolName, args}`. Flow in [`mcp-proxy.md`](./mcp-proxy.md).
- `RpcSessionLoadedEvent` (`type: 'session_loaded'`) — full restored session: `{sessionId, header, name, messages, messageMeta}`. Emitted at session switch, model-registry reseed (if a session was already active), and after a successful compaction.
- `RpcCompactionEvent` (`type: 'compaction_start' | 'compaction_end'`) — compaction lifecycle; `compaction_end` carries `{success, tokensBefore?, errorMessage?}`.

### Shared types

- `McpToolDescriptor = { name, description, parameters }`.
- `RpcSessionState = { isStreaming, messageCount, model?, errorMessage? }`.
- `UiMessageMeta = { entryId?, kind?, tokensBefore?, firstKeptEntryId? }` — per-message metadata aligned with the `messages` array.

## Technical reference

### `Transport` (rpc/transport.ts)

Minimal interface:

- `send(message: unknown): void`
- `onMessage(handler): () => void` (returns unsubscribe)
- `close?(): void`

Any implementation that survives `postMessage` works. The two canonical pairs:

- **`transports/in-process.ts::createInProcessTransportPair()`** — wraps both ends of a single `MessageChannel`. Used by `boot.ts::bootInProcess` (jsdom fallback) and by unit tests.
- **`transports/worker.ts::createWorkerTransportPair(worker, options)`** — spawns an agent `MessageChannel` (`channelA`) and a VFS `MessageChannel` (`channelB`), transfers `channelA.port2` + `channelB.port2` to the Worker inside a single tagged `AgentWorkerInit` message, and wraps `channelA.port1` as the main-thread `Transport`. `channelB.port1` is returned separately as the `vfsPort` for the ZenFS Port backend to mount against. See [`worker-boot.md`](./worker-boot.md).

### `RpcClient` (rpc/rpc-client.ts)

Typed facade over a `Transport`. Responsibilities:

- Allocate command `id`s (`rpc-${++idCounter}`) and resolve `pending` promises on matching responses (`dispatch`).
- Fan out events to registered listener sets: `listeners` (agent events), `sessionLoadedListeners`, `compactionListeners`.
- Service incoming `tool_call_request` upcalls via a registered `toolCallHandler`; on missing handler, returns a `tool_call_response` with an error.
- Dispose lifecycle: `unsubscribe` from transport, reject pending promises, clear all listener sets.

Notable methods:

- `prompt`, `abort`, `reset`, `getState`, `getMessages`, `setModel`, `getAvailableModels`, `setAvailableModels`, `setSystemPrompt`.
- `setAuthToken(credential: LlmAuthCredential | null)` — sends `set_auth_token`. The envelope shape is the RPC contract; construction lives in the main-thread integration (`packages/web-agent/src/hooks/useAgent.ts`).
- `mountVault`, `unmountVault`, `setMcpTools`, `setToolCallHandler(handler | null)`.
- `subscribe(listener)`, `onSessionLoaded(listener)`, `onCompactionEvent(listener)` — each returns an unsubscribe closure.
- Session surface: `listSessions`, `loadSession`, `newSession`, `deleteSession`, `setSessionName`, `getSessionMeta`, `forkSession`, `navigateToLeaf`, `compactNow`.

Internal helpers: `send(cmd)` assigns the `id` and stores a `Pending`. `isEnvelope(value)` filters inbound messages to known envelope types before dispatch.

### `RpcServer` (rpc/rpc-server.ts)

Binds a `Transport` to an `AgentSessionHost`. Responsibilities:

1. On construction, subscribes to `transport.onMessage(handleCommand)` and `session.subscribe(event → transport.send(RpcAgentEventEnvelope))`. Also calls `session.setHostEventSink?(event => transport.send(event))` so synthetic events (`session_loaded`, compaction lifecycle) flow through the same transport.
2. `handleCommand(raw)` is the big `switch` over `RpcCommand['type']`; each case calls the matching `AgentSessionHost` method and sends a typed response.
3. For MCP: `invokeUpcall(toolName, args)` allocates an `upcall-${++upcallCounter}` id, emits a `tool_call_request` event, and resolves on matching `tool_call_response` commands. The resolver is held in `upcallPending`.
4. `dispose()` flips `disposed = true`, unsubscribes, rejects pending upcalls.

`isRpcCommand(value)` guards against unrelated inbound messages; `KNOWN_COMMANDS` table is the authoritative list (adding a command means updating both `RpcCommand` union and this table).

### `AgentSessionHost` (rpc/rpc-server.ts)

Narrow contract the server drives. `WorkerAgentHost` satisfies it structurally. Core methods are required:

- `prompt`, `abort`, `setModel`, `setAvailableModels`, `getAvailableModels`, `setSystemPrompt`, `reset`, `getState`, `getMessages`, `isStreaming`, `getStreamingMessage`, `getErrorMessage`, `subscribe`.

Optional members let test fakes implement subsets:

- `setAuthToken`, `mountVault`, `unmountVault`, `setMcpTools`.
- `listSessions`, `loadSession`, `newSession`, `deleteSession`, `setSessionName`, `getSessionMeta`, `forkSession`, `navigateToLeaf`.
- `compactNow`.
- `setHostEventSink(sink)`.

### Error marshalling (rpc/error.ts)

- `serializeError(err): SerializedError` — flattens to `{ name, message, stack?, cause? }`.
- `deserializeError(payload): Error` — reconstructs an `Error` on the client side so callers see real exceptions.
- `SerializedError` is the type carried inside failed responses and tool-upcall errors.

## Tests

- `rpc/rpc-server.test.ts`, `rpc/rpc-client.test.ts`, `rpc/error.test.ts`, `rpc/transports/*.test.ts` (where present).
- `worker/worker-host.test.ts` exercises the server+host combination against a fake session.

## Change procedure

Any plan that changes `rpc/` (adds/removes a command, alters an envelope shape, changes a transport factory) must update this file in the same PR. When adding a command:

1. Extend the `RpcCommand` / `RpcResponse` unions in `rpc-types.ts`.
2. Add the command name to the `KNOWN_COMMANDS` table in `rpc-server.ts`.
3. Handle it in `RpcServer.handleCommand`.
4. Extend `AgentSessionHost` (required or optional).
5. Add a method to `RpcClient`.
6. Reflect the change in the table above.

See [`./index.md` § Change procedure](./index.md#change-procedure).
