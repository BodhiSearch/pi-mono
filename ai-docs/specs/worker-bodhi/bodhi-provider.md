# bodhi-provider

**Source of truth:** `packages/web-agent/src/worker-bodhi/bodhi-provider.ts`

**Parent:** [`../worker-bodhi/index.md`](./index.md)

## Functional scope

`BodhiProvider` is the only `LlmProvider` implementation shipped by Bodhi
today. It is the worker-side "AI gateway" for Bodhi: it holds the
short-lived access token forwarded from the main thread, resolves
per-request auth material, and fetches the live model catalog from the
Bodhi server on demand.

### Responsibilities

- Accept / ignore inbound `LlmAuthCredential` envelopes based on `provider`
  tag.
- Store the current token + baseUrl.
- Resolve `{ apiKey }` for streaming turns and compaction completions.
- Fetch `/bodhi/v1/models` on demand and flatten the response into
  `Model<Api>[]`, mapping each supported `api_format` (openai,
  openai_responses, anthropic, gemini) into the matching pi-ai `Provider`
  and extracting accurate `contextWindow` / `maxTokens` / `displayName`
  from the upstream `ApiModel` variant.

### Non-responsibilities

- Header synthesis (pi-ai does it from `apiKey`).
- Token refresh / expiry handling (main thread's job; a fresh credential is
  pushed on every auth state change).
- Catalog caching — each `getAvailableModels()` call issues a fresh
  network request.

## Technical reference

### Public exports (`index.ts`)

- `BodhiProvider` — the class.
- `BODHI_PROVIDER_TAG = 'bodhi'` — the credential tag.

Used by:

- `bodhi-provider.ts` itself — to filter inbound credentials.
- `packages/web-agent/src/hooks/useAgent.ts` — to build correctly-tagged
  `LlmAuthCredential` envelopes without string-literal drift.
- `worker-agent/worker/agent-worker.ts` and
  `worker-agent/worker/boot.ts` — to import `BodhiProvider` and instantiate
  it at boot. See [`integration.md`](./integration.md).

### `BodhiProvider` class

Implements `LlmProvider` from
`packages/web-agent/src/worker-agent/llm/types.ts`.

#### Private state

- `token: string | null` — current rotating access token; `null` when cleared.
- `baseUrl: string | undefined` — Bodhi server root the token was bound to.
  Required when fetching the catalog; also retained for diagnostics.

#### Methods

- **`setAuthToken(credential)`**
  - If `credential` is falsy, or
    `credential.provider !== BODHI_PROVIDER_TAG`, reset `token = null` and
    `baseUrl = undefined`. This ensures a credential tagged for another
    provider clears Bodhi's state rather than leaving a stale token active
    on a shared `set_auth_token` channel.
  - Otherwise, store `credential.token` and `credential.baseUrl`.
  - Synchronous and cheap — safe to call on every main-thread
    auth-observable change.

- **`getApiKeyAndHeaders(_model)`**
  - Returns `{ apiKey: this.token ?? '' }`.
  - The `_model` parameter is part of the `LlmProvider` contract but
    unused here (all Bodhi requests share one token surface).
  - No `headers` returned — pi-ai handles per-format header placement
    from `apiKey`.

- **`getAvailableModels()`**
  - Requires a non-null `{ baseUrl, token }` — rejects with
    `Error('Bodhi auth credential missing — call setAuthToken first')`
    otherwise.
  - Issues `GET ${baseUrl}/bodhi/v1/models?page_size=100` with
    `Accept: application/json` and `Authorization: Bearer <token>`.
  - On a non-2xx status, rejects with a descriptive `Error` including the
    status code and best-effort response body.
  - Deserialises the `PaginatedAliasResponse` and calls private
    `flattenAlias(entry, baseUrl)` for every item, accumulating the
    resulting `Model<Api>[]`. `UserAliasResponse` /
    `ModelAliasResponse` map to a single local-engine entry;
    `ApiAliasResponse` fans out into one entry per exposed model.
  - Per-variant details:
    - `openai` / `openai_responses` — reads `id`, `context_window` and
      `max_tokens` from the upstream OpenAI `Model` (both with sensible
      fallbacks to `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS`).
    - `anthropic` — reads `display_name`, `context_window`, `max_tokens`
      from the `AnthropicModel` variant.
    - `gemini` — reads `displayName`, `inputTokenLimit`,
      `outputTokenLimit` from the `GeminiModel` variant.
  - Per-variant `baseUrl` handling (`baseUrlForFormat`) preserves pi-ai's
    expectations: OpenAI variants get `serverRoot`, Anthropic gets
    `serverRoot/anthropic`, Gemini gets `serverRoot/v1beta`. The pi-ai
    library appends the per-format path suffix.

