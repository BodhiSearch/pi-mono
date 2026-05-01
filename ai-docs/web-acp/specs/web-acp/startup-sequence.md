# startup-sequence

**Source of truth:** `packages/web-acp-agent/src/` (agent runtime)
+ `packages/web-acp/src/` (browser host) — this file is the
authoritative narrative reference for "what happens when" across
all modules of the **browser-worker host**. When any step below
diverges from the code, update this file in the same commit.

> **Companion file.** The Node-host equivalent is in
> [`../cli-acp-client/index.md`](../cli-acp-client/index.md) §
> "Boot sequence". The two narratives diverge only above the
> transport boundary; from `startAcpAgent(...)` onwards both
> hosts feed the same agent code.

**Parent:** [`./index.md`](./index.md)

## Why this file exists

ACP splits responsibility across three processes-of-sorts (React
tree on the main thread, Web Worker agent, Bodhi server) that are
all asynchronous and all capable of starting in any order. The
per-module specs describe their slice; only this file reads across
the seams. Read it **before** any plan that touches boot, auth,
the model catalog, or the first prompt.

## Note on host-side terminology (post-engine-split)

References below to "`useAcp` does X" mean **the facade or its
underlying slice hook**, not literally a single React hook. After
the host-side wire/engine split (pre-M5), the implementation is
spread across `acp/runtime.ts` (singleton + module-scope state),
`acp/streaming-reducer.ts` (pure prompt-turn reducer),
`acp/{builtin-dispatch,message-shape,session-meta,permissions}.ts`
(pure helpers), and the per-concern hooks
`useAcp{Runtime,Auth,Models,Features,Mcp,Session,Streaming}`.
`useAcp.ts` itself is a ~180 LoC facade. See
[`./hook.md`](./hook.md) for the full file map and which slice
owns each piece of state. Module-scope `let`s like `_runtime`,
`_session`, `_authPromise` referenced below now live in
`acp/runtime.ts` and are read/written via accessor functions
(`getSession()` / `setSession()`, …); the streaming refs
(`streamingRef`, `streamingMessageIdRef`, `isReplayingRef`)
referenced in Phase 4 are now reducer state.

## Actors

| Actor | Thread | Owns |
| --- | --- | --- |
| `App` / `AppContent` (`src/App.tsx`) | main | mounts `BodhiProvider`; auto-opens the Bodhi setup modal. |
| `@bodhiapp/bodhi-js-react` (`useBodhi`) | main | OAuth 2.1 flow, token storage, `auth.accessToken`, `clientState`. |
| `ChatDemo` (`src/components/chat/ChatDemo.tsx`) | main | calls `useAcp()`. |
| `useAcp` (`src/hooks/useAcp.ts`) | main | thin facade composing the slice hooks; surfaces chat state to `ChatDemo`. |
| `useAcp{Runtime,Auth,Models,Features,Mcp,Session,Streaming}` (`src/hooks/`) | main | per-concern slice hooks — see [`./hook.md`](./hook.md). |
| `acp/runtime.ts` | main | `AcpRuntime` singleton + module-scope session/auth state (host wire/engine split). |
| `acp/streaming-reducer.ts` | main | pure typed reducer that consumes `session/update` notifications and the prompt-turn lifecycle. |
| `AcpClient` (`src/acp/client.ts`) | main | typed facade over `ClientSideConnection`. |
| `ClientSideConnection` (`@agentclientprotocol/sdk`) | main | JSON-RPC framing, method correlation. |
| `MessageChannel` (`port1`, `port2`) | shared | transport primitive. |
| `createMessagePortStream` (`src/transport/worker-stream.ts`) | either | byte-stream wrapper around a `MessagePort`. |
| `ndJsonStream` (`@agentclientprotocol/sdk`) | either | newline-delimited JSON framing over byte streams. |
| `agent-worker.ts` (`src/agent/agent-worker.ts`) | worker | receives `init`, wires the ACP handler. |
| `AgentSideConnection` (`@agentclientprotocol/sdk`) | worker | dispatches incoming requests to the `Agent` implementation. |
| `AcpAgentAdapter` (`src/acp/agent-adapter.ts`) | worker | `Agent` implementation — wire shim that delegates into the engine layer. |
| `assembleServices` (`src/acp/engine/services.ts`) | worker | factory that builds the `AcpAdapterServices` deps bag the adapter consumes. |
| `AcpSessionRuntime` (`src/acp/engine/session-runtime.ts`) | worker | per-session lifecycle owner (session map, MCP pool, vault commands, model cache). |
| `PromptTurnDriver` (`src/acp/engine/prompt-driver.ts`) | worker | runs one `session/prompt` turn end-to-end. |
| `dispatchExtMethod` (`src/acp/engine/ext-methods/index.ts`) | worker | `_bodhi/*` extension method registry. |
| `tryHandleBuiltin` (`src/acp/engine/builtin-dispatch.ts`) | worker | recognises and handles built-in slash commands. |
| `InlineAgent` (`src/agent/inline-agent.ts`) | worker | wraps `pi-agent-core`'s `Agent`; drives a single turn. |
| `BodhiProvider` (`src/agent/bodhi-provider.ts`) | worker | holds the token; fetches the Bodhi catalog. |
| `createStreamFn` (`src/agent/stream-fn.ts`) | worker | bridges `pi-agent-core` → `pi-ai`'s `streamSimple`. |
| Bodhi server | remote | issues the access token and serves `/bodhi/v1/models` + the LLM streaming endpoints. |

