# Startup sequence — browser host boot

**Source of truth:** `packages/web-acp/src/`.

## Purpose

The end-to-end browser-host boot narrative — React mount,
Bodhi auth, runtime singleton mount, FSA volume resolution,
worker spawn, ACP handshake, first prompt. The host-neutral
agent-side wire flow lives at
[`../web-acp-agent/startup-sequence.md`](../web-acp-agent/startup-sequence.md);
this file links into it at the moment the agent takes over.

## Actors

| Actor | Thread | File | Owns |
| --- | --- | --- | --- |
| `App` / `AppContent` | main | `App.tsx` | Mounts `BodhiProvider`; auto-opens setup modal. |
| `@bodhiapp/bodhi-js-react` (`useBodhi`) | main | (dep) | OAuth 2.1 flow, token storage, `auth.accessToken`. |
| `ChatDemo` | main | `components/chat/ChatDemo.tsx` | Calls `useAcp()`. |
| `useAcp` (facade) | main | `hooks/useAcp.ts` | Composes the eight slice hooks. |
| `useAcp{Runtime,Auth,Models,Features,Mcp,Session,Streaming}` | main | `hooks/useAcp*.ts` | Per-concern slices — see [`hooks.md`](./hooks.md). |
| `AcpRuntime` singleton | main | `acp/runtime.ts` | Worker, `AcpClient`, `MainZenfs`, `volumeControl`, init promise. |
| `streamingReducer` | main | `acp/streaming-reducer.ts` | Pure reducer over `session/update`. |
| `AcpClient` | main | `acp/client.ts` | Typed wrapper over `ClientSideConnection`. |
| `MessageChannel` (`port1`, `port2`) | shared | (browser) | Transport primitive. |
| `createMessagePortStream` | either | `runtime/transport/worker-stream.ts` | Byte-stream wrapper around a `MessagePort`. |
| `ndJsonStream` (`@agentclientprotocol/sdk`) | either | (dep) | NDJSON framing. |
| Worker boot shim | worker | `agent/agent-worker.ts` | Receives `init`, calls `startAcpAgent`. |
| Bodhi server | remote | — | OAuth, `/bodhi/v1/models`, LLM streaming endpoints. |

The worker side then runs the host-neutral agent flow at
[`../web-acp-agent/startup-sequence.md`](../web-acp-agent/startup-sequence.md).

## Phase 0 — React mount

1. `main.tsx` renders `<App />`.
2. `App` wraps `<AppContent>` in `<BodhiProvider>` from
   `@bodhiapp/bodhi-js-react`, passing `authClientId`,
   `authServerUrl`, `basePath` from `env.ts`.
3. `AppContent` calls `useBodhi()`. If Bodhi isn't connected,
   the setup modal auto-opens; otherwise the OAuth refresh
   token (if any) is exchanged silently. After auth resolves,
   `auth.accessToken` is non-null and `isAuthenticated`
   flips true.
4. `<ChatDemo>` mounts inside `AppContent`. It calls
   `useAcp()`.

## Phase 1 — Runtime singleton + worker spawn

`useAcp` mounts the eight slice hooks (order documented at
[`hooks.md`](./hooks.md) § facade). `useAcpRuntime` calls
`acp/runtime.ts:ensureRuntime()` (`:34`) inside an effect.

`ensureRuntime`:

1. Returns the cached `_runtime` if set. (StrictMode
   double-mount and HMR re-enter the effect; the cache means
   we never spawn a second worker per tab.)
2. **Spawns the Worker.** `new Worker(new URL('../agent/agent-worker.ts',
   import.meta.url), { type: 'module' })`. Vite resolves the
   URL into the bundled worker chunk.
3. **Builds the `MessageChannel`.** `port2` will travel to
   the worker; `port1` stays on the main thread.