- **`getBaseUrl()`**
  - Test-only inspector returning the stored `baseUrl`. Not part of the
    `LlmProvider` interface. Not invoked by the runtime.

## Tests (`bodhi-provider.test.ts`)

The suite uses `vi.stubGlobal('fetch', ...)` to mock the Bodhi catalog
endpoint. Coverage:

1. **Default state.** `getApiKeyAndHeaders` returns `{ apiKey: '' }` with no
   credential set.
2. **Bodhi-tagged credential.** `setAuthToken({ provider: 'bodhi', baseUrl,
   token })` stores both; `getApiKeyAndHeaders` returns `{ apiKey: token }`;
   `getBaseUrl()` returns the stored `baseUrl`.
3. **`null` credential.** Clears both `token` and `baseUrl`.
4. **Foreign-tagged credential.** Any `provider` other than `'bodhi'`
   clears local state even when Bodhi previously had a valid credential —
   proves the tag filter works even if a parent rotation channel is shared
   across providers.
5. **Catalog — no credential.** `getAvailableModels()` rejects without
   calling `fetch`.
6. **Catalog — UserAlias / ModelAlias.** Returns one `Model<Api>` entry per
   local alias with provider `'bodhi-local'` (or equivalent) and the
   default context/max-tokens fallbacks.
7. **Catalog — Api openai.** Maps each model in the `models` array to an
   `openai-completions` `Model<Api>` with `baseUrl = serverRoot`.
8. **Catalog — Api openai_responses.** Same as above but with
   `openai-responses` `api`.
9. **Catalog — Api anthropic.** Maps to `anthropic-messages` with
   `baseUrl = serverRoot/anthropic` and reads the Anthropic metadata.
10. **Catalog — Api gemini.** Maps to `google-generative-ai` with
    `baseUrl = serverRoot/v1beta` and reads the Gemini metadata.
11. **Catalog — HTTP error.** Rejects with the status code and body text.
12. **Catalog — missing token.** Rejects before the fetch.
13. **Catalog — tolerant of missing metadata.** Falls back to
    `DEFAULT_CONTEXT_WINDOW` / `DEFAULT_MAX_TOKENS` when the upstream
    payload omits limits.

## Constraints

1. Must continue to satisfy `LlmProvider` from
   `worker-agent/llm/types.ts`. If the interface adds members, update this
   module and add coverage.
2. Must not import main-thread-only modules (`react`,
   `@bodhiapp/bodhi-js-react` runtime, `window`). Type-only imports from
   `@bodhiapp/bodhi-js-react/api` are allowed because they resolve to the
   generated `ts-client` types with no runtime dependency.
3. Must not construct auth headers for the streaming path directly. Use
   the `{ apiKey, headers? }` return shape from `getApiKeyAndHeaders`. The
   `Authorization: Bearer` header used for the catalog fetch is internal
   to the provider and does not leak into pi-ai.
4. `BODHI_PROVIDER_TAG` is the canonical source for the tag string; do not
   inline `'bodhi'` elsewhere.

## Change procedure

Any plan that edits `bodhi-provider.ts` must update this file in the same
PR. Changes that alter the public exports must also update
[`integration.md`](./integration.md) and verify the consumers listed there.

See [`./index.md` § Change procedure](./index.md#change-procedure).
