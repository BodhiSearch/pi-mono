# worker-host

**Source of truth:** `packages/web-agent/src/worker-agent/worker/worker-host.ts`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

`WorkerAgentHost` is the single concrete implementation of the `AgentSessionHost` contract the RPC server drives. It composes the other modules into a running agent:

- Wraps one [`AgentSession`](./agent-session.md) and its tool/streamFn state.
- Owns the ZenFS attach/detach lifecycle on the VFS `MessagePort`.
- Routes model catalog lookups (and session-restore resolution) through the injected `LlmProvider` — no worker-local catalog state.
- Delegates persistence to an injected [`SessionStore`](./sessions.md).
- Mounts [`vault tools`](./vault-tools.md) and [`MCP proxy tools`](./mcp-proxy.md) against the `AgentSession`.
- Persists messages at turn boundary and drives [`compaction`](./compaction.md).
- Delegates [`auth + catalog`](./llm-provider.md) to the injected `LlmProvider`.

The host is the "assembly" layer. It contains no LLM-provider code, no storage-engine code, and no UI code — each of those is an injected collaborator.

## Technical reference

### Construction

```
constructor(
  session: AgentSession,
  vfsPort: MessagePort,
  store: SessionStore,
  provider: LlmProvider,
  options?: WorkerAgentHostOptions
)
```

`WorkerAgentHostOptions` = `{ vaultMount?, compactionSettings? }`. Missing fields fall back to `VAULT_MOUNT` (`/vault`) and `DEFAULT_COMPACTION_SETTINGS` from `core/compaction/types.ts`.

