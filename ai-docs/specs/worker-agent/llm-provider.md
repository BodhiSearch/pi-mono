# llm-provider

**Source of truth:** `packages/web-agent/src/worker-agent/llm/`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

`llm/` is the worker-agent's unified LLM provider abstraction. Conceptually the
"provider" here is an **AI gateway**: a single object that resolves per-request
auth, owns the model catalog, and optionally accepts rotated credentials. It
has three artifacts:

- **`LlmProvider`** — interface. Two required methods and one optional:
  - `getApiKeyAndHeaders(model)` resolves per-request `{apiKey, headers?}`.
  - `getAvailableModels()` returns the live `Model<Api>[]` catalog.
  - `setAuthToken?(credential)` accepts a rotating `LlmAuthCredential | null`.
- **`LlmAuthCredential`** — envelope carrying a `provider` tag, optional
  `baseUrl`, and the rotating `token`. The tag lets multiple providers share
  one RPC channel.
- **`createStreamFn(provider)`** — factory producing a provider-agnostic
  `StreamFn` that resolves auth per request and delegates to pi-ai's
  `streamSimple`.

The worker itself stays provider-agnostic and relies on pi-ai's built-in
per-format auth handling (OpenAI → `Authorization: Bearer`, Anthropic →
`x-api-key`, Gemini → key param) — it does **not** synthesise auth headers.

Concrete implementations live outside `worker-agent/`. See
[`../worker-bodhi/`](../worker-bodhi/index.md) for the Bodhi implementation
(which front-ends multiple model families through one gateway).

### Responsibilities

- Let the worker call an LLM without knowing which auth scheme backs it.
- Let the worker fetch the catalog of models it is allowed to use **from the
  provider**, without the main thread pushing a seeded list.
- Let the worker rotate a short-lived token (OAuth access token, etc.) without
  reshaping the RPC on every scheme.
- Share a single surface between the live streamFn, the compaction summariser,
  and session-restore model resolution.

### Non-responsibilities

- Token refresh, expiry, or revocation (provider's problem).
- Auth-header synthesis (pi-ai does this from the resolved `apiKey`).
- Caching model catalogs across calls — each `getAvailableModels()` is a fresh
  fetch; callers cache at their own layer if needed.
- Credential storage on the main thread.

## Technical reference

### Files

| File | Contents |
| --- | --- |
| `llm/types.ts` | `LlmAuthCredential`, `LlmProvider` interfaces. |
| `llm/stream.ts` | `createStreamFn(provider)` factory + file-local `mergeHeaders`. |
| `llm/index.ts` | Barrel re-exporting both. |

### `LlmAuthCredential`

Declared in `llm/types.ts`. Fields:

- `provider: string` — tag identifying the auth namespace. Concrete providers
  ignore credentials whose tag doesn't match their own (e.g. `BodhiProvider`
  only accepts `'bodhi'`).
- `baseUrl?: string` — server root bound to this credential. Advisory; not
  consumed by pi-ai but used by catalog fetchers to build the endpoint URL.
- `token: string | null` — the rotating secret. `null` clears the credential.

### `LlmProvider`

Declared in `llm/types.ts`. Methods:

- `getApiKeyAndHeaders(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>`
  - Resolves auth for a single LLM call.
  - The `model` parameter lets providers route by model (e.g. per-model API
    keys). The Bodhi implementation ignores it.
  - `apiKey` is fed to pi-ai's `streamSimple` / `completeSimple`, which places
    it in the correct per-format header.
  - `headers` merges into the request. Most providers leave it unset.
- `getAvailableModels(): Promise<Model<Api>[]>`
  - Returns the live catalog of models this provider exposes, already shaped
    as `Model<Api>` (provider tag, api format, baseUrl, id, contextWindow,
    maxTokens, cost, displayName…).
  - Invoked on every UI `getAvailableModels` RPC and on every worker-side
    model resolution (e.g. `setModel`, session restore). Implementations are
    expected to fetch on demand — no caching contract.
