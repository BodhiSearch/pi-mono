# agent

**Source of truth:** `packages/web-acp/src/agent/`

**Parent:** [`./index.md`](./index.md)

## Functional scope

The `src/agent/` subtree is the **worker-side runtime**. Five
files, each with a narrowly-scoped responsibility:

- **`agent-worker.ts`** — Web Worker entry. Listens for the
  one-shot `init` message, stands up the ACP agent, and binds
  everything together.
- **`inline-agent.ts`** — `InlineAgent`, a thin wrapper over
  `pi-agent-core`'s `Agent` that exposes the few methods
  `AcpAgentAdapter` actually calls.
- **`bodhi-provider.ts`** — `BodhiProvider`, the `LlmProvider`
  implementation. Holds the rotating access token, fetches and
  flattens the Bodhi model catalog.
- **`session-store.ts`** — `SessionStore`, the Dexie-backed
  session persistence layer added in M1. Full schema + contract
  in [`./sessions.md`](./sessions.md).
- **`stream-fn.ts`** — `createStreamFn(provider)`, a factory
  that adapts a `LlmProvider` into the `StreamFn` signature
  `pi-agent-core` expects.

The split mirrors the `worker-agent` / `worker-bodhi` split in
the reference spike (see
[`../../../specs/worker-agent/`](../../../specs/worker-agent/) and
[`../../../specs/worker-bodhi/`](../../../specs/worker-bodhi/)),
but everything lives together in one `agent/` folder for M0
because there is no generic worker harness yet — the worker only
speaks ACP today, and ACP lives in `src/acp/`. When the harness
grows (sessions, tools, compaction), we'll either extract
`bodhi-provider.ts` into its own subtree or keep the flat layout
deliberately.

## Technical reference

### `agent-worker.ts`

The Web Worker entry. Runs in `DedicatedWorkerGlobalScope`. Key
properties:

- **One-shot init.** Declares `let initialized = false;` at
  module scope. The `message` listener filters for
  `msg.type === 'init'` and logs + ignores anything that slips
  past. Duplicate inits log `[agent-worker] received duplicate
  init message; ignoring.` This matches the invariant in
  [`./index.md`](./index.md).
- **Init payload.** `AgentWorkerInitMessage = {type: 'init';
  agentPort: MessagePort}`. M0's init has no other fields. When
  future milestones add options (e.g. a dev-seed for `/vault` at
  M2.1, or a persistence db name at M1), they extend this
  interface — **not** the ACP wire protocol.
- **Boot sequence (`startAgent`).**
  1. `createMessagePortStream(port)` → `{readable, writable}`.
     See [`./transport.md`](./transport.md).
  2. `ndJsonStream(writable, readable)` → the SDK's stream
     shape.
  3. `new BodhiProvider()` — unauthenticated.
  4. `createInlineAgent(createStreamFn(provider))` — the turn
     engine.
  5. `createSessionStore()` — opens (or creates) the Dexie
     `web-acp` database. See [`./sessions.md`](./sessions.md).
  6. `new AgentSideConnection(conn => new AcpAgentAdapter(conn,
     inline, provider, store), stream)`. The factory is invoked
     synchronously by the SDK; the returned adapter is the
     `Agent` dispatch target for inbound requests.
  7. The return value of `new AgentSideConnection(...)` is held
     in a `_connection` local only to prevent the module-level
     linter from flagging the assignment as unused. The SDK
     retains it internally; the reference is not read again.

`agent-worker.ts` is **one of two files in `src/agent/` allowed
to instantiate `BodhiProvider`** (the other is
`bodhi-provider.ts` itself). Everything else talks to it through
the `LlmProvider` interface declared in `bodhi-provider.ts`.
When we add a second provider (e.g. an OpenAI adapter for non-
Bodhi deployments), this file picks which one to instantiate
based on init options.

### `inline-agent.ts`

`InlineAgent` is the **only** interface the adapter uses to
drive `pi-agent-core`. Shape:

