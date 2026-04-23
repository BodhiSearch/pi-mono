# acp

**Source of truth:** `packages/web-acp/src/acp/`

**Parent:** [`./index.md`](./index.md)

## Functional scope

The `src/acp/` subtree holds the ACP wire surface and the
Bodhi-specific extensions layered on top of the
`@agentclientprotocol/sdk@0.17.0` primitives. Three files:

- **`index.ts`** — SDK re-exports + the two Bodhi-specific
  constants (`BODHI_AUTH_METHOD_ID`, `BODHI_LIST_MODELS_METHOD`)
  + the `_meta` shapes that travel alongside ACP's standard
  payloads.
- **`client.ts`** — `AcpClient`, a thin wrapper over
  `ClientSideConnection` that `useAcp` consumes on the main
  thread.
- **`agent-adapter.ts`** — `AcpAgentAdapter`, the
  `Agent`-interface implementation that runs inside the Web
  Worker.

Scope invariants:

- **ACP is the only wire protocol.** The adapter's only deviation
  from stock ACP is the `bodhi-token` auth method (advertised via
  the standard `authMethods` response array) and the
  `bodhi/listModels` extension method (served via `Agent.extMethod`,
  a standard SDK escape hatch). Both ride on `_meta`.
- **The two Bodhi constants are defined once.** `acp/index.ts` is
  the single source; `client.ts` and `agent-adapter.ts` import
  from it. `useAcp` never inlines either string literal.
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
- `BodhiAuthenticateMeta = { token: string; baseUrl: string }` —
  the `_meta` shape on `authenticate`.
- `BodhiModelDescriptor = { id: string; apiFormat: string }` —
  the lossy summary surfaced to the main thread (the worker keeps
  the full `Model<Api>`; see [`./agent.md`](./agent.md)).
- `BodhiListModelsResponse extends Record<string, unknown>` with
  `models: BodhiModelDescriptor[]` — the return shape of
  `bodhi/listModels`.

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
  uses one `InlineAgent` for all sessions; M1 will per-session.
- `readonly #bodhi: BodhiProvider` — the token + catalog holder.
- `readonly #sessions = new Map<string, SessionState>()` — pure
  existence tracking today (`SessionState = {id}`). M1 hangs
  transcripts off this map.
- `#models: Model<Api>[] = []` — catalog cache populated by
  `extMethod('bodhi/listModels')` and consumed by `prompt` to
  resolve `_meta.bodhi.modelId`.
- `#cancelled = false` — per-turn flag set by `cancel`, read by
  `prompt`.

#### Methods

- **`initialize(_params: InitializeRequest): Promise<InitializeResponse>`.**
  Returns the static response shown in
  [`./startup-sequence.md`](./startup-sequence.md#initialize-payload-exchange):
  `protocolVersion: 1`,
  `agentCapabilities: { loadSession: false, promptCapabilities:
  { image: false, audio: false, embeddedContext: false } }`,
  `authMethods: [{id: BODHI_AUTH_METHOD_ID, name, description}]`.
  No MCP capabilities advertised (see
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
  Returns `{sessionId: 'bodhi-' + crypto.randomUUID()}`;
  registers it in `#sessions`. The `NewSessionRequest`
  (`{cwd, mcpServers}`) is ignored in M0 — both are stubs.

- **`prompt(params: PromptRequest): Promise<PromptResponse>`.**
  Detailed flow in
  [`./startup-sequence.md § Phase 3`](./startup-sequence.md#phase-3--first-prompt).
  Summary:
  1. Session lookup (throws on miss).
  2. Model resolution via `_meta.bodhi.modelId` against
     `#models` (throws on miss).
  3. Text extraction (concatenates every `type: 'text'` block in
     `params.prompt`; throws if empty).
  4. `this.#inline.setModel(model)`.
  5. Subscribes to `inline` events; routes `message_update`
     events through `#forwardEvent`.
  6. `await this.#inline.prompt(text)`.
  7. Returns `{stopReason: 'cancelled'}` if `#cancelled`;
     throws `inline.getErrorMessage()` if set; otherwise returns
     `{stopReason: 'end_turn'}`.
  8. Unsubscribes in `finally`.

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
  Otherwise throws `"Unknown extension method: <name>"` so the
  SDK serialises a JSON-RPC error back. Full catalog flattening
  lives in [`./agent.md`](./agent.md); `apiFormatOfModel` is the
  inverse of `apiFormatToPiApi` used during flattening.

#### Private helpers

- **`#resolveModel(params)`.** Reads `params._meta.bodhi.modelId`;
  returns the matching entry in `#models` or `undefined`. Kept
  private because `_meta` is not a stable API surface — when the
  main thread stops routing modelId through `_meta` (likely at
  M1 when session metadata can carry it), this helper changes.
- **`#extractPromptText(params)`.** Concatenates every `text`
  block; ignores other block types (images, embedded context).
  In line with the M0 `promptCapabilities` (all false).
- **`#forwardEvent(sessionId, event, cursor)`.** The only method
  that writes to the wire from inside the adapter.
  1. Early-returns for non-`message_update` events.
  2. Early-returns if the message role isn't `'assistant'`.
  3. Recomputes the message id (`extractMessageId`) and resets
     `cursor.emittedLength = 0` on a new id.
  4. Computes `delta = text.slice(cursor.emittedLength)`;
     early-returns if empty (idempotent updates of the same
     prefix).
  5. Updates `cursor.emittedLength = text.length`.
  6. Sends:
     ```
     {
       sessionId,
       update: {
         sessionUpdate: 'agent_message_chunk',
         content: { type: 'text', text: delta },
         ...(messageId ? { messageId } : {})
       }
     }
     ```

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

- The two Bodhi constants must not be inlined elsewhere; grep
  `'bodhi-token'` and `'bodhi/listModels'` across `src/` to
  enforce.
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