## Phase 0 — React mount (main thread only)

1. `main.tsx` renders `<App />`.
2. `<App>` wraps `<AppContent>` in `<BodhiProvider>` from
   `@bodhiapp/bodhi-js-react`, passing `authClientId`,
   `authServerUrl`, and `basePath`.
3. `<AppContent>` calls `useBodhi()`. On first render,
   `clientState.status` is typically `direct-not-connected` or
   `extension-not-found`; the `useEffect` in `AppContent` auto-
   opens the Bodhi setup modal by calling `showSetup()` once.
4. `<Layout />` mounts; somewhere under it `<ChatDemo />` mounts
   and invokes `useAcp()`.

At end of Phase 0, the main thread has a Bodhi client (not yet
authenticated in most runs) and has called `useAcp()` at least
once, but the worker has not been spawned yet — the first `useAcp`
body runs the `ensureRuntime` effect synchronously.

## Phase 1 — Worker spawn and ACP handshake

`useAcp` uses a module-scoped `_runtime` singleton so StrictMode's
double-mount and React fast-refresh cannot create a second worker.
The first call to `ensureRuntime()` (from either the `useEffect`
on mount or the `useEffect` that owns `session/update`
subscription) runs these steps:

1. **Spawn.** `new Worker(new URL('../agent/agent-worker.ts',
   import.meta.url), { type: 'module' })`. Vite bundles
   `agent-worker.ts` (and its entire dependency graph) into a
   worker chunk.
2. **Channel.** `new MessageChannel()` yields `port1` (stays on
   the main thread) and `port2` (transferred to the worker).
3. **Init post — deferred.** M2 makes the `init` post **lazy**. The
   hook builds a `resolveInit(volumes: VolumeInit[])` closure and
   returns without messaging the worker. `useVolumes` (M2) resolves
   the persisted FSA handles + dev seeds and calls `resolveInit`,
   which then fires:
   `worker.postMessage({type: 'init', agentPort: port2, volumes},
   [port2])`. The init message is still **one-shot** and is the
   only non-ACP, non-volume-control message that ever crosses the
   boundary. See [`vault.md`](./vault.md).
4. **Main-side byte-streams.** `createMessagePortStream(port1)`
   returns `{readable, writable}`. `port1.start()` is called
   inside `createMessagePortStream`; callers must not call it
   themselves. See [`transport.md`](./transport.md).
