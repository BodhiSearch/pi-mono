# integration

**Parent:** [`../worker-bodhi/index.md`](./index.md)

Tracks the three places `BodhiAuthProvider` is wired into the wider system: boot, rotation, request-time resolution. Also captures extension scenarios for adding a second provider.

## 1. Worker boot

Both boot shims under `packages/web-agent/src/worker-agent/worker/` do the same wiring. These are the **only** two files under `worker-agent/` allowed to import from `worker-bodhi/`.

### 1.1 `worker/agent-worker.ts::boot`

Executed inside the spawned `Worker` after the init message arrives:

1. `const authProvider = new BodhiAuthProvider();`
2. `const session = new AgentSession();`
3. `session.setStreamFn(createStreamFn(authProvider));` — see [`../worker-agent/llm-auth.md`](../worker-agent/llm-auth.md).
4. `const host = new WorkerAgentHost(session, vfsPort, store, authProvider, { vaultMount });` — the same instance is passed to the host so `setAuthToken` rotations reach the provider and compaction shares the auth surface.

### 1.2 `worker/boot.ts::bootInProcess`

The jsdom / no-Worker fallback. Same wiring inside the main thread:

1. `const authProvider = new BodhiAuthProvider();`
2. `new AgentSession({})` + `session.setStreamFn(createStreamFn(authProvider))`.
3. `new WorkerAgentHost(session, fakePort, new MemorySessionStore(), authProvider, { vaultMount })`.

See [`../worker-agent/worker-boot.md`](../worker-agent/worker-boot.md) for the full boot sequence.

## 2. RPC rotation path

From a main-thread auth state change through to `BodhiAuthProvider.setAuthToken`:

1. **Main thread source** — `packages/web-agent/src/hooks/useAgent.ts` observes the Bodhi auth state and constructs:
   ```ts
   const credential: LlmAuthCredential = {
     provider: BODHI_PROVIDER_TAG,
     baseUrl,
     token,
   };
   rpcClient.setAuthToken(credential);
   ```
2. **`RpcClient.setAuthToken`** (`worker-agent/rpc/rpc-client.ts`) sends a `set_auth_token` command envelope.
3. **`RpcServer.handleCommand`** (`worker-agent/rpc/rpc-server.ts`) routes `set_auth_token` → `AgentSessionHost.setAuthToken?.(raw.credential)`.
4. **`WorkerAgentHost.setAuthToken`** (`worker-agent/worker/worker-host.ts`) delegates: `this.authProvider.setAuthToken?.(credential)`.
5. **`BodhiAuthProvider.setAuthToken`** applies the tag filter and stores `{ token, baseUrl }`.

The same pipeline applies with `credential = null` to clear the token (e.g. user logged out).

## 3. Per-request auth resolution

Two callsites pull auth from the injected `LlmAuthProvider`. Both rely on pi-ai's per-format provider code for actual header placement; `BodhiAuthProvider` never constructs a header itself.

### 3.1 Streaming turns

- `createStreamFn(authProvider)` (`worker-agent/llm/stream.ts`) calls `authProvider.getApiKeyAndHeaders(model)` and forwards `{ apiKey, headers }` to `streamSimple(model, context, options)`.
- Triggered every time `Agent.prompt(...)` issues a streamed request.

### 3.2 Compaction

- `compactSummarize(preparation, model, { authProvider, signal })` (`worker-agent/core/compaction/summarize.ts`) calls `authProvider.getApiKeyAndHeaders(model)` and forwards to `completeSimple`.
- Triggered from `WorkerAgentHost.runCompaction` (auto or manual). See [`../worker-agent/compaction.md`](../worker-agent/compaction.md).

## 4. Extension scenarios (non-normative)

### 4.1 Adding a second auth provider (e.g. raw OpenAI)

1. Create `packages/web-agent/src/worker-openai/` implementing `LlmAuthProvider` with its own `PROVIDER_TAG = 'openai'`.
2. Replace the single-provider construction in `worker-agent/worker/agent-worker.ts` and `worker/boot.ts` with a composite provider that inspects `credential.provider` and delegates. Each concrete provider ignores credentials whose tag doesn't match its own (tag isolation, see [`./index.md`](./index.md)).
3. Main-thread host code chooses which tag to emit based on its auth state (could be per-model, per-request, etc.).

### 4.2 Binding a token to a base URL

`BodhiAuthProvider.getBaseUrl()` already captures the stored `baseUrl`. A future enhancement could cross-check `model.baseUrl` and reject mismatched credentials. Today's contract: the host emits a single credential tied to a single Bodhi base URL and fetches the matching model catalog accordingly.

### 4.3 Adding headers

If Bodhi ever requires custom headers alongside the bearer token, return them from `getApiKeyAndHeaders` via the `headers` field. `createStreamFn` merges them with caller-supplied headers (caller wins on key collision).

## 5. Constraint reminder

- Only the two boot shims (`worker/agent-worker.ts`, `worker/boot.ts`) may import `worker-bodhi/`. Anywhere else is a violation of [`../worker-agent/index.md` § Global guarantees](../worker-agent/index.md#global-guarantees--invariants).
- Main-thread Bodhi integration lives in `packages/web-agent/src/hooks/useAgent.ts` (not covered by this spec folder; see the hook's inline docs).

## Change procedure

Any plan that edits the integration wiring (boot shims, `useAgent` hook's credential construction, rotation RPC shape) must update this file in the same PR. Structural changes to the rotation pipeline also touch [`../worker-agent/rpc.md`](../worker-agent/rpc.md), [`../worker-agent/worker-host.md`](../worker-agent/worker-host.md), and [`../worker-agent/llm-auth.md`](../worker-agent/llm-auth.md).

See [`./index.md` § Change procedure](./index.md#change-procedure).
