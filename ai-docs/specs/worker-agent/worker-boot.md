# worker-boot

**Source of truth:** `packages/web-agent/src/worker-agent/worker/`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

`worker/` holds the three files that stand up the Worker runtime and hook it to the main thread:

- **`init-protocol.ts`** — tagged init-message contract between main and Worker.
- **`agent-worker.ts`** — the Web Worker entry module. Boots on the first valid init message.
- **`boot.ts`** — main-thread singleton boot; chooses between a real `Worker` and an in-process fallback.

Goals:

- **Singleton on the main thread.** React StrictMode and Vite fast-refresh both double-invoke boot paths; the singleton guard keeps exactly one Worker alive per page.
- **jsdom / test parity.** When `Worker` is absent or construction throws, the same `RpcClient` returns from an in-process pair against a local `AgentSession` + `WorkerAgentHost` (minus a usable VFS port).
- **One-shot init.** The Worker receives one tagged message carrying both `MessagePort`s and any dev-seed / options payload; per-channel traffic flows over the ports after that.

## Technical reference

### `init-protocol.ts`

- `AGENT_WORKER_INIT_TYPE = '__webAgent_init'` — unique discriminator.
- `AgentWorkerInit`: `{ type, agentPort: MessagePort, vfsPort: MessagePort, devSeed?: InMemoryVaultSeed, options?: WebAgentOptions }`.
- `InMemoryVaultSeed`: `{ files: Record<string, string>, name: string }`. Dev / Playwright seed.
- `WebAgentOptions`: `{ vaultMount?, sessionsDbName? }`. Forwarded into the Worker so both sides agree on concrete values.
- `isAgentWorkerInit(value)` — type guard. Used by `agent-worker.ts` to ignore unrelated cross-library messages.

### `agent-worker.ts` (Web Worker entry)

Single top-level `self.addEventListener('message', ...)` that filters via `isAgentWorkerInit` and invokes `boot(agentPort, vfsPort, devSeed, options)`.

`boot()` sequence:

1. `new BodhiAuthProvider()` from `../../worker-bodhi`. **This is one of the two files under `worker-agent/` allowed to import a concrete auth provider;** the other is `boot.ts`.
2. `new AgentSession()` (no constructor options — auth flows through the injected `streamFn`).
3. `session.setStreamFn(createStreamFn(authProvider))` from [`llm-auth.md`](./llm-auth.md).
4. `vfsPort.start()` — listeners require explicit start.
5. Construct the session store: `new DexieSessionStore(new WebAgentDB(options?.sessionsDbName ?? DEFAULT_DB_NAME))`.
6. `new WorkerAgentHost(session, vfsPort, store, authProvider, { vaultMount: options?.vaultMount })`.
7. `agentPort.start()` + build an ad-hoc `Transport` wrapping it + `new RpcServer(transport, host)`.
8. If `devSeed` is present, `await host.mountDevSeed(devSeed)`; errors are logged but not fatal.
9. Best-effort `indexedDB.deleteDatabase('web-agent-sessions')` cleans up the legacy M5 ZenFS-backed DB.

Error handling is best-effort: the listener wraps boot in a `.catch` and logs; nothing else runs until init arrives.

### `boot.ts` (main-thread entry)

- **`getAgentWorker(options?: GetAgentWorkerOptions)`** — returns the cached `AgentWorkerBoot = { rpcClient, vfsPort, worker }`. First call spawns; subsequent calls reuse.
- **`_resetAgentWorkerForTests()`** — clears the singleton. Test-only.
- **`disposeAgentWorker()`** — on page unload / explicit teardown. Disposes `rpcClient`, terminates the `Worker` (if any), clears the singleton.

`bootOnce(options)` branches on `typeof Worker`:

- **Worker available:** `new Worker(new URL('./agent-worker.ts', import.meta.url), { type: 'module', name: 'web-agent' })`. Error listeners log `error` and `messageerror` events. Wires transports via `createWorkerTransportPair(worker, { devSeed, agentOptions })`. Returns `{rpcClient: new RpcClient(client), vfsPort, worker}`.
- **Worker absent or construction throws:** falls through to `bootInProcess(agentOptions)`. jsdom hits this path; the `catch` is necessary because some runners stub `typeof Worker !== 'undefined'` but explode on `new Worker(...)`.

`bootInProcess(agentOptions)` stands up a self-contained RPC pair on the main thread:

1. `new BodhiAuthProvider()` (second of two allowed imports).
2. `new AgentSession({})`.
3. `session.setStreamFn(createStreamFn(authProvider))`.
4. `makeFakePort()` — returns `MessageChannel().port1` when available, else a no-op shim. The in-process fallback does not expose a usable VFS port; vault tools won't work, but the agent does.
5. `new WorkerAgentHost(session, fakePort, new MemorySessionStore(), authProvider, { vaultMount: agentOptions?.vaultMount })`.
6. `createInProcessTransportPair()` → `new RpcServer(serverT, host)` (server retains itself via transport listener closure).
7. Returns `{rpcClient: new RpcClient(clientT), vfsPort: null, worker: null}`.

### `AgentWorkerBoot` shape

Exported from `boot.ts`:

```
{
  rpcClient: RpcClient;
  vfsPort: MessagePort | null;  // null in the in-process fallback
  worker: Worker | null;        // null in the in-process fallback
}
```

### Integration with the main thread

The host app typically:

1. Calls `getAgentWorker({ devSeed, agentOptions })` once (e.g. inside a React `WebAgentProvider`).
2. When `vfsPort` is non-null, calls `mountVaultPort(vfsPort)` from [`vault-tools.md`](./vault-tools.md) to stand up the main-thread PortFS proxy at `VAULT_MOUNT`.
3. Subscribes to `rpcClient` events and issues commands as user interactions occur.
4. Calls `disposeAgentWorker()` on unload.

## Constraints

- Only `agent-worker.ts` and `boot.ts` may import concrete auth providers. Everything else under `worker-agent/` depends on [`LlmAuthProvider`](./llm-auth.md).
- The init message must carry both ports; splitting into two messages would race the Worker's `message` listener against the first post.
- `agent-worker.ts` must tolerate arbitrary cross-library `postMessage` noise (the `isAgentWorkerInit` guard is not optional).

## Tests

- `worker/worker-host.test.ts` exercises the host in-process (same path `bootInProcess` uses).
- E2E (`packages/web-agent/e2e/`) exercises the real `Worker` path end-to-end.

## Change procedure

Any plan that edits `worker/init-protocol.ts`, `worker/agent-worker.ts`, or `worker/boot.ts` must update this file in the same PR. Boot-shim changes that swap or extend the concrete auth provider should also update [`../worker-bodhi/`](../worker-bodhi/index.md) or introduce a new provider folder and reference it from the top-level [`../README.md`](../README.md).

See [`./index.md` § Change procedure](./index.md#change-procedure).