4. **Defers the `init` post.** A `Promise<void>` plus a
   `resolveInit: (volumes: HostVolumeInit[]) => void`
   function. The actual `worker.postMessage({ type: 'init',
   agentPort: port2, volumes }, [port2])` is **not** sent
   until `useVolumes` resolves the initial volume list.
   Without this defer the `ClientSideConnection` would
   dispatch requests into a worker that hasn't constructed
   the agent yet.
5. **Wraps `port1`.** `createMessagePortStream(port1)` →
   `{ readable, writable }`. `ndJsonStream(writable, readable)`
   frames the byte streams.
6. **Constructs the SDK connection.** A holder pattern lets
   the `Client` handler reference the `AcpClient` even
   though `ClientSideConnection` calls `toClient()`
   synchronously before the wrapper exists:

```ts
const holder: { client?: AcpClient } = {};
const fsHandlers = buildFsHandlers({ view: { list: () => mainZenfs.list() } });
const handler: Client = {
    requestPermission: requestPermissionStub,
    async sessionUpdate(params) { holder.client?.dispatchSessionUpdate(params); },
    async readTextFile(params) { return fsHandlers.readTextFile(params); },
    async writeTextFile(params) { return fsHandlers.writeTextFile(params); },
};
const conn = new ClientSideConnection(() => handler, stream);
const client = new AcpClient(conn);
holder.client = client;
```

7. **Initialises the chain.** `initialize = initPromise.then(() =>
   client.initialize()).then(() => undefined)`. The promise
   resolves only after both volumes have been pushed *and*
   the ACP handshake completes.
8. **Wraps `volumeControl`.** `createVolumeControl(worker)`
   gives the main thread a typed mount/unmount client over
   the raw-postMessage volume sidechannel. The wrap layer
   `wrapVolumeControl(inner, mainZenfs)` mirrors every mount/unmount
   onto the `MainZenfs` mirror so `fs/*` handlers stay in
   sync.
9. Caches `_runtime = { worker, client, volumeControl,
   mainZenfs, initialize, resolveInit }`. Returns it.

## Phase 2 — Volume resolution + init post

`useAcpRuntime` also wraps `useVolumes({ volumeControl,
onInitialVolumes: handleInitialVolumes })`. The `useVolumes`
boot effect (see [`volumes.md`](./volumes.md)):

1. `loadHandles()` — pull persisted FSA records from IDB
   (`web-acp:volumes` key).
2. `readDevSeeds()` — peek at `window.__zenfsSeed` (DEV-only
   priming for Playwright + DevTools).
3. `requestPermissions(records)` — re-request `readwrite`
   per handle. Partition into `ready` / `prompt` buckets.
4. Build `initialEntries: VolumeEntry[]` and
   `initialMounts: HostVolumeInit[]` (handles + seeds).
5. `setEntries(initialEntries)`.
6. `onInitialVolumes(initialMounts)` — calls
   `runtime.resolveInit(initialMounts)`.

`resolveInit` (closure built inside `ensureRuntime`):

```ts
resolveInit = (volumes) => {
    if (initPosted) return;
    initPosted = true;
    void mainZenfs.mountAll(volumes);          // mirror on main thread
    worker.postMessage(
        { type: 'init', agentPort: channel.port2, volumes },
        [channel.port2],
    );
    resolve();
};
```

Two things land at this moment:

- The **MainZenfs mirror** starts mounting volumes
  asynchronously on the main thread (for the `fs/*`
  IDE-integration seam). `fs-handlers.ts` does a defensive
  membership check on every call so a slow mount doesn't
  cause races.
- The Worker's `init` message lands. Inside the worker:

## Phase 3 — Worker `init` handler

`agent/agent-worker.ts` listens on `self.addEventListener('message')`.
On the first `init`:

1. Reads `__WEB_ACP_DEV__` / `__WEB_ACP_VERSION__` /
   `__ACP_SDK_VERSION__` Vite-injected globals.
2. Calls `startAgent(msg.agentPort, msg.volumes ?? [])`.

`startAgent`:

