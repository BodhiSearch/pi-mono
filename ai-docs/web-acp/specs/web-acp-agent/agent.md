# Agent runtime — InlineAgent, BodhiProvider, stream-fn, system-prompt

**Source of truth (agent package):** `packages/web-acp-agent/src/agent/`.

## Purpose

Wraps the LLM-driving runtime that the engine layer
([acp.md](./acp.md)) calls into. Owns:

- `InlineAgent` — a thin, structured-clone-safe wrapper over
  `@mariozechner/pi-agent-core`'s `Agent` class. Engine layer
  uses it for the per-turn prompt loop.
- `BodhiProvider` — the default `LlmProvider` implementation,
  hand-rolled against the Bodhi `/bodhi/v1/models` catalog.
- `createStreamFn(provider, consumeOverrides?)` — bridges
  `LlmProvider` to `pi-ai`'s `streamSimple`.
- `composeSystemPrompt(volumes)` — builds the worker-owned
  system prompt before each turn.

## InlineAgent — `agent/inline-agent.ts`

`agent/inline-agent.ts:createInlineAgent(streamFn)` constructs
a `pi-agent-core` `Agent` and returns an `InlineAgent` value.
`InlineAgent` is the public interface (defined at the same
file, lines 13–27); the underlying `Agent` instance never
escapes.

Why a wrapper:

- **Structured-clone safety.** Hosts that want to expose the
  agent across realms (browser worker `MessagePort`, Node
  `MessagePort`/IPC, future iframe sandbox) need a value with
  data-only state, not a class instance with prototype
  methods. The wrapper closes over the `Agent` and exposes a
  plain object. This isn't actively exploited today (the
  agent runs in-process with the engine layer) but the
  discipline keeps the boundary clean.
- **API narrowing.** `Agent` exposes a lot — `state.messages`,
  `state.systemPrompt`, internal abort logic, etc. The
  engine layer only needs `setModel`, `subscribe`, `prompt`,
  `cancel`, `getMessages`, `getErrorMessage`,
  `clearMessages`, `restoreMessages`. Spelling them out in the
  interface makes the dependency obvious at every call site.

Method behaviours:

| Method | Behaviour |
| --- | --- |
| `setModel(model, opts?)` | Sets `agent.state.model = model`, replaces `agent.state.tools` with `opts.tools ?? []`, replaces `agent.state.systemPrompt` with `opts.systemPrompt ?? ''`. Called once per turn from `prompt-driver.ts:run`. |
| `subscribe(cb)` | Forwards to `agent.subscribe`. Returns the unsubscribe function. The driver subscribes during `run()` and unsubscribes in the `finally`. |
| `getMessages()` | Returns a shallow copy of `agent.state.messages` (`[...agent.state.messages]`). The copy is important — the driver passes this directly to `services.store.recordTurn` and we don't want callers mutating the live `Agent` state. |
| `getErrorMessage()` | Returns `agent.state.errorMessage`. The driver throws when this is set after `prompt()` resolves. |
| `prompt(text)` | Awaits `agent.prompt(text)`. Streaming events fire through the `subscribe` listener as side effects. |
| `cancel()` | Calls `agent.abort()`. |
| `clearMessages()` | Aborts in-flight + resets `agent.state.messages = []`. Called by `authenticate` (after token rotation), `newSession`, and `loadSession` (when no prior turn exists). |
| `restoreMessages(messages)` | Replaces `agent.state.messages` with `[...messages]` without firing events. Called by `loadSession` and `rehydrateInlineFromStore` (`acp/engine/session-runtime.ts:227`) to seed history from the last persisted `'turn'` entry. |

Constants: `SENTINEL_API_KEY` (`'bodhiapp_sentinel_api_key_ignored'`)
is the API key the underlying `Agent.getApiKey` returns. The
real key plumbing lives in `createStreamFn` →
`provider.getApiKeyAndHeaders`; `pi-agent-core` doesn't use
the sentinel for anything that actually crosses the wire, but
its API requires *some* string.

## BodhiProvider — `agent/bodhi-provider.ts`

`agent/bodhi-provider.ts:BodhiProvider` is the default
`LlmProvider` implementation. The interface is co-located in
the same file — `agent/bodhi-provider.ts:LlmProvider` (line
29) is the host-overridable seam.

`LlmProvider`:

```ts
interface LlmProvider {
    getApiKeyAndHeaders(model: Model<Api>):
        Promise<{ apiKey: string; headers?: Record<string, string> }>;
    getAvailableModels(): Promise<Model<Api>[]>;
    setAuthToken?(credential: LlmAuthCredential | null): void;
}
```

`LlmAuthCredential`:
`{ provider: string, baseUrl?: string, token: string | null }`.

### State

`BodhiProvider` carries two private fields: `token` and
`baseUrl`. Both populate from `setAuthToken` and clear on
`null` / wrong-provider credentials. `getBaseUrl()` (line 71)
exposes `baseUrl` for the built-in command handlers
(`/info` reports the connected server URL).

### `setAuthToken(credential)` — line 39

- `null` or `provider !== BODHI_PROVIDER_TAG` → clears both fields.
- Otherwise stores both. The agent never persists tokens; rotation
  comes from the host calling `authenticate` again with fresh
  credentials.