```
export interface InlineAgent {
  setModel(model: Model<Api>): void;
  subscribe(cb: (event: AgentEvent) => void): () => void;
  getMessages(): AgentMessage[];
  getErrorMessage(): string | undefined;
  prompt(text: string): Promise<void>;
  cancel(): void;
  clearMessages(): void;
  restoreMessages(messages: AgentMessage[]): void;
}
```

#### Construction (`createInlineAgent`)

```
const agent = new Agent({
  streamFn,
  getApiKey: () => SENTINEL_API_KEY,
});
```

- `streamFn` is supplied by `createStreamFn(provider)`.
- `getApiKey` returns a **sentinel value**
  (`'bodhiapp_sentinel_api_key_ignored'`). `pi-agent-core`'s
  `Agent` constructor requires `getApiKey`, but the value is
  threaded into the streaming path we've already overridden —
  `createStreamFn` re-reads the provider's real api-key on every
  call and passes it to `streamSimple` explicitly. The sentinel
  exists to satisfy the constructor contract without leaking a
  plausible-looking empty string that could cause confusion in
  a stack trace.

#### Method behaviour

- **`setModel(model)`** — `agent.state.model = model; agent.state.tools = [];
  agent.state.systemPrompt = ''`. The tool list and system prompt
  reset is deliberate: M0's agent has no tools and no system
  prompt. When M2 introduces tools, this becomes a tool-list
  seed; when M5 introduces skills, this becomes a system-prompt
  seed.
- **`subscribe(cb)`** — passthrough to `agent.subscribe(cb)`. The
  return value is the `pi-agent-core` unsubscribe closure.
- **`getMessages()`** — returns a **shallow copy** of
  `agent.state.messages`. The copy prevents outside callers from
  mutating the internal array. M1 uses this to persist the
  transcript at turn boundaries.
- **`getErrorMessage()`** — passthrough to
  `agent.state.errorMessage`. `pi-agent-core` surfaces fatal
  errors (bad tool output, stream fault) here.
- **`prompt(text)`** — `await agent.prompt(text)`. The Agent
  drives a single turn (plus any tool loops — M2+). Returns
  `void`; state flows through events.
- **`cancel()`** — `agent.abort()`. Aborts the in-flight fetch;
  the awaiting `prompt` settles with whatever partial state had
  accumulated.
- **`clearMessages()`** — `agent.abort(); agent.state.messages =
  []`. The explicit `abort()` before clearing protects against a
  race where a stream is still writing into the old array as we
  discard it.
- **`restoreMessages(messages)`** — `agent.state.messages =
  [...messages]`. Used by `session/load` replay (Phase C) to
  seed the agent's conversation with a persisted transcript so
  follow-up prompts stay coherent. Does **not** fire
  `AgentEvent`s — replay emits the original stored
  `SessionNotification`s separately over the ACP wire.

The wrapper is deliberately **not** a class. `pi-agent-core`'s
`Agent` is a class; wrapping it in a class would invite
consumers to subclass it. The closure + interface shape makes the
minimal extractable surface explicit.

### `bodhi-provider.ts`

Matches the `worker-bodhi` split in the reference spike (see
[`../../../specs/worker-bodhi/bodhi-provider.md`](../../../specs/worker-bodhi/bodhi-provider.md))
with one deliberate simplification: `LlmProvider` and
`LlmAuthCredential` are declared **inline in this file** rather
than imported from a generic `worker-agent` types module. That
keeps the M0 footprint small; when we grow a generic harness
(M5–M7), we lift them out.

#### Types declared here

```
export interface LlmAuthCredential {
  provider: string;
  baseUrl?: string;
  token: string | null;
}

export interface LlmProvider {
  getApiKeyAndHeaders(model: Model<Api>): Promise<{
    apiKey: string;
    headers?: Record<string, string>;
  }>;
  getAvailableModels(): Promise<Model<Api>[]>;
  setAuthToken?(credential: LlmAuthCredential | null): void;
}
```

- `provider` on `LlmAuthCredential` is a free-form string tag;
  `BODHI_PROVIDER_TAG = 'bodhi'` is the only tag accepted by
  `BodhiProvider`.