The constructor wires a `session.subscribe` listener that runs the [turn-boundary persistence + auto-compaction pipeline](#turn-boundary-pipeline) on every `message_end` event for roles `user | assistant | toolResult`.

### Internal state

| Field | Purpose |
| --- | --- |
| `session` | The injected `AgentSession`. |
| `vfsPort` | MessagePort for ZenFS attach/detach. |
| `store` | The injected `SessionStore`. |
| `provider` | The injected `LlmProvider` — rotated via `setAuthToken`, consulted for `getApiKeyAndHeaders` during streams and compaction, and `getAvailableModels` during catalog RPCs, `setModel`, and session restore. |
| `vaultMount` | Mount path; defaults to `VAULT_MOUNT`. |
| `compactionSettings` | Merged with `DEFAULT_COMPACTION_SETTINGS`. |
| `vaultTools` / `mcpTools` | Tool arrays union'd into `session.setTools` via `refreshTools`. |
| `attachedFs` | `{ detach }` record for the current ZenFS mount, or `null`. |
| `sessionManager` | Active `SessionManager`; `null` until `newSession` / `loadSession`. |
| `hostEventSink` | Sink for synthetic Worker-side events (`session_loaded`, compaction events). |
| `writeChain` | Promise chain serialising store appends. |
| `compactionInFlight` | Single-flight guard. |
| `compactionAbort` | `AbortController` for the in-flight summarisation; aborted on session swap. |

### Agent pass-throughs

`prompt`, `abort`, `setSystemPrompt`, `reset`, `getState`, `getMessages`, `isStreaming`, `getStreamingMessage`, `getErrorMessage`, `subscribe` all delegate to the `AgentSession`.

### Model catalog routing

- `getAvailableModels()` — returns `this.provider.getAvailableModels()` (a `Promise<Model<Api>[]>`). The worker does not hold any state here; each call hits the provider.
- `resolveModel(provider, modelId)` — private. Fetches the catalog via `this.provider.getAvailableModels()` and finds the matching `{provider, id}` entry.
- `setModel(provider, modelId)` — awaits `resolveModel`, throws if unknown, updates `AgentSession`, and appends a `model_change` entry through `writeChain` **iff** the current branch's `(provider, modelId)` differs (identity dedup). Does NOT emit `session_loaded` — model-change entries don't shift any message entry ids, and re-emission mid-turn would reset the main thread's `streamingMessage` / `isStreaming` UI state.
- `restoreModelFromContext(ctxModel)` — private, async. Called from session load/fork/navigate. Awaits `resolveModel`; leaves the agent's model `undefined` if the catalog doesn't contain it (the main thread will see `session_loaded.model` still pointing at the identifier and can react — e.g. render a disabled combobox and surface an error).

### Auth rotation

`setAuthToken(credential)` simply delegates to `this.provider.setAuthToken?.(credential)`. The host is oblivious to the credential's internal shape beyond the `LlmAuthCredential` envelope from [`llm-provider.md`](./llm-provider.md).

### Vault lifecycle

See [`vault-tools.md`](./vault-tools.md) for the tool factories; host-side lifecycle is:

- `mountVault(handle)`:
  1. If a previous mount exists, `detachVault()`.
  2. `await WebAccess.create({ handle })`.
  3. `vfs.mount(vaultMount, webAccessFs)`.
  4. `attachFS(vfsPort, webAccessFs)`.
  5. Build `vaultTools` via `createVaultTools(createZenfsVaultOperations(), { cwd: vaultMount })`.
  6. `refreshTools()`.
- `mountDevSeed(seed: InMemoryVaultSeed)`:
  1. `detachVault()` if needed.
  2. `configure({ mounts: {} })`, `InMemory.create({ label: seed.name })`, mount at `vaultMount`.
  3. `mkdir -p` every parent directory, `writeFile` each seed path. `EEXIST` on mkdir is tolerated; other errors propagate.
  4. `attachFS(vfsPort, memFs)`, build + refresh tools.
- `unmountVault()` → `detachVault()` + clear `vaultTools` + `refreshTools()`.
- `detachVault()` (private) — best-effort `detachFS(vfsPort, fs)` then `vfs.umount(vaultMount)`.

### MCP proxying

- `setMcpTools(descriptors, invoker)` — each descriptor is wrapped by the file-local `buildMcpProxyTool(descriptor, invoker)` into an `AgentTool` whose `execute` issues the upcall and normalises non-`{content}` results into a text content block. Full protocol is in [`mcp-proxy.md`](./mcp-proxy.md).
- `refreshTools()` pushes `[...vaultTools, ...mcpTools]` to `session.setTools`.

### Session persistence surface

`setHostEventSink(sink)`, `listSessions`, `loadSession`, `newSession`, `forkSession`, `navigateToLeaf`, `deleteSession`, `setSessionName`, `getSessionMeta`. Each session-switch method follows the same pattern:

1. `compactionAbort?.abort()` — cancel any in-flight summarisation.
2. `await writeChain` — drain pending appends.
3. `session.abort()` — stop any streaming turn.
4. Load or mutate via `SessionManager` / `SessionStore`.
5. `session.reset()` + `session.restoreMessages(ctx.messages)` + `await restoreModelFromContext(ctx.model)`.
6. `emitSessionLoaded()` — includes the `{provider, id}` identifier from `ctx.model` in the envelope so the main thread does not need a follow-up `get_state`.

`deleteSession(id)` adds a special case: if the active session is deleted, the host auto-loads the parent (or calls `newSession()`) so the UI never lands on a blank state.

Entry semantics and store details are in [`sessions.md`](./sessions.md).

### Turn-boundary pipeline

The constructor's `session.subscribe` handler runs on every `message_end` for roles `user | assistant | toolResult`:

```
this.writeChain = this.writeChain.then(async () => {
  await sm.appendMessage(event.message);   // persist
  this.emitSessionLoaded();                // refresh main-thread entryId mapping
  await this.maybeCompact();               // may append CompactionEntry
});
```

Serialisation through `writeChain` is essential: two `message_end` events in the same microtask would otherwise both read the same `leafId` before either resolved its store append, leaving the second entry's `parentId` dangling.

### Compaction

- `compactNow()` → `runCompaction({ force: true })`.
- Private `maybeCompact()`:
  - Early-outs on `compactionInFlight` or no active `sessionManager`.
  - `contextWindow` = `compactionSettings.contextWindow ?? session.getModel()?.contextWindow ?? 128_000`.
  - If `shouldCompact(messages, contextWindow, settings)` returns true, calls `runCompaction({ force: false })`.
- Private `runCompaction({ force })`:
  1. Early-out if no session or already in-flight.
  2. Length gate: `path.length < settings.minEntriesToCompact && !force` → return.
  3. `prepareCompaction(path, settings, { force })` — returns `null` if there's nothing to compact.
  4. Emit `compaction_start` through the sink.
  5. `compactSummarize(preparation, model, { provider, signal })`. Model is `session.getModel()`; throws if unset.
  6. On success: `sm.appendCompaction(...)`, rebuild context via `buildSessionContext()`, `session.restoreMessages`, `emitSessionLoaded`, emit `compaction_end{success: true, tokensBefore}`.
  7. On error (non-abort): emit `compaction_end{success: false, errorMessage}`.
  8. Abort-signal aborts suppress both emissions (the session already moved on).
  9. `finally`: clear `compactionInFlight` and `compactionAbort`.

Full pipeline detail is in [`compaction.md`](./compaction.md).

### `emitSessionLoaded` helper

Private. Builds `{type: 'session_loaded', sessionId, header, name, messages, messageMeta, model}` from `SessionManager.getHeader()` + `getSessionName()` + `buildSessionContext()` and forwards through `hostEventSink`. The `model` field mirrors `ctx.model` as `{provider, id}` (or `null`) so the main thread can update its combobox directly. No-op if no sink or no session.

### `AgentSessionHost` interface

Declared in `rpc/rpc-server.ts`. `WorkerAgentHost` satisfies it structurally (optional members let test fakes implement a subset). Extending the host with a new capability generally means:

1. Add a method to `WorkerAgentHost`.
2. Declare it on `AgentSessionHost`.
3. Add an RPC command + response to [`rpc.md`](./rpc.md).
4. Add a `RpcClient` method.

## Tests

- `packages/web-agent/src/worker-agent/worker/worker-host.test.ts` — integration over the `AgentSessionHost` surface with a fake session + fake `LlmProvider`. Covers auth-token delegation (verifies `provider.setAuthToken` is invoked with the forwarded credential), catalog-driven `setModel` / session-restore resolution, session lifecycle, compaction triggering, and MCP upcall routing.

## Change procedure

Any plan that edits `worker/worker-host.ts` must update this file in the same PR. See [`./index.md` § Change procedure](./index.md#change-procedure).
