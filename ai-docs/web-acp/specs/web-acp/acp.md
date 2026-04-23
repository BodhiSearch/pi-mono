# acp

**Source of truth:** `packages/web-acp/src/acp/`

**Parent:** [`./index.md`](./index.md)

## Functional scope

The `src/acp/` subtree holds the ACP wire surface and the
Bodhi-specific extensions layered on top of the
`@agentclientprotocol/sdk@0.17.0` primitives. Three files:

- **`index.ts`** — SDK re-exports + the Bodhi-specific constants
  (`BODHI_AUTH_METHOD_ID`, `BODHI_LIST_MODELS_METHOD`,
  `BODHI_LIST_SESSIONS_METHOD`, `BODHI_GET_SESSION_METHOD`) +
  the `_meta` shapes that travel alongside ACP's standard
  payloads.
- **`client.ts`** — `AcpClient`, a thin wrapper over
  `ClientSideConnection` that `useAcp` consumes on the main
  thread.
- **`agent-adapter.ts`** — `AcpAgentAdapter`, the
  `Agent`-interface implementation that runs inside the Web
  Worker.

Scope invariants:

- **ACP is the only wire protocol.** The adapter's deviations
  from stock ACP are the `bodhi-token` auth method (advertised via
  the standard `authMethods` response array) and the three
  extension methods `bodhi/listModels` + `bodhi/listSessions` +
  `bodhi/getSession` (served via `Agent.extMethod`, a standard SDK
  escape hatch). Session-scoped `_meta` on `session/prompt`
  carries the selected model id. `bodhi/listSessions` is used in
  preference to the upstream `session/list` because the latter
  lives under the SDK's `schema.unstable.json` surface; this repo
  only consumes the stable schema (see [`./index.md`](./index.md)).
  `bodhi/getSession` is a condensed "snapshot" sibling to the
  stable `session/load` request — `session/load` streams stored
  notifications back verbatim (per ACP) while `bodhi/getSession`
  returns the collapsed last-turn transcript + `lastModelId` in a
  single reply, which is what the UI actually needs to rehydrate
  the React state tree. Both paths read from the same
  `SessionStore`, so they cannot disagree. M2 adds three more
  extension methods under the spec-blessed `_`-prefix:
  `_bodhi/volumes/list`, `_bodhi/features/list`, and
  `_bodhi/features/set`. The older `bodhi/*` methods keep the
  pre-spec prefix so the M0/M1 client contracts don't churn; a
  unified rename is tracked as a deferred cleanup item.
- **The Bodhi constants are defined once.** `acp/index.ts` is the
  single source; `client.ts` and `agent-adapter.ts` import from it.
  `useAcp` never inlines any of the string literals.
- **No framing here.** Byte-stream plumbing lives in
  [`./transport.md`](./transport.md). Worker spawn lives in
  [`./agent.md`](./agent.md).

## Technical reference

### `acp/index.ts`

Public surface:

- `AgentSideConnection`, `ClientSideConnection`, `ndJsonStream`
  — re-exported from the SDK so every other module imports them
  through the same path.
- Type re-exports: `Agent`, `Client`, `AuthenticateRequest`,
  `AuthenticateResponse`, `CancelNotification`,
  `InitializeRequest`, `InitializeResponse`, `NewSessionRequest`,
  `NewSessionResponse`, `PromptRequest`, `PromptResponse`,
  `SessionNotification`, `StopReason`.
- `BODHI_AUTH_METHOD_ID = 'bodhi-token'` — the auth method id
  advertised in `initialize` and echoed back in
  `AuthenticateRequest.methodId`.
- `BODHI_LIST_MODELS_METHOD = 'bodhi/listModels'` — the extension
  method id consumed by `conn.extMethod(...)`.
- `BODHI_LIST_SESSIONS_METHOD = 'bodhi/listSessions'` — the
  extension method id for picker feed (M1).