- `setAuthToken?(credential: LlmAuthCredential | null): void`
  - Optional rotation sink invoked from the `set_auth_token` RPC.
    Implementations **must** ignore credentials whose `provider` tag doesn't
    match their own.

### `createStreamFn(provider)`

Declared in `llm/stream.ts`. Returns a `StreamFn` from
`@mariozechner/pi-agent-core` that, for every request:

1. Calls `provider.getApiKeyAndHeaders(model)`.
2. Merges the resolved `headers` with any caller-provided `options.headers`
   via the file-local `mergeHeaders` (caller headers override provider
   headers on key collision).
3. Delegates to `streamSimple(model, context, { ...options, apiKey, headers })`.

`mergeHeaders(base, override)` returns `undefined` when both are empty,
otherwise a shallow-merged object with `override` winning.

## Integration points

- **Boot wiring.**
  `packages/web-agent/src/worker-agent/worker/agent-worker.ts::boot` and
  `worker/boot.ts::bootInProcess` each:
  1. Instantiate a concrete provider (currently `BodhiProvider`).
  2. `session.setStreamFn(createStreamFn(provider))`.
  3. Pass the same `provider` to `new WorkerAgentHost(..., provider, ...)`.
  - These two shim files are the only places inside
    `packages/web-agent/src/worker-agent/` that reference a concrete provider
    implementation.

- **Catalog path.** `RpcClient.getAvailableModels()` → `get_available_models`
  command → `RpcServer` → `AgentSessionHost.getAvailableModels` →
  `WorkerAgentHost.getAvailableModels` → `provider.getAvailableModels()`.
  The worker no longer holds a seeded registry; every call hits the
  provider.

- **Rotation path.** `RpcClient.setAuthToken(credential)` → `set_auth_token`
  command → `RpcServer` → `AgentSessionHost.setAuthToken` →
  `WorkerAgentHost.setAuthToken` → `provider.setAuthToken`. See
  [`rpc.md`](./rpc.md) and [`worker-host.md`](./worker-host.md).

- **Model resolution.** `WorkerAgentHost.setModel(provider, id)` and
  `restoreModelFromContext(...)` both call `provider.getAvailableModels()` and
  match against the returned catalog.

- **Compaction.**
  `packages/web-agent/src/worker-agent/core/compaction/summarize.ts::compactSummarize`
  calls `options.provider.getApiKeyAndHeaders(model)` and passes `apiKey` +
  `headers` to `completeSimple`. The `provider` reaches it through
  `WorkerAgentHost.runCompaction`'s `{ provider: this.provider, signal }`
  options.

## Guarantees

1. Only these files reference `LlmProvider` or `LlmAuthCredential` inside
   `worker-agent/`:
   - `llm/stream.ts`, `llm/types.ts`, `llm/index.ts`,
     `core/compaction/summarize.ts`, `worker/worker-host.ts`,
     `rpc/rpc-client.ts`, `rpc/rpc-server.ts`, `rpc/rpc-types.ts`,
     `worker-agent/index.ts` (barrel).
2. No file under `worker-agent/` synthesises an auth header; all auth flows
   through `apiKey` + optional `headers` in the provider's return value.
3. No file under `worker-agent/` fetches a model catalog directly; the catalog
   is always reached via `provider.getAvailableModels()`.
4. Adding a new concrete provider does not require any change under
   `worker-agent/` — only the boot shim imports change.

## Tests

- `packages/web-agent/src/worker-agent/worker/worker-host.test.ts` validates
  rotation delegation and model-resolution end-to-end with a fake
  `LlmProvider`.
- The `createStreamFn` behaviour is covered indirectly through integration
  tests that stub `streamSimple`; direct unit coverage can be added if the
  merge logic grows.

## Change procedure

Any plan that edits `llm/types.ts` or `llm/stream.ts` must update this file in
the same PR. When the `LlmProvider` interface changes, also verify
`core/compaction/summarize.ts`, `worker/worker-host.ts`, and the Bodhi
provider at [`../worker-bodhi/`](../worker-bodhi/index.md) still conform. See
[`./index.md` § Change procedure](./index.md#change-procedure).