5. **Main-side ACP stream.** `ndJsonStream(writable, readable)`
   produces the `AgentSideConnection`-compatible
   `{send, recv, close}`-ish object the SDK expects.
6. **Client handler.** `useAcp` builds a `Client` that:
   - Throws on `requestPermission` (not supported in M0).
   - Dispatches inbound `sessionUpdate` notifications to
     `holder.client` (a late-binding reference because `AcpClient`
     and the handler have a circular construction order).
7. **Client connection.** `new ClientSideConnection(() =>
   handler, stream)` registers the handler and begins draining
   the stream.
8. **Wrapper.** `new AcpClient(conn)` caches the connection;
   `holder.client = client`.
9. **Initialize promise.** `client.initialize()` kicks off a
   `initialize` JSON-RPC call with
   `protocolVersion: 1, clientCapabilities: { fs: { readTextFile:
   true, writeTextFile: true } }` (flipped on in M2.3). The returned
   promise is stored in `_runtime.initialize` — every later call
   that depends on the connection awaits it.

Concurrently, on the worker side:

1. **Bootstrap listener.** `agent-worker.ts` registers a
   `self.addEventListener('message', ...)` before any dynamic
   imports settle. The listener filters for
   `msg.type === 'init'` and guards against duplicate inits.
2. **Worker-side byte-streams.** On receipt of `init`,
   `createMessagePortStream(agentPort)` builds the same
   `{readable, writable}` pair, calling `port.start()`.
3. **Worker-side ACP stream.** `ndJsonStream(writable, readable)`
   produces the stream the SDK needs.
4. **Volume registry (M2).** Creates a `VolumeRegistry`, calls
   `registry.mountAll(initMsg.volumes ?? [])` so `/mnt/<name>`
   entries are ready before any ACP request, and attaches the
   volume-control `postMessage` channel via
   `attachVolumeChannel(self, registry)`. See
   [`vault.md`](./vault.md) for the control-plane split.
5. **Singletons.** `new BodhiProvider()`,
   `createInlineAgent(createStreamFn(provider))`.
6. **Agent connection.** `new AgentSideConnection(conn => new
   AcpAgentAdapter(conn, services), stream)` — `services` is built
   by `assembleServices({ inline, bodhi: provider, store, registry,
   features, mcpToggles, streamOverrides })` from
   `src/acp/engine/services.ts`. The adapter constructs an
   `AcpSessionRuntime` and a `PromptTurnDriver` from the bag in
   its constructor.
   The SDK invokes the factory with the connection it will use
   for outgoing notifications; the factory constructs the adapter
   (now registry-aware) and returns it as the `Agent`
   implementation for inbound dispatch.

At this point **one** JSON-RPC `initialize` request is in flight:
the main thread is awaiting the response, and the adapter's
`initialize` method runs inside the worker.

### `initialize` payload exchange

- **Request (main → worker):**
  `{ jsonrpc: "2.0", id: <n>, method: "initialize", params: {
    protocolVersion: 1, clientCapabilities: { fs: {...} } } }`
- **Response (worker → main):** see `AcpAgentAdapter.initialize`
  in [`acp.md`](./acp.md):
  ```
  {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,        // true whenever a SessionStore is wired into the adapter (always, in production)
      promptCapabilities: { image: false, audio: false, embeddedContext: false }
    },
    authMethods: [{
      id: "bodhi-token",
      name: "Bodhi token",
      description: "Push a Bodhi access token from the main thread."
    }]
  }
  ```

`useAcp` does not inspect the initialize response directly today —
the Bodhi auth method id is a compile-time constant
(`BODHI_AUTH_METHOD_ID = 'bodhi-token'` in `src/acp/index.ts`),
shared by both sides. The response is awaited for ordering only.

## Phase 1.5 — Volume resolution (M2)