1. `transport = createMessagePortStream(port)`.
2. `provider = new BodhiProvider()`.
3. `streamOverrides = { current: {} }` — per-turn override
   holder threaded between the engine and `createStreamFn`.
4. `inline = createInlineAgent(createStreamFn(provider, ...))`.
5. `db = openSessionDb()` — Dexie `SessionStoreDb`.
6. `registry = new ZenfsVolumeRegistry()`.
7. `attachVolumeChannel(scope, registry)` — wires the
   raw-postMessage sidechannel for runtime mount/unmount.
8. `initialVolumes = await Promise.all(hostVolumes.map(toAgentVolumeInit))`
   — converts each `HostVolumeInit { handle | seed }` into
   the agent's `VolumeInit { fs, initialize? }`.
9. `await registry.mountAll(initialVolumes)` — synchronous
   re: ACP wire boot; mounts complete *before*
   `startAcpAgent` returns so the first `prompt` already sees
   them.
10. `services = assembleServices({ inline, bodhi: provider,
    store: createStoreFromDb(db), registry,
    features: createFeatureStore(db),
    mcpToggles: createMcpToggleStore(db), streamOverrides })`.
11. `startAcpAgent(transport, services, { isDev, buildVersion,
    acpSdkVersion })`. The agent is now ready to receive ACP
    requests.

The whole worker boot is ~96 lines (`agent/agent-worker.ts`).
Everything beyond this point is the host-neutral agent flow
documented at
[`../web-acp-agent/startup-sequence.md`](../web-acp-agent/startup-sequence.md).

## Phase 4 — ACP handshake

The host-side promise chain `client.initialize()` was
deferred until the worker `init` post completed. Once both
sides connect:

1. `AcpClient.initialize()` (`:60`) sends `initialize({
   protocolVersion: 1, clientCapabilities: { fs: {
   readTextFile: true, writeTextFile: true } } })`. The `fs`
   capability advertises the IDE-integration seam; built-in
   `bash` doesn't use it, but external ACP agents could.
2. The agent responds (see
   [`../web-acp-agent/startup-sequence.md`](../web-acp-agent/startup-sequence.md)
   § Phase 2).
3. `runtime.initialize` resolves.

## Phase 5 — Auth observation + token push

`useAcpAuth` observes `useBodhi()` outputs:

1. Computes `authKey = authKeyOf({ token, baseUrl })` via
   `acp/session-meta.ts`.