- `BODHI_GET_SESSION_METHOD = 'bodhi/getSession'` — the extension
  method id for the snapshot read consumed by `useAcp.loadSession`
  after a successful `session/load` (M1).
- `BODHI_VOLUMES_LIST_METHOD = '_bodhi/volumes/list'` — read-only
  introspection of the worker-side `VolumeRegistry`. Covered in
  [`./vault.md`](./vault.md).
- `BODHI_FEATURES_LIST_METHOD = '_bodhi/features/list'` and
  `BODHI_FEATURES_SET_METHOD = '_bodhi/features/set'` — per-session
  feature-toggle surface. Covered in [`./features.md`](./features.md).
- `BodhiAuthenticateMeta = { token: string; baseUrl: string }` —
  the `_meta` shape on `authenticate`.
- `BodhiModelDescriptor = { id: string; apiFormat: string }` —
  the lossy summary surfaced to the main thread (the worker keeps
  the full `Model<Api>`; see [`./agent.md`](./agent.md)).
- `BodhiListModelsResponse extends Record<string, unknown>` with
  `models: BodhiModelDescriptor[]` — the return shape of
  `bodhi/listModels`.
- `BodhiSessionSummary = { id, title, createdAt, updatedAt,
  turnCount, lastModelId }` — picker row shape; mirrors
  `SessionSummary` from `agent/session-store` but is the wire
  contract, kept independent so store internals can evolve
  without breaking clients.
- `BodhiListSessionsResponse extends Record<string, unknown>` with
  `sessions: BodhiSessionSummary[]` — return shape of
  `bodhi/listSessions`.
- `BodhiGetSessionRequest extends Record<string, unknown>` with
  `sessionId: string` — params shape of `bodhi/getSession`.
- `BodhiGetSessionResponse extends Record<string, unknown>` with
  `sessionId, messages: unknown[], lastModelId: string | null,
  title: string | null` — return shape of `bodhi/getSession`.
  `messages` is typed as `unknown[]` on the wire because the
  canonical shape is `pi-agent-core`'s `AgentMessage[]`, which is
  a moving internal type; the client casts on receipt.

### `acp/client.ts`

`AcpClient` is a narrow typed facade:

- **Ownership.** Constructed once per worker (by
  `useAcp.ensureRuntime`) and stored at module scope. Holds
  `readonly #conn: ClientSideConnection` plus `readonly
  #listeners: Set<SessionUpdateListener>`.
- **`signal`.** Passthrough to `#conn.signal` — the SDK's
  transport-level abort signal. Consumers can watch it to react
  to the underlying stream closing.
- **`closed`.** Passthrough to `#conn.closed` — the SDK's
  close-promise.
- **`initialize()`.**
  ```
  return this.#conn.initialize({
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false }
    }
  });
  ```
  The response carries the agent's capabilities + `authMethods`
  array. M0 does not use the response beyond ordering; `useAcp`
  awaits the resulting promise before issuing other calls.
- **`authenticate(args: BodhiAuthenticateMeta)`.**
  ```
  await this.#conn.authenticate({
    methodId: BODHI_AUTH_METHOD_ID,
    _meta: { token: args.token, baseUrl: args.baseUrl }
  });
  ```
  Returns `void`; errors propagate from the adapter (invalid
  method id, missing `_meta` fields).
- **`listModels()`.**
  ```
  const raw = await this.#conn.extMethod(BODHI_LIST_MODELS_METHOD, {});
  return (raw as BodhiListModelsResponse).models ?? [];
  ```
- **`listSessions()`.**
  ```
  const raw = await this.#conn.extMethod(BODHI_LIST_SESSIONS_METHOD, {});
  return (raw as BodhiListSessionsResponse).sessions ?? [];
  ```
  Returns picker-ready rows ordered by `updatedAt DESC` (the
  adapter delegates to `SessionStore.listSummaries`).