Runs in parallel with Phase 1 on the main thread and gates the
worker's `init` post. Detail in [`vault.md`](./vault.md).

1. `useVolumes` loads persisted handles from `idb-keyval`
   (`web-acp:volumes`).
2. `requestPermissions(records)` partitions them into `ready`
   (auto-regranted) and `prompt` (awaiting user gesture).
3. `readDevSeeds()` reads `window.__zenfsSeed` (Playwright /
   dev-only) and appends in-memory volumes.
4. The hook calls `onInitialVolumes(VolumeInit[])` which runs
   `runtime.resolveInit(volumes)` to fire the worker `init` post
   described in Phase 1, step 3.
5. After boot, user interactions (add, remove, regrant) go through
   the **volume-control channel** (`volumes/mount`,
   `volumes/unmount`) rather than ACP; only the read-only
   `_bodhi/volumes/list` method rides on JSON-RPC.

## Phase 2 — Bodhi authenticate + catalog fetch

Triggered by the main-thread auth `useEffect` in `useAcp`, which
depends on `[auth.accessToken, bodhiClient, isReady]`. The effect
runs whenever any of these change.

1. **Gate on `isReady`.** The effect is a no-op if
   `isReady === false`.
2. **Read token.** `const token = auth.accessToken ?? null`.
3. **Cleared token path.** If `token` is `null`, the effect
   resets `_authKey`, `_authPromise`, `_authModels` at module
   scope and returns without calling the worker. (Explicit
   sign-out is handled by a second `useEffect` further down —
   see Phase 5.)
4. **Auth key.** `authKeyOf(token, serverUrl)` is
   `${baseUrl}::${token}`. It is used to de-dupe: if the token
   and server URL haven't changed, the effect reuses the existing
   `_authPromise`.
5. **Server URL.** `getServerUrlOrThrow(bodhiClient.getState())`
   requires `isDirectState(state)` and a non-empty `url`,
   otherwise it throws "Chat requires a Bodhi server connection".
   The throw is caught below.
6. **Authenticate + listModels promise.** If the key changed, the
   effect builds:
   ```
   _authPromise = (async () => {
     await runtime.initialize;
     await runtime.client.authenticate({ token, baseUrl });
     _authModels = await runtime.client.listModels();
   })();
   ```
7. **`authenticate` request (main → worker).** `AcpClient.authenticate`
   issues:
   ```
   {
     methodId: "bodhi-token",
     _meta: { token, baseUrl }
   }
   ```
   See [`acp.md`](./acp.md) for the full shape.
8. **`authenticate` handler (worker).**
   `AcpAgentAdapter.authenticate` validates the method id,
   extracts `{token, baseUrl}` from `_meta`, and calls
   `bodhi.setAuthToken({provider: 'bodhi', token, baseUrl})`. It
   also resets `this.#models = []` and calls
   `inline.clearMessages()` so a previous session's transcript
   and cached catalog don't leak across auth changes.
9. **`bodhi/listModels` request (main → worker).**
   `AcpClient.listModels()` calls
   `conn.extMethod('bodhi/listModels', {})`. The SDK carries
   unknown method names through `extMethod` without requiring
   schema support.
10. **`bodhi/listModels` handler (worker).**
    `AcpAgentAdapter.extMethod` calls
    `bodhi.getAvailableModels()` which:
    - Issues `GET ${baseUrl}/bodhi/v1/models?page_size=100` with
      `Authorization: Bearer ${token}`.
    - Parses the `PaginatedAliasResponse` and flattens each entry
      (user / model alias → single local model;
      `ApiAliasResponse` → one `Model<Api>` per entry in `models`).
    - Maps `api_format` to the pi-ai `api` / `provider` / base-URL
      triple and extracts per-variant context/max-token limits.
    - Returns `Model<Api>[]`.
    The adapter caches the flattened array on `this.#models`
    (used later during `prompt` resolution) and returns
    `{models: [{id, apiFormat}, ...]}` to the main thread.
