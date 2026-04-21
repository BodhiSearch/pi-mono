# bodhi-auth-provider

**Source of truth:** `packages/web-agent/src/worker-bodhi/bodhi-auth-provider.ts`

**Parent:** [`../worker-bodhi/index.md`](./index.md)

## Functional scope

`BodhiAuthProvider` is the only `LlmAuthProvider` implementation shipped by Bodhi today. It holds the short-lived access token forwarded from the main thread and resolves per-request auth material.

### Responsibilities

- Accept / ignore inbound `LlmAuthCredential` envelopes based on `provider` tag.
- Store the current token + optional baseUrl.
- Resolve `{ apiKey }` for streaming turns and compaction completions.

### Non-responsibilities

- Header synthesis (pi-ai does it from `apiKey`).
- Token refresh / expiry handling (main thread's job; a fresh credential is pushed on every auth state change).
- Base-URL routing per API format (on `Model<Api>` entries, not here).

## Technical reference

### Public exports (`index.ts`)

- `BodhiAuthProvider` — the class.
- `BODHI_PROVIDER_TAG = 'bodhi'` — the credential tag.

Used by:

- `bodhi-auth-provider.ts` itself — to filter inbound credentials.
- `packages/web-agent/src/hooks/useAgent.ts` — to build correctly-tagged `LlmAuthCredential` envelopes without string-literal drift.
- `worker-agent/worker/agent-worker.ts` and `worker-agent/worker/boot.ts` — to import `BodhiAuthProvider` and instantiate it at boot. See [`integration.md`](./integration.md).

### `BodhiAuthProvider` class

Implements `LlmAuthProvider` from `packages/web-agent/src/worker-agent/llm/types.ts`.

#### Private state

- `token: string | null` — current rotating access token; `null` when cleared.
- `baseUrl: string | undefined` — Bodhi server root the token was bound to. Retained for diagnostics / future multi-host use; not consumed by `getApiKeyAndHeaders` today.

#### Methods

- **`setAuthToken(credential)`**
  - If `credential` is falsy, or `credential.provider !== BODHI_PROVIDER_TAG`, reset `token = null` and `baseUrl = undefined`. This ensures a credential tagged for another provider clears Bodhi's state rather than leaving a stale token active on a shared `set_auth_token` channel.
  - Otherwise, store `credential.token` and `credential.baseUrl`.
  - Synchronous and cheap — safe to call on every main-thread auth-observable change.

- **`getApiKeyAndHeaders(_model)`**
  - Returns `{ apiKey: this.token ?? '' }`.
  - The `_model` parameter is part of the `LlmAuthProvider` contract but unused here (all Bodhi requests share one token surface). Annotated with `// eslint-disable-next-line @typescript-eslint/no-unused-vars`.
  - No `headers` returned — pi-ai handles per-format header placement from `apiKey`.

- **`getBaseUrl()`**
  - Test-only inspector returning the stored `baseUrl`. Not part of the `LlmAuthProvider` interface. Not invoked by the runtime.

## Tests (`bodhi-auth-provider.test.ts`)

Coverage:

1. **Default state.** `getApiKeyAndHeaders` returns `{ apiKey: '' }` with no credential set.
2. **Bodhi-tagged credential.** `setAuthToken({ provider: 'bodhi', baseUrl, token })` stores both; `getApiKeyAndHeaders` returns `{ apiKey: token }`; `getBaseUrl()` returns the stored `baseUrl`.
3. **`null` credential.** Clears both `token` and `baseUrl`.
4. **Foreign-tagged credential.** Any `provider` other than `'bodhi'` clears local state even when Bodhi previously had a valid credential — proves the tag filter works even if a parent rotation channel is shared across providers.

## Constraints

1. Must continue to satisfy `LlmAuthProvider` from `worker-agent/llm/types.ts`. If the interface adds members, update this module and add coverage.
2. Must not import main-thread-only modules (`react`, `@bodhiapp/bodhi-js-react`, `window`).
3. Must not construct auth headers directly. Use the `{ apiKey, headers? }` return shape.
4. `BODHI_PROVIDER_TAG` is the canonical source for the tag string; do not inline `'bodhi'` elsewhere.

## Change procedure

Any plan that edits `bodhi-auth-provider.ts` must update this file in the same PR. Changes that alter the public exports must also update [`integration.md`](./integration.md) and verify the consumers listed there.

See [`./index.md` § Change procedure](./index.md#change-procedure).