2. On change vs `getAuthKey()`:
   - `setAuthKey(authKey)`.
   - Builds the auth promise:
     - `await runtime.initialize` — block on the ACP
       handshake.
     - `client.authenticate({ token, baseUrl })` — Phase 3
       in the agent's flow.
     - `client.listModels()` — Phase 4 in the agent's flow.
     - `setAuthModels(models)` and `setModels(models)` (the
       `useAcpModels` slice's local state).
     - `ensureDefaultModel(models)` — picks the first model
       if no selection exists.
     - On token rotation while a session is active: rebuilds
       via `client.loadSession(sessionId, composedMcpServers,
       composeSessionMeta(...))` so the agent re-acquires
       MCP under the new fingerprint.
3. The slice promise is cached via `getAuthPromise` /
   `setAuthPromise` so concurrent slice hooks `await` the
   same work rather than racing.
4. On auth loss (`isAuthenticated` flips false): dispatches
   `'reset'` to the streaming reducer; `clearFeatures`;
   re-set `_authKey = null`.

After Phase 5 the host has a populated model catalog and
the worker is authenticated.

## Phase 6 — First session

`useAcpStreaming.sendMessage(prompt)` is the user's first
prompt action. Internally:

1. `await getAuthPromise()` first — `useAcpStreaming.sendMessage`
   waits on the Phase-5 auth slice to settle before issuing
   any prompt-side work, so token rotation finishes before
   the first request goes out.
2. `await ensureSession()` (from `useAcpSession`):
   - If `getSession()` returns an id, return it.
   - Otherwise:
     - `await runtime.initialize` (Worker `init` settled).
     - `composedMcpServers = composeMcpServers(
       mcpInstances, jwt, baseUrl, mcpToggles)`.
     - `composedSessionMeta = composeSessionMeta(
       requestedMcpUrls, mcpInstances)`.
     - `client.newSession(composedMcpServers, composedSessionMeta)`
       — Phase 5 in the agent's flow.
     - `setSession(response.sessionId)` and
       `refreshFeatures(sessionId)`.
3. `streamingDispatch({ type: 'turn-start', userMessage })`
   — appends the user message; clears streaming;
   `isStreaming: true`.
4. Detect built-in invocation client-side via
   `detectBuiltinTag` so the user bubble gets the muted
   styling pre-emptively.
5. `client.prompt(sessionId, prompt, selectedModel)` — Phase
   6 in the agent's flow. The reducer ingests every
   `session/update` notification while the prompt resolves.
6. After resolve: `streamingDispatch({ type: 'turn-end',
   finalMessage: streamingMessageRef.current, stopReason
   })`.
7. If the final message carries a `_builtin.action` (via
   `getBuiltinTag(finalMsg)`): call `dispatchAction(action,
   messagesRef.current)` — host-side action dispatch, see
   [`commands.md`](./commands.md). `messagesRef.current` is
   snapshotted *before* the appended built-in pair, giving
   `/copy` the LLM-only conversation.
8. `void refreshSessions()` so the picker reflects the new
   `updatedAt` / `turnCount`.

After step 6 the session is live; subsequent `sendMessage`
calls reuse the same `sessionId`.

## Phase 7 — Steady state

Once Phase 6 completes the first turn, the host is in
steady state. Pending interactions:

- More `sendMessage` calls.
- `stop()` mid-turn → `client.cancel(sessionId)`.
- `loadSession(id)` from the picker — see
  [`hooks.md`](./hooks.md) § `useAcpSession.loadSession`.
- `clearMessages()` to start fresh — `streamingDispatch
  ({ type: 'reset' })` + `clearFeatures()` + drop the
  active session id.
- `deleteSession(id)` — `client.deleteSession`; if active,
  also `clearMessages`. `refreshSessions` after.
- Volume mount/unmount via `useVolumes.addVolume /
  removeVolume / restoreAccess` → volume-control sidechannel.
- Feature toggle via `setFeature` → `_bodhi/features/set`.
- MCP toggle via `setMcpToggle` → `_bodhi/mcp/toggles/set`
  (server-level changes also re-issue `loadSession`).

## E2E priming via `useDevSeedBoot`

Playwright runs against this same boot flow. Pattern:

1. `e2e/helpers/install-volumes.ts` builds a `VolumeSeed[]`
   of arbitrary directories.
2. The test calls `await page.addInitScript(args => {
   window.__zenfsSeed = args.seed; }, { seed })` — the seed
   is present **before** any app code runs.
3. `useVolumes.readDevSeeds()` finds it and feeds the seeds
   into `initialMounts` alongside any persisted FSA handles.
4. Production builds dead-code the `useDevSeedBoot` branch
   via `import.meta.env.DEV`.

This is the **only** allowed way to prime filesystem state
for tests. Tests never `page.evaluate` into ZenFS internals
— that would hide product bugs in the bootstrap path.

## Cross-references

- Agent-side wire flow (Phases 1+ inside the worker):
  [`../web-acp-agent/startup-sequence.md`](../web-acp-agent/startup-sequence.md).
- Hook composition + per-slice details:
  [`hooks.md`](./hooks.md).
- Transport bridge + worker boot shim:
  [`transport.md`](./transport.md).
- Volume resolution detail:
  [`volumes.md`](./volumes.md).
- Host-side wire layer (AcpClient, runtime, reducer):
  [`acp.md`](./acp.md).
- CLI host's TTY boot for comparison:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md)
  § "Boot sequence".