11. **State update.** Back in the effect, `setModels(_authModels)`
    pushes the descriptors into React state. If the user had no
    previous selection, `selectedModel` is initialised to the
    first entry (and `selectedApiFormat` mirrors it).
12. **Error path.** Any failure (server offline, token rejected,
    catalog fetch 5xx) clears `_authKey` / `_authPromise` so a
    future auth-state change retries, and surfaces `error` to
    the hook consumer via `setError(...)`. `isLoadingModels`
    clears in `finally`.

At end of Phase 2, the worker holds a valid Bodhi credential and
a cached, provider-flattened model catalog; the main thread holds
the `{id, apiFormat}` shortlist and has a default selection.

## Phase 2.5 — Session picker + resume (M1)

Two parallel pathways layer onto the post-auth steady state once
the `SessionStore` is wired in (see [`./sessions.md`](./sessions.md)).

### 2.5a — Picker feed

1. `useAcp` owns a `refreshSessions` callback that calls
   `AcpClient.listSessions()` whenever it's invoked.
2. A `useEffect([refreshSessions])` fires it once after auth so
   the picker renders with fresh rows.
3. `sendMessage` additionally fires `refreshSessions()` after a
   clean `end_turn` so the picker shows new sessions and bumped
   `updatedAt` ordering without a manual refresh.
4. `AcpClient.listSessions` translates to
   `conn.extMethod('bodhi/listSessions', {})` which the adapter
   serves from `SessionStore.listSummaries()`.

### 2.5b — Resume

1. The user clicks a row in `SessionPicker`.
2. `ChatDemo.handleSelectSession` calls `useAcp.loadSession(id)`.
3. `useAcp.loadSession` flips `isReplayingRef = true` so the
   live `session/update` handler ignores replay deltas, then:
   - `await runtime.client.loadSession(sessionId)` — the stable
     ACP request. The adapter re-emits every stored
     `SessionNotification` via `conn.sessionUpdate(...)` and
     seeds `InlineAgent` via `restoreMessages`.
   - `await runtime.client.getSession(sessionId)` — the
     Bodhi-extension snapshot. Returns the last turn's
     `finalMessages`, `lastModelId`, and `title`.
4. The hook sets `_session = sessionId`,
   `setCurrentSessionId(sessionId)`,
   `setMessages(snapshot.messages)`, and — if `lastModelId`
   matches a catalog entry — updates `selectedModel` +
   `selectedApiFormat`.
5. `finally`: clears `isReplayingRef` and `isLoadingSession`.
6. Subsequent `sendMessage` calls find `_session` already set
   and skip `session/new`; the adapter's
   `#activeInlineSessionId` already equals the loaded id, so
   the mismatch rehydration in `prompt` is a no-op.

At end of Phase 2.5, the transcript in the UI matches what the
user last saw for that session, the model selector points at the
model that was last used for that session, and follow-up prompts
use the restored pi-agent-core context.

## Phase 3 — First prompt

Triggered by `ChatDemo` calling `sendMessage(prompt)`.

1. **Guard on selection.** `if (!selectedModel) setError(...);
   return`.
2. **Await auth.** If `_authPromise` is in flight, `sendMessage`
   awaits it before proceeding; a transient failure here aborts
   the send silently (the auth effect already surfaced the error).
3. **Local message echo.** The user message is appended to the
   `messages` state immediately so the UI reflects it without
   waiting for the server round-trip. `streamingRef` /
   `streamingMessageIdRef` / `streamingMessage` reset to empty,
   and `isStreaming` flips to `true`.
4. **Session creation (lazy).** `ensureSession()` creates the
   first ACP session on demand:
   - If `_session` is set, return it.
   - If `_sessionPromise` is already in flight, await it.
   - Otherwise issue `client.newSession()` which maps to
     `ClientSideConnection.newSession({cwd: '/', mcpServers: []})`.
     The adapter's `newSession` returns
     `{sessionId: 'bodhi-' + crypto.randomUUID()}`. The session
     id is cached at module scope; it persists across renders
     until `clearMessages()` or sign-out.