- **`loadSession(sessionId)`.** Calls
  `this.#conn.loadSession({sessionId, cwd: '/', mcpServers: []})`
  — the stable SDK method. The agent replays stored
  `session/update` notifications verbatim during this call; the
  hook silences the live handler via an `isReplayingRef` so
  those deltas don't touch the UI (the snapshot path does the
  rehydration instead).
- **`getSession(sessionId)`.** `return await
  this.#conn.extMethod(BODHI_GET_SESSION_METHOD, {sessionId}) as
  BodhiGetSessionResponse`. Used immediately after
  `loadSession` by `useAcp` to obtain the last turn's
  `finalMessages` + `lastModelId` + `title` in one hop.
- **`newSession()`.** `return this.#conn.newSession({cwd: '/',
  mcpServers: []})`. `cwd` and `mcpServers` are stubs — M0's
  adapter ignores both. They're present because the SDK types
  require them; M2 gives `cwd` semantic meaning (see
  [`../../milestones/m2-tools.md`](../../milestones/m2-tools.md)).
- **`prompt(sessionId, text, modelId)`.**
  ```
  return this.#conn.prompt({
    sessionId,
    prompt: [{ type: 'text', text }],
    _meta: { bodhi: { modelId } }
  });
  ```
- **`cancel(sessionId)`.** `this.#conn.cancel({sessionId})`; the
  SDK dispatches this as a JSON-RPC notification.
- **`listVolumes()` / `listFeatures(sessionId)` / `setFeature(sessionId, key, value)`.**
  Thin wrappers over the M2 extension methods
  (`_bodhi/volumes/list`, `_bodhi/features/list`,
  `_bodhi/features/set`). Detail in [`./vault.md`](./vault.md) and
  [`./features.md`](./features.md).
- **`onSessionUpdate(listener)`.** Adds the listener to
  `#listeners`; returns an unsubscribe closure. **Not** a
  passthrough to the SDK — `ClientSideConnection` only carries
  notifications if the `Client` handler picks them up. That
  plumbing lives in `useAcp.ensureRuntime`, which installs a
  `Client.sessionUpdate` method that forwards into
  `dispatchSessionUpdate` below.
- **`dispatchSessionUpdate(notification)`.** Iterates
  `#listeners` and invokes each with the notification. Listener
  throws are caught and logged so a bad listener cannot break
  the transport.

`buildClientHandler(client)` is exported but unused today (it
was used by an earlier phase-C scaffold; `useAcp` now inlines the
handler to add `requestPermission`). Kept for reference — when we
grow the handler surface at M1, this function is the natural home
for it.

### `acp/agent-adapter.ts`

`AcpAgentAdapter` implements `Agent` from the SDK. Inputs come
from the SDK's dispatcher on the worker side; outputs leave as
`this.#conn.sessionUpdate(...)` for notifications or as return
values for request/response.

#### State

- `readonly #conn: AgentSideConnection` — supplied by the SDK
  factory; used to send notifications and (future) client-side
  requests.
- `readonly #inline: InlineAgent` — the single-agent runtime. M0
  used one `InlineAgent` for all sessions. M1 keeps the single
  `InlineAgent` but now reseeds its message history via
  `InlineAgent.restoreMessages` on `session/load`.
- `readonly #bodhi: BodhiProvider` — the token + catalog holder.
- `readonly #store: SessionStore | undefined` — M1 persistence
  layer (optional so unit tests can run memory-only). Full
  schema + contract in [`./sessions.md`](./sessions.md).
- `readonly #sessions = new Map<string, SessionState>()` — pure
  in-memory existence tracking. The authoritative session list
  lives in `#store` (IndexedDB); `#sessions` exists so the
  adapter can reject `prompt`/`cancel` on an id it hasn't
  acknowledged this tab.
- `#models: Model<Api>[] = []` — catalog cache populated by
  `extMethod('bodhi/listModels')` and consumed by `prompt` to
  resolve `_meta.bodhi.modelId`.