### `getApiKeyAndHeaders(model)` — line 49

Returns `{ apiKey: this.token ?? '' }`. The Bodhi proxy reads
`Authorization: Bearer <apiKey>` and adds its own outbound
auth, so a single bearer is enough.

### `getAvailableModels()` — line 53

Fetches `${baseUrl}/bodhi/v1/models?page_size=100` and flattens
the response. The Bodhi catalog has two flavours of entries:

- **API alias** (`api_format` + `models[]`) — flattened via
  `flattenApiAlias` (`:104`) → `buildApiAliasModel` (`:122`).
  One alias can produce multiple `Model<Api>` records (one per
  underlying model).
- **Local alias** (`UserAliasResponse | ModelAliasResponse`) —
  flattened via `buildLocalAliasModel` (`:145`) into a single
  OpenAI-completions-shaped `Model<Api>`.

Per-format mapping helpers:

- `apiFormatToPiApi(fmt)` — `'openai_responses' →
  'openai-responses'`, `'anthropic' / 'anthropic_oauth' →
  'anthropic-messages'`, `'gemini' →
  'google-generative-ai'`, default `'openai-completions'`.
- `apiFormatToProvider(fmt)` — `'anthropic' →
  'anthropic'`, `'gemini' → 'google'`, default `'openai'`.
- `baseUrlForFormat(serverRoot, fmt)` — appends `/anthropic`,
  `/v1beta`, or `/v1` depending on the format. The Bodhi
  proxy fronts each upstream API behind a per-format
  sub-path.
- `apiFormatOfModel(model)` (`:246`) — inverse mapping for
  the wire (`bodhi/listModels` returns
  `{ id, apiFormat: 'openai' | 'openai_responses' | 'anthropic' | 'gemini' }`).

Per-model field extraction: `extractApiModelId` (`:171`) +
`extractApiModelDisplayName` (`:183`) + `extractApiModelLimits`
(`:194`). They route per provider (Gemini's `name: 'models/X'`
prefix gets stripped, Anthropic's `display_name` becomes the
display label, OpenAI uses `id` directly).

`requireCredentials()` (`:75`) throws `'BodhiProvider: cannot
fetch catalog before setAuthToken has been called with a valid
Bodhi credential.'` if `setAuthToken` hasn't run with a
matching provider tag — protects callers from silent empty
catalogs.

### Replacing `BodhiProvider`

Hosts that want a different LLM provider implement the same
`LlmProvider` interface and pass their instance into
`assembleServices({ bodhi: customProvider })`. The CLI host's
`packages/cli-acp-client/src/services/assemble.ts` does this
(though it currently still uses the default `BodhiProvider`).

## createStreamFn — `agent/stream-fn.ts`

`agent/stream-fn.ts:createStreamFn(provider, consumeOverrides?)`
is the bridge from `LlmProvider` to `@mariozechner/pi-ai`'s
`streamSimple`. It returns a `StreamFn` (the type
`pi-agent-core`'s `Agent` consumes via the `streamFn` option).

Responsibilities per call:

1. Pull `apiKey` + optional `headers` from
   `provider.getApiKeyAndHeaders(model)`.
2. Merge `auth.headers` with caller-supplied `options.headers`
   via `mergeHeaders` (caller wins on collision).
3. Read-and-clear per-turn overrides via
   `consumeOverrides?.()`.
4. Call `streamSimple(model, context, { ...options,
   ...overridesAsExtra, apiKey, headers })`.

`StreamOptionOverrides`: `{ toolChoice?: 'auto' | 'required' |
'none' }`. `'required'` forces the model to emit a tool call
on the next call. The driver pushes this DEV-only override
when `forceToolCall` is on (see [features.md](./features.md)).

**One-shot semantics.** `consumeOverrides` is called once per
LLM request. The driver's `streamOverrides.current` ref pattern
(see `acp/engine/services.ts:StreamOverridesRef`) sets the
override **before** `inline.prompt(text)` and `pi-agent-core`'s
loop only sees it on the first request — subsequent
re-prompts within the same turn (e.g. after a tool call) use
the model's discretion. Without one-shot semantics
`forceToolCall` would be self-perpetuating.

## composeSystemPrompt — `agent/system-prompt.ts`

`agent/system-prompt.ts:composeSystemPrompt(volumes)` returns
a string built once per turn from the volume registry
snapshot. Empty when no volumes are mounted (we don't
hallucinate a `/mnt` filesystem for the LLM that doesn't exist
on the worker).

Otherwise:

```
You have access to the following volumes:
- /mnt/<mountName> — <description?>
- /mnt/<mountName2> — <description?>
…
Use the bash tool to explore them.
```

Called from `prompt-driver.ts:run` (`:135`). Output goes into
`InlineAgent.setModel({ systemPrompt })` for the turn.

## Cross-references

- Engine layer that consumes these:
  [`acp.md`](./acp.md).
- Bash tool that the LLM ends up calling on the volumes:
  [`tools.md`](./tools.md).
- Volume registry the system prompt mirrors:
  [`volumes.md`](./volumes.md).
- Host-side auth observation that drives `setAuthToken`:
  [`../web-acp-client/hooks.md`](../web-acp-client/hooks.md)
  (`useAcpAuth`).
