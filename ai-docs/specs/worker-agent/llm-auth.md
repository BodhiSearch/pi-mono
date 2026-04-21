# llm-auth

**Source of truth:** `packages/web-agent/src/worker-agent/llm/`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

`llm/` is the worker-agent's LLM authentication abstraction. It has three artifacts:

- **`LlmAuthProvider`** — interface. A single narrow method resolves per-request `{apiKey, headers?}`; an optional rotation sink accepts `LlmAuthCredential | null`.
- **`LlmAuthCredential`** — envelope carrying a `provider` tag, optional `baseUrl`, and the rotating `token`. The tag lets multiple providers share one RPC channel.
- **`createStreamFn(authProvider)`** — factory producing a provider-agnostic `StreamFn` that resolves auth per request and delegates to pi-ai's `streamSimple`.

The design mirrors coding-agent's `ModelRegistry.getApiKeyAndHeaders` pattern. The worker itself stays provider-agnostic and relies on pi-ai's built-in per-format auth handling (OpenAI → `Authorization: Bearer`, Anthropic → `x-api-key`, Gemini → key param) — it does **not** synthesise auth headers.

Concrete implementations live outside `worker-agent/`. See [`../worker-bodhi/`](../worker-bodhi/index.md) for the Bodhi implementation.

### Responsibilities

- Let the worker call an LLM without knowing which auth scheme backs it.
- Let the worker rotate a short-lived token (OAuth access token, etc.) without reshaping the RPC on every scheme.
- Share a single auth surface between the live streamFn and the compaction summariser.

### Non-responsibilities

- Token refresh, expiry, or revocation (provider's problem).
- Auth-header synthesis (pi-ai does this from the resolved `apiKey`).
- Base-URL routing (lives on `Model<Api>` entries seeded by the host).
- Credential storage on the main thread.

## Technical reference

### Files

| File | Contents |
| --- | --- |
| `llm/types.ts` | `LlmAuthCredential`, `LlmAuthProvider` interfaces. |
| `llm/stream.ts` | `createStreamFn(authProvider)` factory + file-local `mergeHeaders`. |
| `llm/index.ts` | Barrel re-exporting both. |

### `LlmAuthCredential`

Declared in `llm/types.ts`. Fields:

- `provider: string` — tag identifying the auth namespace. Concrete providers ignore credentials whose tag doesn't match their own (e.g. `BodhiAuthProvider` only accepts `'bodhi'`).
- `baseUrl?: string` — server root bound to this credential. Advisory; not consumed by pi-ai.
- `token: string | null` — the rotating secret. `null` clears the credential.

### `LlmAuthProvider`

Declared in `llm/types.ts`. Methods:

- `getApiKeyAndHeaders(model: Model<Api>): Promise<{ apiKey: string; headers?: Record<string, string> }>`
  - Resolves auth for a single LLM call.
  - The `model` parameter lets future providers route by model (e.g. per-model API keys). The Bodhi implementation ignores it.
  - `apiKey` is fed to pi-ai's `streamSimple` / `completeSimple`, which places it in the correct per-format header.
  - `headers` merges into the request. Most providers leave it unset.
- `setAuthToken?(credential: LlmAuthCredential | null): void`
  - Optional rotation sink invoked from the `set_auth_token` RPC. Implementations **must** ignore credentials whose `provider` tag doesn't match their own.

### `createStreamFn(authProvider)`

Declared in `llm/stream.ts`. Returns a `StreamFn` from `@mariozechner/pi-agent-core` that, for every request:

1. Calls `authProvider.getApiKeyAndHeaders(model)`.
2. Merges the resolved `headers` with any caller-provided `options.headers` via the file-local `mergeHeaders` (caller headers override provider headers on key collision).
3. Delegates to `streamSimple(model, context, { ...options, apiKey, headers })`.

`mergeHeaders(base, override)` returns `undefined` when both are empty, otherwise a shallow-merged object with `override` winning.

## Integration points

- **Boot wiring.** `packages/web-agent/src/worker-agent/worker/agent-worker.ts::boot` and `worker/boot.ts::bootInProcess` each:
  1. Instantiate a concrete provider (currently `BodhiAuthProvider`).
  2. `session.setStreamFn(createStreamFn(authProvider))`.
  3. Pass the same provider to `new WorkerAgentHost(..., authProvider, ...)`.
  - These two shim files are the only places inside `packages/web-agent/src/worker-agent/` that reference a concrete provider implementation.

- **Rotation path.** `RpcClient.setAuthToken(credential)` → `set_auth_token` command → `RpcServer` → `AgentSessionHost.setAuthToken` → `WorkerAgentHost.setAuthToken` → `authProvider.setAuthToken`. See [`rpc.md`](./rpc.md) and [`worker-host.md`](./worker-host.md).

- **Compaction.** `packages/web-agent/src/worker-agent/core/compaction/summarize.ts::compactSummarize` calls `options.authProvider.getApiKeyAndHeaders(model)` and passes `apiKey` + `headers` to `completeSimple`. The `authProvider` reaches it through `WorkerAgentHost.runCompaction`'s `{ authProvider: this.authProvider, signal }` options.

## Guarantees

1. Only these files reference `LlmAuthProvider` or `LlmAuthCredential` inside `worker-agent/`:
   - `llm/stream.ts`, `llm/types.ts`, `llm/index.ts`, `core/compaction/summarize.ts`, `worker/worker-host.ts`, `rpc/rpc-client.ts`, `rpc/rpc-server.ts`, `rpc/rpc-types.ts`, `worker-agent/index.ts` (barrel).
2. No file under `worker-agent/` synthesises an auth header; all auth flows through `apiKey` + optional `headers` in the provider's return value.
3. Adding a new concrete provider does not require any change under `worker-agent/` — only the boot shim imports change.

## Tests

- `packages/web-agent/src/worker-agent/worker/worker-host.test.ts` validates the rotation delegation end-to-end with a fake `LlmAuthProvider`.
- The `createStreamFn` behaviour is covered indirectly through integration tests that stub `streamSimple`; direct unit coverage can be added if the merge logic grows.

## Change procedure

Any plan that edits `llm/types.ts` or `llm/stream.ts` must update this file in the same PR. When the `LlmAuthProvider` interface changes, also verify `core/compaction/summarize.ts`, `worker/worker-host.ts`, and the Bodhi provider at [`../worker-bodhi/`](../worker-bodhi/index.md) still conform. See [`./index.md` § Change procedure](./index.md#change-procedure).