- `setAuthToken` is **optional** on the interface so a stub
  provider (e.g. a test double that reads from env vars) can
  decline to implement it. `AcpAgentAdapter` checks for it? No —
  it calls it unconditionally, so any production provider must
  implement it.

#### Exported constants

- `BODHI_PROVIDER_TAG = 'bodhi'` — the credential tag.
- `CATALOG_PATH = '/bodhi/v1/models?page_size=100'` (module-
  private).
- `DEFAULT_CONTEXT_WINDOW = 128_000`,
  `DEFAULT_MAX_TOKENS = 4_096` — fallbacks when the upstream
  Bodhi response omits limits.

#### `BodhiProvider` class

State:

- `private token: string | null = null`.
- `private baseUrl: string | undefined`.

Methods:

- **`setAuthToken(credential)`.** If `credential` is falsy or
  tagged for a non-Bodhi provider, clears both fields. Otherwise
  stores `{token, baseUrl}`. Synchronous; safe to call on every
  auth-state change.
- **`getApiKeyAndHeaders(_model)`.** Returns `{apiKey: this.token
  ?? ''}`. Ignores `_model` — M0 uses a single Bodhi server for
  all models. No `headers` returned; `pi-ai` places `apiKey` in
  the right header per format.
- **`getAvailableModels()`.** Throws `"BodhiProvider: cannot
  fetch catalog before setAuthToken has been called with a valid
  Bodhi credential."` if either field is missing. Otherwise
  issues `GET ${baseUrl}/bodhi/v1/models?page_size=100` with
  `Authorization: Bearer ${token}` and `Accept: application/
  json`. On non-2xx, throws `"Failed to fetch Bodhi model
  catalog: <status> <statusText> — <body>"`. On success, parses
  the `PaginatedAliasResponse` and flattens each entry via
  `flattenAlias(entry, baseUrl)`.
- **`getBaseUrl()`.** Test-only inspector. Not called by the
  runtime.

Private flattening:

- **`flattenAlias(entry, serverRoot)`.** If `isApiAlias(entry)`
  → `flattenApiAlias`; else → `[buildLocalAliasModel(entry)]`.
  `UserAliasResponse` and `ModelAliasResponse` both map to a
  single local-engine `Model<Api>`.
- **`flattenApiAlias(entry, serverRoot)`.** Reads
  `entry.api_format` (defaults to `'openai'`) and `entry.prefix`
  (defaults to `''`). Maps every `model` in `entry.models` to a
  `Model<Api>` via `buildApiAliasModel`; filters out nulls.
- **`buildApiAliasModel(model, fmt, prefix, serverRoot)`.**
  Extracts id + display name + limits per variant; composes:
  ```
  {
    id: `${prefix}${id}`,
    name: displayName ?? `${prefix}${id}`,
    api: apiFormatToPiApi(fmt),
    provider: apiFormatToProvider(fmt),
    baseUrl: baseUrlForFormat(serverRoot, fmt),
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens
  }
  ```
- **`buildLocalAliasModel(entry, serverRoot)`.** Reads
  `alias` + optional `metadata.context.{max_input_tokens,
  max_output_tokens}` with the defaults above. Always yields a
  single `openai-completions` / `openai` entry at
  `${serverRoot}/v1`.

Module-private helpers:

- `isApiAlias(entry)` — type guard on `'api_format' in entry &&
  'models' in entry`.
- `extractApiModelId(model)` — per-variant id extraction:
  Gemini strips a `models/` prefix from `name`; Anthropic reads
  `id`; OpenAI reads `id`.
- `extractApiModelDisplayName(model)` — Anthropic `display_name`,
  Gemini `displayName`, OpenAI no display name.
- `extractApiModelLimits(model)` — per-variant limits with
  defaults: Anthropic `max_input_tokens` / `max_tokens`,
  Gemini `inputTokenLimit` / `outputTokenLimit`, OpenAI default
  fallbacks.
