# integration

**Parent:** [`../worker-bodhi/index.md`](./index.md)

Tracks the four places `BodhiProvider` is wired into the wider system: boot,
auth rotation, request-time auth resolution, and catalog fetching. Also
captures extension scenarios for adding a second provider.

## 1. Worker boot

Both boot shims under `packages/web-agent/src/worker-agent/worker/` do the
same wiring. These are the **only** two files under `worker-agent/` allowed
to import from `worker-bodhi/`.

### 1.1 `worker/agent-worker.ts::boot`

Executed inside the spawned `Worker` after the init message arrives:

1. `const provider = new BodhiProvider();`
2. `const session = new AgentSession();`
3. `session.setStreamFn(createStreamFn(provider));` — see [`../worker-agent/llm-provider.md`](../worker-agent/llm-provider.md).
4. `const host = new WorkerAgentHost(session, vfsPort, store, provider, { vaultMount });` — the same instance is passed to the host so `setAuthToken` rotations reach the provider, compaction shares the auth surface, and `getAvailableModels` / `setModel` / session-restore resolve against the provider's catalog.

### 1.2 `worker/boot.ts::bootInProcess`

The jsdom / no-Worker fallback. Same wiring inside the main thread:

1. `const provider = new BodhiProvider();`
2. `new AgentSession({})` + `session.setStreamFn(createStreamFn(provider))`.
3. `new WorkerAgentHost(session, fakePort, new MemorySessionStore(), provider, { vaultMount })`.

See [`../worker-agent/worker-boot.md`](../worker-agent/worker-boot.md) for
the full boot sequence.

## 2. RPC auth rotation path

From a main-thread auth state change through to `BodhiProvider.setAuthToken`:

1. **Main thread source** — `packages/web-agent/src/hooks/useAgent.ts`
   observes the Bodhi auth state and constructs:
   ```ts
   const credential: LlmAuthCredential = {
     provider: BODHI_PROVIDER_TAG,
     baseUrl,
     token,
   };
   rpcClient.setAuthToken(credential);
   ```
2. **`RpcClient.setAuthToken`** (`worker-agent/rpc/rpc-client.ts`) sends a
   `set_auth_token` command envelope.
3. **`RpcServer.handleCommand`** (`worker-agent/rpc/rpc-server.ts`) routes
   `set_auth_token` → `AgentSessionHost.setAuthToken?.(raw.credential)`.
4. **`WorkerAgentHost.setAuthToken`** (`worker-agent/worker/worker-host.ts`)
   delegates: `this.provider.setAuthToken?.(credential)`.
5. **`BodhiProvider.setAuthToken`** applies the tag filter and stores
   `{ token, baseUrl }`.

The same pipeline applies with `credential = null` to clear the token (e.g.
user logged out).

## 3. Per-request auth resolution

Two callsites pull auth from the injected `LlmProvider`. Both rely on pi-ai's
per-format provider code for actual header placement; `BodhiProvider` never
constructs a header itself.

### 3.1 Streaming turns

- `createStreamFn(provider)` (`worker-agent/llm/stream.ts`) calls
  `provider.getApiKeyAndHeaders(model)` and forwards `{ apiKey, headers }`
  to `streamSimple(model, context, options)`.
- Triggered every time `Agent.prompt(...)` issues a streamed request.

### 3.2 Compaction

- `compactSummarize(preparation, model, { provider, signal })`
  (`worker-agent/core/compaction/summarize.ts`) calls
  `provider.getApiKeyAndHeaders(model)` and forwards to `completeSimple`.
- Triggered from `WorkerAgentHost.runCompaction` (auto or manual). See
  [`../worker-agent/compaction.md`](../worker-agent/compaction.md).

## 4. Catalog fetching path

The worker owns the model catalog; the main thread never pushes or fetches
it. Flow per catalog RPC / model resolution:

1. **Main thread trigger** — `useAgent.loadModels` calls
   `rpcClient.getAvailableModels()`. Internal triggers also exist:
   `WorkerAgentHost.setModel` and `restoreModelFromContext` both go through
   `provider.getAvailableModels()` to resolve `{provider, id}`.
2. **`RpcServer.handleCommand`** routes `get_available_models` →
   `AgentSessionHost.getAvailableModels()`.
3. **`WorkerAgentHost.getAvailableModels`** delegates:
   `return this.provider.getAvailableModels();`.
4. **`BodhiProvider.getAvailableModels`** issues a single authenticated
   `fetch` to `${baseUrl}/bodhi/v1/models?page_size=100`, deserialises the
   `PaginatedAliasResponse`, and flattens each `AliasResponse` into zero or
   more `Model<Api>` entries. The flattener is responsible for:
   - choosing the right pi-ai `Provider` tag per `api_format` (openai,
     openai_responses, anthropic, gemini), and
   - extracting accurate `contextWindow` / `maxTokens` / `displayName` per
     upstream `ApiModel` variant.

No caching contract — every call hits the endpoint. The provider relies on
the rotated `{ baseUrl, token }` captured via `setAuthToken`; if the token
is missing the call rejects with a descriptive error.

## 5. Extension scenarios (non-normative)

### 5.1 Adding a second provider (e.g. raw OpenAI)

1. Create `packages/web-agent/src/worker-openai/` implementing `LlmProvider`
   with its own `PROVIDER_TAG = 'openai'`. It must implement both
   `getApiKeyAndHeaders` and `getAvailableModels`.
2. Replace the single-provider construction in
   `worker-agent/worker/agent-worker.ts` and `worker/boot.ts` with a
   composite provider that inspects `credential.provider` and delegates.
   Each concrete provider ignores credentials whose tag doesn't match its
   own (tag isolation, see [`./index.md`](./index.md)). The composite
   merges `getAvailableModels()` outputs across providers.
3. Main-thread host code chooses which tag to emit based on its auth state
   (could be per-model, per-request, etc.).

### 5.2 Binding a token to a base URL

`BodhiProvider.getBaseUrl()` already captures the stored `baseUrl`. A future
enhancement could cross-check `model.baseUrl` and reject mismatched
credentials. Today's contract: the host emits a single credential tied to a
single Bodhi base URL and fetches the matching model catalog accordingly.

### 5.3 Adding headers

If Bodhi ever requires custom headers alongside the bearer token, return
them from `getApiKeyAndHeaders` via the `headers` field. `createStreamFn`
merges them with caller-supplied headers (caller wins on key collision).

## 6. Constraint reminder

- Only the two boot shims (`worker/agent-worker.ts`, `worker/boot.ts`) may
  import `worker-bodhi/`. Anywhere else is a violation of
  [`../worker-agent/index.md` § Global guarantees](../worker-agent/index.md#global-guarantees--invariants).
- Main-thread Bodhi integration lives in
  `packages/web-agent/src/hooks/useAgent.ts` (not covered by this spec
  folder; see the hook's inline docs).

## Change procedure

Any plan that edits the integration wiring (boot shims, `useAgent` hook's
credential construction, rotation RPC shape, catalog fetch path) must update
this file in the same PR. Structural changes to the rotation or catalog
pipeline also touch
[`../worker-agent/rpc.md`](../worker-agent/rpc.md),
[`../worker-agent/worker-host.md`](../worker-agent/worker-host.md), and
[`../worker-agent/llm-provider.md`](../worker-agent/llm-provider.md).

See [`./index.md` § Change procedure](./index.md#change-procedure).
