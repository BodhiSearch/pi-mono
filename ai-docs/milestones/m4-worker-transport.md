# M4 — Worker transport

**Status:** ✅ done (`8fa325a6`). Test seam: +2 vitests (worker transport + structured error round-trip); existing 3 e2e specs unchanged.

**Why now.** Locks in structured-clone discipline before we add more state (sessions, compaction, extensions). Moving to a Worker later becomes a bigger rewrite the longer we wait.

**Scope preview (historical).**
- Spawn an agent Worker from the app; instantiate `AgentSession` + RPC server inside.
- Implement `createWorkerTransportPair()` backed by a `Worker` + `MessagePort`, same `Transport` interface as `createInProcessTransportPair()`.
- Decide mount location for ZenFS handles: main thread + proxy vs. Worker-side mount. Benchmark + verify FSA handle transferability, record decision in `../05-decisions.md`.
- Proxy-tool pattern: tools carrying closures become host-side stubs that RPC back to the main thread.

**Coding-agent references.** `packages/coding-agent/src/modes/rpc/rpc-mode.ts` for the stdio transport pattern — we mirror the dispatcher shape; the transport itself is ours.

**Gate.** All previously green tests stay green. No new functional tests — this is purely an architectural shift.

## Outcome

What landed:

- **Single agent Worker per tab.** Spawned via Vite's native `new Worker(new URL('./agent-worker.ts', import.meta.url), { type: 'module' })` from a module-singleton in `src/web-agent/worker/boot.ts`. Hosts AgentSession + the real ZenFS mount + the six vault tools. Boot returns `{ rpcClient, vfsPort, worker }` for the rest of the app.
- **Dual MessageChannels.** ChannelA (agent RPC, existing protocol) and ChannelB (ZenFS Port backend, ZenFS-internal protocol) — both transferred together in a single tagged init message. Cribbed from Comlink: every init envelope carries `type: '__webAgent_init'` and is matched by `isAgentWorkerInit` so the worker ignores unrelated messages.
- **ZenFS Port backend.** Worker runs the real backend (`@zenfs/dom`'s `WebAccess` wrapping the FSA handle, or `@zenfs/core`'s `InMemory` for the dev seed). Main thread runs `Port.create({ port: vfsPort })` so every `fs.promises.*` call from `useVaultTree` / `FileViewer` / `MarkdownEditor` auto-marshals over the channel. UI consumers' code didn't change.
- **WorkerAgentHost** (`src/web-agent/worker/worker-host.ts`) implements `AgentSessionHost` for the Worker side: passthrough delegates for the existing surface, plus `mountVault`, `unmountVault`, `mountDevSeed`, `setMcpTools`, `setAuthToken`. Vault tools execute fully inside the Worker against worker-local ZenFS — no per-call RPC hop.
- **MCP tool upcall pattern.** MCP clients hold the bodhiClient + auth context (React-context-bound), so they stay on main. Worker host builds plain proxy tools whose `execute` emits a `tool_call_request` event over ChannelA; main's `RpcClient.setToolCallHandler` runs the actual MCP call and posts back a `tool_call_response`. This is the same pattern M8 extensions will use for sandboxed tools.
- **`set_auth_token` push.** Auth tokens are mutated on main (React's `useBodhi` hook). `useAgent` pushes them to the Worker via `rpcClient.setAuthToken(token)` on every change. The Worker's `streamFn` closes over `session.getAuthToken()` and reads synchronously per request — no upcall on the streaming hot path.
- **Structured error round-trip.** `serializeError` / `deserializeError` (`src/web-agent/rpc/error.ts`) preserve `{ name, message, stack }` across the boundary so tool / mount / model errors surface in the chat UI with their original stack frames. RpcResponse error shape changed from `error: string` to `error: SerializedError`.
- **`bootInProcess` fallback** for jsdom/vitest: when `Worker` is undefined the boot module spawns a local AgentSession + WorkerAgentHost paired through `createInProcessTransportPair`. Same RpcClient API, no real thread separation. Keeps `App.test.tsx` smoke-rendering without a Worker shim.
- **New tests.** `src/web-agent/rpc/error.test.ts` (5 tests, error round-trip) + `src/web-agent/rpc/transports/worker.test.ts` (3 tests, init envelope + transferable ports + channel echo). 70/70 vitests pass; existing 3 e2e specs unchanged.
- **Refactors.** `useVaultTools` deleted (vault tools now Worker-side). `useMcpAgentTools` returns `{ descriptors, handler }` instead of `AgentTool[]`. `WebAgentProvider` mounts the boot singleton near the React root; `VaultProvider` consumes the rpcClient + vfsPort via context. `in-memory-vault.ts` shrunk to a `readDevSeed()` helper.

Surprises worth remembering:

- **Both ends of a transferred MessagePort need `port.start()`.** ZenFS `RPC.from(channel)` uses `addEventListener('message', ...)` which queues messages until `start()` runs. Without explicit start on either side, `PortFS.ready()` would `RPC request timed out` after the default 250ms even though both sides looked correctly wired. Fix: call `port.start()` in `agent-worker.ts` for the worker side and inside `mountVaultPort` for the main side. Worth bumping PortFS timeout from 250ms to 5000ms anyway — first round-trip can race the Worker module evaluation.
- **`FileSystemDirectoryHandle` is structured-cloneable but not transferable.** `worker.postMessage(handle)` deep-clones the handle; both threads end up with their own clone over the same underlying entry. Permission state IS shared via the entry, so a `requestPermission({ mode: 'readwrite' })` granted on main is visible to the worker's clone — no second user gesture needed. Verified with `handle.queryPermission()` in the worker returning `'granted'` immediately.
- **VaultProvider's mount-trigger effect must not await its own state transitions.** First version used `setMountState({ tag: 'mounting' })` then `await rpcClient.mountVault(handle)` then `setMountState({ tag: 'mounted' })` inside one effect. The first `setState` re-runs the effect; the prior run's cleanup sets `cancelled = true`; the await resolves, but `if (cancelled) return` skips the final transition — so the UI stayed at `mounting` forever. Fix: pull the mount call out of the effect lifecycle entirely; track in-flight by handle reference via a ref.
- **Worker logs don't show in the page console via Claude in Chrome's `read_console_messages`.** During debug, forwarded debug messages back to main via `worker.postMessage({ __debug: '...' })` and had main's `worker.onmessage` re-emit via `console.log`. Useful pattern when debugging tool that can only see the page console. Removed from the final code.
- **Vite's worker import** (`new Worker(new URL('./agent-worker.ts', import.meta.url), { type: 'module' })`) bundles the worker into its own chunk. Worker chunk is ~1.9MB unminified (carries pi-ai's 30+ provider adapters + ZenFS WebAccess) — splitting moves it off the main entry but doesn't shrink either side; future work for a separate milestone.