- `apiFormatToPiApi(fmt)` — maps `openai` → `openai-completions`,
  `openai_responses` → `openai-responses`,
  `anthropic` / `anthropic_oauth` → `anthropic-messages`,
  `gemini` → `google-generative-ai`.
- `apiFormatToProvider(fmt)` — maps to pi-ai's `Provider` union
  (`'openai'` / `'anthropic'` / `'google'`).
- `baseUrlForFormat(serverRoot, fmt)` —
  `openai_*` → `${root}/v1`, `anthropic_*` → `${root}/anthropic`,
  `gemini` → `${root}/v1beta`. `pi-ai` appends the per-format
  path suffix.

Module exports:

- `BodhiProvider` (class).
- `BODHI_PROVIDER_TAG` (constant).
- `LlmProvider`, `LlmAuthCredential` (interfaces).
- `apiFormatOfModel(model)` — inverse of `apiFormatToPiApi`,
  used by `AcpAgentAdapter.extMethod` to stamp the catalog
  response's `apiFormat` field. Maps
  `openai-responses` → `openai_responses`,
  `anthropic-messages` → `anthropic`,
  `google-generative-ai` → `gemini`,
  everything else → `openai`.

### `stream-fn.ts`

Ultra-thin factory:

```
export function createStreamFn(provider: LlmProvider): StreamFn {
  return async (model, context, options) => {
    const auth = await provider.getApiKeyAndHeaders(model);
    const headers = mergeHeaders(auth.headers, options?.headers);
    return streamSimple(model, context, {
      ...options,
      apiKey: auth.apiKey,
      headers,
    });
  };
}
```

- `StreamFn` is `pi-agent-core`'s streaming contract. Called
  once per turn (plus once per tool iteration at M2+).
- `mergeHeaders(base, override)` — returns `undefined` when both
  inputs are `undefined`, otherwise shallow-merges with override
  winning. `pi-agent-core`'s caller owns the override; the
  provider's `headers` are the base.
- `streamSimple` is re-exported by `pi-ai`; it drives the
  model-format-specific streaming endpoint.

The provider's api-key is fetched **per request**, not once at
construction. That matters because `BodhiProvider.setAuthToken`
can rotate the token mid-session (see Phase 2 of
[`./startup-sequence.md`](./startup-sequence.md#phase-2--bodhi-authenticate--catalog-fetch));
the next `streamSimple` call picks up the fresh token without
any reconstruction.

## Tests

- **`bodhi-provider.test.ts`** — not present in M0 yet. The
  reference spike at
  [`../../../specs/worker-bodhi/bodhi-provider.md`](../../../specs/worker-bodhi/bodhi-provider.md)
  § Tests lists the coverage that applies here verbatim; M1's
  test plan ports it.
- **`inline-agent`, `stream-fn`, `agent-worker`** — tested
  only through the e2e today. M1 adds unit coverage of
  `InlineAgent`'s `clearMessages` race handling and `createStreamFn`'s
  header merging.

## Constraints

1. **No main-thread-only imports.** Nothing in `src/agent/` may
   import `react`, `@bodhiapp/bodhi-js-react` runtime, or any
   `window`-only API. Type-only imports from
   `@bodhiapp/bodhi-js-react/api` are allowed (they resolve to
   pure type declarations with no runtime).
2. **Worker-entry boundary.** `agent-worker.ts` is the only
   file that runs on the Worker global scope. All others are
   plain modules that happen to be imported by the entry.
3. **ACP is the only wire protocol after boot.** The adapter
   (in `src/acp/`) is the only file that touches
   `AgentSideConnection`. Nothing in `src/agent/` talks to the
   main thread directly except the one-shot `init` receive.
4. **Provider tag isolation.** A credential tagged for a
   non-Bodhi provider clears Bodhi state; this is how a future
   multi-provider `set_auth_token` channel stays safe.

## Change procedure

Any plan that edits files under `packages/web-acp/src/agent/`
must update this file in the same commit. When extracting
`bodhi-provider.ts` into its own subtree (likely at M7), create
a new spec file and update the navigation in
[`./index.md`](./index.md).

See [`./index.md` § Change procedure](./index.md#change-procedure).