5. **`session/prompt` request (main → worker).**
   `AcpClient.prompt(sessionId, text, modelId)` sends:
   ```
   {
     sessionId,
     prompt: [{ type: "text", text }],
     _meta: { bodhi: { modelId } }
   }
   ```
6. **Prompt handling (worker).** `AcpAgentAdapter.prompt`:
   1. Looks up the session (`this.#sessions.get(sessionId)`);
      throws on miss.
   2. Resolves the model from `_meta.bodhi.modelId` against the
      cached `this.#models` (populated in Phase 2); throws if
      neither a matching id nor any models are loaded.
   3. Extracts text from `params.prompt[]` (concatenates all
      `type: 'text'` blocks); throws if empty.
   4. `inline.setModel(model)` — replaces `agent.state.model` and
      resets tools + system prompt.
   5. `this.#cancelled = false`; instantiates a `StreamCursor`.
   6. Subscribes to `inline.subscribe(event => ...)` so
      `pi-agent-core` `AgentEvent`s reach `#forwardEvent` for the
      duration of this turn.
   7. Calls `await inline.prompt(text)`. Inside:
      - `pi-agent-core` calls `streamFn(model, context, options)`.
      - `createStreamFn` pulls `{apiKey}` from
        `provider.getApiKeyAndHeaders(model)` (`{apiKey: token}`)
        and calls `streamSimple` from `pi-ai`. `pi-ai` places the
        api-key in the right header for the model's `api_format`
        (OpenAI `Authorization: Bearer`, Anthropic `x-api-key`,
        Gemini key parameter) and streams deltas back through
        `pi-agent-core`.
      - Each delta arrives at the `Agent`'s internal state as a
        `message_update` event.
8. **Streaming to the main thread.** For every `message_update`
   event with `role: 'assistant'`:
   1. `#forwardEvent` computes the delta by comparing
      `extractAssistantText(msg)` to `cursor.emittedLength`. If
      the message id changed (new assistant turn inside the same
      prompt — rare in M0 but possible), the cursor resets.
   2. `conn.sessionUpdate({sessionId, update: {sessionUpdate:
      'agent_message_chunk', content: {type: 'text', text:
      delta}, messageId?}})` pushes the delta across.
9. **Client-side stream accumulation.** The
   `onSessionUpdate` listener in `useAcp` (set up in Phase 1,
   step 7 of the `useEffect` that subscribes) handles every
   `agent_message_chunk`:
   1. If the `messageId` is new, `streamingRef.current` resets to
      an empty assistant message and `streamingMessageIdRef` is
      updated.
   2. Otherwise the delta is appended via `getAssistantText +
      withAssistantText` and `setStreamingMessage(next)` triggers
      a re-render.