- `#cancelled = false` — per-turn flag set by `cancel`, read by
  `prompt`.
- `#activeInlineSessionId: string | null = null` — identity of the
  session whose history is currently seeded into the
  `InlineAgent`. Updated on `newSession` (clearMessages + set),
  `loadSession` (restoreMessages + set), and
  `#rehydrateInlineFromStore` (same flow, called from `prompt`
  when it detects a mismatch). Prevents `recordTurn` from
  persisting another session's messages into the current turn's
  `finalMessages` — the root cause of the "transcripts cross
  over after `+ New chat`" bug fixed in Phase C.

#### Methods

- **`initialize(_params: InitializeRequest): Promise<InitializeResponse>`.**
  Returns the static response shown in
  [`./startup-sequence.md`](./startup-sequence.md#initialize-payload-exchange):
  `protocolVersion: 1`,
  `agentCapabilities: { loadSession: <store-configured>,
  promptCapabilities: { image: false, audio: false,
  embeddedContext: false } }`,
  `authMethods: [{id: BODHI_AUTH_METHOD_ID, name, description}]`.
  `loadSession` is advertised as `true` whenever a
  `SessionStore` is wired into the adapter — which, in
  production, is always, because `agent-worker.ts` always
  instantiates one. Unit tests that construct the adapter
  without a store get `loadSession: false` and no resume
  surface, as expected. No MCP capabilities advertised (see
  [`../../milestones/m2-tools.md`](../../milestones/m2-tools.md)
  § M2.3).

- **`authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse>`.**
  1. Throws `"Unsupported auth method: <id>"` if `params.methodId
     !== BODHI_AUTH_METHOD_ID`.
  2. Casts `params._meta` to `Partial<BodhiAuthenticateMeta>`;
     throws `"authenticate: _meta must include { token, baseUrl
     }"` if either is missing or falsy.
  3. `this.#bodhi.setAuthToken({provider: 'bodhi', token,
     baseUrl})`.
  4. Resets `this.#models = []` so a stale catalog can't cross
     an auth boundary.
  5. `this.#inline.clearMessages()` — discards any previous
     turn's transcript. M1 revisits this; for M0 it prevents a
     pre-auth message leaking into a post-auth turn.
  6. Returns `{}` (the SDK's minimal `AuthenticateResponse`).

- **`newSession(_params: NewSessionRequest): Promise<NewSessionResponse>`.**
  Generates `sessionId = 'bodhi-' + crypto.randomUUID()`;
  registers it in `#sessions`; calls
  `await #store.createSession(sessionId)` when a store is
  configured; then `this.#inline.clearMessages()` and sets
  `#activeInlineSessionId = sessionId`. Clearing the inline
  runtime on every new session is what prevents the previous
  session's transcript from leaking into the next one's
  `finalMessages` (the "+ New chat → Anthropic prompt" case in
  `sessions-resume.spec.ts`). The `NewSessionRequest`
  (`{cwd, mcpServers}`) is ignored today — both are stubs; M2.1
  gives `cwd` semantic meaning.

- **`loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse>`.**
  Requires `#store`. Flow:
  1. `store.getSession(sessionId)` — throws on unknown id.
  2. Register in `#sessions` so a subsequent `prompt` passes the
     existence check.
  3. `store.readEntries(sessionId)` — iterate in `seq` order.
     Every `notification` entry is re-emitted verbatim via
     `#conn.sessionUpdate(...)` (deliberately bypassing `#emit`
     to avoid double-persisting rows). Every `turn` entry
     overwrites `lastTurnMessages`.
  4. If `lastTurnMessages` is present,
     `inline.restoreMessages(lastTurnMessages)`; otherwise
     `inline.clearMessages()`.
  5. `#activeInlineSessionId = sessionId`.
  6. Returns `{}` — ACP's minimal `LoadSessionResponse`. Model
     restoration travels over the companion `bodhi/getSession`
     reply; ACP's stable `LoadSessionResponse` has no
     first-class field for "last model" yet.

- **`prompt(params: PromptRequest): Promise<PromptResponse>`.**
  Detailed flow in
  [`./startup-sequence.md § Phase 3`](./startup-sequence.md#phase-3--first-prompt).
  Summary:
  1. Session lookup (throws on miss).
  2. Model resolution via `_meta.bodhi.modelId` against
     `#models` (throws on miss).
  3. Text extraction (concatenates every `type: 'text'` block in
     `params.prompt`; throws if empty).
  4. If `#activeInlineSessionId !== params.sessionId`, call
     `#rehydrateInlineFromStore(params.sessionId)` — otherwise a
     stale inline history (e.g. from a prior session whose
     `loadSession` wasn't re-issued after worker restart) would
     get spliced into the new turn's `finalMessages`.
  5. `this.#inline.setModel(model)`.
  6. Subscribes to `inline` events; routes `message_update`
     events through `#forwardEvent`.
  7. `await this.#inline.prompt(text)`.
  8. Returns `{stopReason: 'cancelled'}` if `#cancelled`;
     throws `inline.getErrorMessage()` if set; otherwise on
     clean `end_turn` calls `await #store.recordTurn(sessionId,
     text, inline.getMessages(), model.id)` (M1) and returns
     `{stopReason: 'end_turn'}`. `modelId` is persisted on the
     turn row so `session/load` can tell the UI which model was
     last in use for this session.
  9. Unsubscribes in `finally`.

- **`cancel(_params: CancelNotification): Promise<void>`.**
  `this.#cancelled = true; this.#inline.cancel()`. The abort
  flow is synchronous; `inline.cancel()` maps to
  `agent.abort()` in `pi-agent-core` which aborts the
  in-flight fetch.

- **`extMethod(method, _params)`.**
  If `method === BODHI_LIST_MODELS_METHOD`:
  ```
  this.#models = await this.#bodhi.getAvailableModels();
  return {
    models: this.#models.map(m => ({
      id: m.id,
      apiFormat: apiFormatOfModel(m)
    }))
  };
  ```
  If `method === BODHI_LIST_SESSIONS_METHOD`:
  ```
  const summaries = this.#store ? await this.#store.listSummaries() : [];
  return { sessions: summaries };
  ```
  An empty array is returned when the store is not configured
  (e.g. in unit tests that instantiate the adapter without a
  store).
  If `method === BODHI_GET_SESSION_METHOD`:
  ```
  const row = await this.#store.getSession(req.sessionId);      // throws on unknown
  const entries = await this.#store.readEntries(req.sessionId);
  const messages = lastTurnFrom(entries)?.finalMessages ?? [];
  return { sessionId: row.id, messages, lastModelId: row.lastModelId, title: row.title };
  ```
  Throws if the store is not configured or the session is
  unknown; those errors surface to the UI as a toast.
  Otherwise throws `"Unknown extension method: <name>"`
  so the SDK serialises a JSON-RPC error back. Full catalog
  flattening lives in [`./agent.md`](./agent.md);
  `apiFormatOfModel` is the inverse of `apiFormatToPiApi` used
  during flattening.

#### Private helpers

- **`#resolveModel(params)`.** Reads `params._meta.bodhi.modelId`;
  returns the matching entry in `#models` or `undefined`. Kept
  private because `_meta` is not a stable API surface — when the
  main thread stops routing modelId through `_meta` (likely at
  M1 when session metadata can carry it), this helper changes.
- **`#extractPromptText(params)`.** Concatenates every `text`
  block; ignores other block types (images, embedded context).
  In line with the M0 `promptCapabilities` (all false).
- **`#forwardEvent(sessionId, event, cursor)`.** Translates
  `pi-agent-core` `AgentEvent`s into ACP notifications. Calls
  `#emit(notification)` rather than `#conn.sessionUpdate`
  directly so persistence is on the same path.
  1. Early-returns for non-`message_update` events.
  2. Early-returns if the message role isn't `'assistant'`.
  3. Recomputes the message id (`extractMessageId`) and resets
     `cursor.emittedLength = 0` on a new id.
  4. Computes `delta = text.slice(cursor.emittedLength)`;
     early-returns if empty (idempotent updates of the same
     prefix).
  5. Updates `cursor.emittedLength = text.length`.
  6. Calls `await this.#emit({sessionId, update: {...agent_message_chunk}})`.
- **`#emit(notification)`.** Single exit point for every
  `session/update` notification in M1+. Emits to the client via
  `#conn.sessionUpdate(notification)` **and** persists via
  `#store.recordNotification(sessionId, notification)` on the
  same path. Persistence failures are logged but never thrown —
  the wire emission already happened and breaking the in-flight
  turn over a store write would be worse than a missed row.
  Future emitters (tool-call notifications at M2, plan at M3)
  use this same helper so the "what we stored = what we
  emitted" invariant holds. `loadSession` deliberately bypasses
  `#emit` when replaying — replay must not re-persist existing
  rows.
- **`#rehydrateInlineFromStore(sessionId)`.** Private helper
  shared by `prompt`'s mismatch guard. Reads the session's
  entries in `seq` order; picks the latest `turn`'s
  `finalMessages` (if any) and calls
  `inline.restoreMessages`; otherwise `inline.clearMessages`.
  Always sets `#activeInlineSessionId = sessionId`. Returns
  `void`. When no store is configured it short-circuits to
  `clearMessages` — unit tests don't need the store to exist to
  call `prompt`.

#### Module-private functions

- `extractAssistantText(msg)` — handles both `string` and
  `ContentBlock[]`-shaped `content` fields on a
  `pi-agent-core` `AgentMessage`. Joins every `type: 'text'`
  block.
- `extractMessageId(msg)` — reads `msg.id` if it's a string;
  otherwise `undefined`. `pi-agent-core`'s message shape is
  evolving, so we defend against the field being missing.

## Tests

No module-level tests ship with the adapter yet. Coverage today:

- **Main-thread e2e.** `packages/web-acp/e2e/chat.spec.ts` drives
  `ChatDemo` through a real Bodhi OAuth + prompt cycle; if any
  method above breaks, the spec fails.
- **Type-check.** `AcpAgentAdapter implements Agent` catches
  any SDK-shape regression at build time.

M1 plan adds vitest coverage of at least:

- `authenticate` rejecting unknown method ids and missing
  `_meta`.
- `prompt` rejecting unknown sessions / unknown models.
- `#forwardEvent` delta computation (new message id resets
  cursor).

## Constraints

- The Bodhi constants must not be inlined elsewhere; grep
  `'bodhi-token'`, `'bodhi/listModels'`, `'bodhi/listSessions'`,
  and `'bodhi/getSession'` across `src/` to enforce.
- The `Agent` interface is the extraction boundary. If a future
  milestone wants a non-SDK hook (e.g., direct event emission
  into the worker-main channel), add it **outside** the
  `Agent`-shape methods; don't pollute the standard surface.
- `#conn.sessionUpdate(...)` is the only allowed path for agent
  → client notifications. Adding new notification types is a
  plan-level decision because each one is an ACP extension point.

## Change procedure

Any plan that edits files under `packages/web-acp/src/acp/` must
update this file in the same commit. When adding a new ACP
surface (new `Agent` method, new `Client` method, new extension
method or auth method):

1. Add the constant to `acp/index.ts` if it's a new id.
2. Add the method to `AcpClient` (main-thread) and/or
   `AcpAgentAdapter` (worker) as required.
3. Document the wire shape in this file.
4. Update [`./startup-sequence.md`](./startup-sequence.md) if the
   change affects boot / auth / prompt ordering.

See [`./index.md` § Change procedure](./index.md#change-procedure).