10. **Turn completion.** Once `inline.prompt` resolves:
    - If `this.#cancelled`, returns `{stopReason: 'cancelled'}`.
    - If `inline.getErrorMessage()`, throws that error (the SDK
      serialises it back through JSON-RPC as the `prompt`
      response's error).
    - Otherwise returns `{stopReason: 'end_turn'}`. The
      `finally` block unsubscribes the event listener.
11. **Client-side finalisation.** Back in `sendMessage`:
    - On `stopReason !== 'cancelled'`, the final
      `streamingRef.current` is appended to `messages`.
    - `streamingRef` / `streamingMessageIdRef` /
      `streamingMessage` reset; `isStreaming` flips to `false`.

At end of Phase 3, `messages` contains `[userMessage,
assistantMessage]`, the worker's `InlineAgent` holds the full
turn internally (unused today — M1 will persist it), and the
session remains open for the next prompt.

## Phase 4 — Subsequent prompts

Steps 1–3 and 5–11 of Phase 3 repeat. Step 4 (`ensureSession`)
returns the cached `_session` immediately. The worker's
`InlineAgent` keeps accumulating `AgentMessage`s internally; `pi-
agent-core` serialises each user message + assistant reply into
`agent.state.messages`.

Known M0 limitation: because the main-thread's `messages` state
is reset on `clearMessages()` but the worker's `InlineAgent`
still holds the `pi-agent-core` state, issuing `clearMessages()`
mid-session and then sending a new prompt would replay history.
M0 papers over this by having `clearMessages()` also call
`client.cancel(session)` and reset `_session = null`, forcing a
fresh `session/new` on the next `sendMessage`. See
[`hook.md`](./hook.md) for the exact sequence.

## Phase 5 — Auth clear / sign-out

A dedicated `useEffect` watches `isAuthenticated`. When it flips
to `false` **and** a session exists:

1. `client.cancel(_session)` is fired and not awaited (best-
   effort).
2. `_session = null`.

The auth effect (Phase 2) separately clears `_authKey` /
`_authPromise` / `_authModels` when `token` becomes `null`, and
`useAcp`'s returned values read `isAuthenticated` directly —
`messages`, `streamingMessage`, `models`, `error` all collapse to
empty/null for unauthenticated renders so the UI shows a clean
state even if the underlying state hadn't finished clearing.

The Bodhi token rotation path is **the same as sign-in**: the
auth effect re-runs with a new `token`, `authKey` changes, and
Phase 2 runs again (authenticate → listModels). There is no
explicit rotation RPC today.

## Phase 6 — Cancel

`ChatDemo` has a cancel affordance (dropped messages icon etc.)
that calls `stop()`. Sequence:

1. `stop()` reads the module-scope `_session` and calls
   `runtime.client.cancel(_session)` — which issues a JSON-RPC
   notification `session/cancel`.
2. The adapter's `cancel` method sets `this.#cancelled = true`
   and calls `this.#inline.cancel()` which invokes
   `agent.abort()` inside `pi-agent-core`.
3. `pi-agent-core`'s in-flight stream is aborted; the awaiting
   `inline.prompt` returns. The adapter's `prompt` method sees
   `this.#cancelled` and returns `{stopReason: 'cancelled'}`.
4. On the main thread, `sendMessage`'s `response.stopReason ===
   'cancelled'` branch leaves `messages` untouched (the partial
   assistant draft is discarded) and clears streaming state in
   the `finally` block.

## Phase 7 — Tab unload

M0 does not actively tear down the worker — browsers kill
`Worker`s on tab close. A future extraction (M7) likely adds a
`disposeAcpRuntime()` that terminates the worker and closes the
channel, mirroring `disposeAgentWorker` in the web-agent spec.

## Invariants verified by this sequence

1. **One `initialize` per tab.** Only `ensureRuntime()` kicks it
   off, and `ensureRuntime()` is a singleton guard.
2. **Auth is idempotent on stable input.** The `authKey` check
   means the worker sees exactly one
   `authenticate + bodhi/listModels` pair per distinct
   `{baseUrl, token}` tuple.
3. **Model catalog is worker-authoritative.** The adapter caches
   the full `Model<Api>[]`; the main thread holds a lossy
   `{id, apiFormat}` summary only. Any code on the main thread
   that needs a full `Model<Api>` must fetch it from the worker.
4. **Session creation is lazy.** No `session/new` fires until the
   user sends the first prompt; refreshing the page with an
   empty chat doesn't create an orphan session.
5. **Cancel is non-destructive to earlier messages.** The
   partial streaming draft is discarded on cancel; prior
   finalised messages stay intact.

## Change procedure

Any plan that changes how boot / auth / catalog / prompt flow
work — even if the change is isolated to one module — MUST
update this file in the same commit. When a new phase enters
(e.g. session restore at M1), slot it between the existing
phases and renumber.

See [`./index.md` § Change procedure](./index.md#change-procedure).
