# hook

**Source of truth:** `packages/web-acp/src/hooks/useAcp.ts`

**Parent:** [`./index.md`](./index.md)

## Functional scope

`useAcp` is the **single React hook** that `ChatDemo` consumes.
It owns the main-thread half of the ACP connection and exposes
the chat state that the UI binds to. No other hook should grow
to duplicate its responsibilities — when state needs to leak
into other components (settings, diagnostics at M7), lift it
into a context provider built on top of `useAcp`, don't re-enter
the runtime.

Responsibilities:

1. Spawn and own the singleton `Worker` + `AcpClient` runtime
   (via module-scope state; React double-mount safe).
2. Translate Bodhi auth state (`auth.accessToken`,
   `clientState`) into ACP calls
   (`authenticate`, `bodhi/listModels`).
3. Surface the model catalog as `BodhiModelInfo[]` to
   `ChatDemo`, including default selection management.
4. Drive the per-prompt turn: append user message, ensure
   session, stream-aware state updates, finalise assistant
   message on `end_turn`.
5. Provide `stop`, `clearMessages`, `clearError`, `loadModels`
   affordances.
6. Collapse state to empty when `isAuthenticated === false` so
   unauthenticated renders show a clean UI regardless of
   lingering internal state.

Non-responsibilities:

- OAuth flow — owned by `@bodhiapp/bodhi-js-react`'s
  `BodhiProvider` + `useBodhi`.
- Message persistence — M1.
- Session list / switch — M1.
- Error formatting beyond the shared `getErrorMessage(err,
  fallback)` helper in `src/lib/utils.ts`.
- Transcript compaction, skills, extensions, tool execution —
  later milestones.

## Technical reference

### Module-scope state (singletons)

Held outside the hook body so React's double-mount (StrictMode)
and fast-refresh never spawn a second worker:

- `_runtime: AcpRuntime | null` — `{worker, client,
  initialize}`. `initialize` is the promise returned by
  `client.initialize()`.
- `_authKey: string | null` — `${baseUrl}::${token}`. Used to
  dedupe `authenticate + bodhi/listModels`.
- `_authPromise: Promise<void> | null` — the in-flight or
  resolved promise chaining authenticate + listModels.
- `_authModels: BodhiModelDescriptor[]` — the last-known
  catalog.
- `_session: string | null` — the current ACP session id.
- `_sessionPromise: Promise<string> | null` — the in-flight
  `newSession` promise (protects against concurrent first-
  prompt races).

All are `let`-declared at module scope. Extracting into a
WeakMap or class singleton would be cleaner; kept flat for
phase-D simplicity, revisit at M1.

### `ensureRuntime(): AcpRuntime`

Idempotent singleton constructor. See the full flow in
[`./startup-sequence.md § Phase 1`](./startup-sequence.md#phase-1--worker-spawn-and-acp-handshake).
Key design notes:

- **Late-bound client handler.** The `Client` handler needs a
  reference to the `AcpClient` (so it can call
  `dispatchSessionUpdate`), but the `AcpClient` needs the
  `ClientSideConnection` which needs the handler. Resolved with
  a `const holder: {client?: AcpClient} = {}` closure — the
  handler reads through `holder.client?` at dispatch time, after
  assignment completes.
- **`requestPermission` throws.** M0 does not implement the
  permission flow; throwing makes a premature call by the agent
  (which would be a bug) loud. M2 (tools) replaces this with a
  real handler.
- **`initialize` is fire-and-hold.** `ensureRuntime` starts the
  initialize call but does not await it; the returned promise is
  stored so later calls can `await runtime.initialize` as
  needed. This lets the hook mount synchronously and issue auth
  calls as soon as Bodhi reports a token, rather than blocking
  on a round-trip that's running in parallel with OAuth anyway.

### Hook-local state (React)

- `messages: AgentMessage[]` — finalised transcript. Reset on
  `clearMessages()` and on sign-out rendering.
- `streamingMessage: AgentMessage | undefined` — the currently-
  accumulating assistant draft. Replaced on every
  `agent_message_chunk`; cleared on `end_turn` / error / cancel.
- `isStreaming: boolean` — mirrors `sendMessage`'s lifecycle.
- `error: string | null` — transient error message surfaced to
  `ChatDemo` via toast.
- `models: BodhiModelDescriptor[]` — the catalog summary.
  Mapped to `BodhiModelInfo[]` for display in
  `ModelCombobox`.
- `isLoadingModels: boolean` — covers both initial load and
  `loadModels()` refreshes.
- `selectedModel: string` — the chosen model id.
- `selectedApiFormat: ApiFormat` — the format tied to the
  selected model; threaded to the combobox.

### Refs

- `streamingRef: useRef<AgentMessage | undefined>` — the
  authoritative accumulator. `setStreamingMessage` follows it;
  using a ref prevents stale closures from dropping a delta
  when React batches multiple chunks in a frame.
- `streamingMessageIdRef: useRef<string | undefined>` — last
  seen `messageId`. When it changes, we reset the accumulator
  to an empty assistant message. Required because a single
  `session/prompt` can in theory emit multiple assistant
  messages (tool-call rounds at M2+; M0 always has exactly
  one).
- `loadingModelsRef: useRef(false)` — guards against concurrent
  `loadModels()` calls (e.g. the user clicks the refresh button
  twice in a row).

### Effects

1. **Mount guard.** `useEffect(() => { ensureRuntime(); }, [])`
   kicks the singleton on the first render. Depending only on
   `[]` is intentional — we don't want re-creation on Bodhi
   state changes.
2. **Session-update subscription.**
   `useEffect(() => { return runtime.client.onSessionUpdate(...)
   }, [])`. Handles `agent_message_chunk` → delta accumulation.
   Filters `update.sessionUpdate !== 'agent_message_chunk'` and
   `content.type !== 'text'` early.
3. **Auth / catalog.** `useEffect(() => {...}, [auth.accessToken,
   bodhiClient, isReady])`. See
   [`./startup-sequence.md § Phase 2`](./startup-sequence.md#phase-2--bodhi-authenticate--catalog-fetch).
   Important details:
   - The effect sets a `let cancelled = false` flag and its
     cleanup flips it; state updates check `cancelled` before
     firing so stale runs can't overwrite newer state.
   - All state updates live inside the immediately-invoked
     async `run()` function, not the outer effect body. ESLint's
     `react-hooks/set-state-in-effect` otherwise flags them.
   - The module-scope `_authKey` / `_authPromise` de-dupes
     across double-mounts and fast-refreshes.
4. **Sign-out cancel.** `useEffect(() => {...}, [isAuthenticated])`.
   When `isAuthenticated === false` and `_session` exists,
   fires `client.cancel(_session)` (best-effort) and clears
   `_session`.

### Callbacks

- **`loadModels()`.**
  - Re-entrant guard via `loadingModelsRef`.
  - Surfaces a human-readable error if `!isAuthenticated`.
  - Calls `runtime.client.listModels()` **without** re-
    authenticating, because the token the worker holds is still
    valid (if it weren't, the auth effect would have cleared
    `_authKey` and no valid session state would exist).
  - Updates `_authModels` + React state, preserving the current
    selection if the model still exists in the new list;
    otherwise defaults to the first entry.
- **`setSelectedModel(id, fmt)`.** Updates the two pieces of
  state atomically (from the UI's point of view).
- **`ensureSession()`.** Lazy `session/new`. Guarded by
  `_sessionPromise` so concurrent `sendMessage` calls (if the
  user double-tapped send before the first completed) share one
  session. Cleared in `finally` so a failed `newSession` doesn't
  poison future attempts.
- **`sendMessage(prompt)`.** Orchestration:
  1. `if (!selectedModel) setError(...); return`.
  2. Await any in-flight `_authPromise` (no-op if already
     resolved); silently abort on auth failure — the auth
     effect already surfaced the error.
  3. Optimistically append the user message; reset streaming
     state.
  4. `const sessionId = await ensureSession()`.
  5. `const response = await runtime.client.prompt(sessionId,
     prompt, selectedModel)`.
  6. On `stopReason !== 'cancelled'` and non-empty
     `streamingRef.current`, append the draft to `messages`.
  7. `finally`: reset `streamingRef`, `streamingMessageIdRef`,
     `streamingMessage`, `isStreaming`.
- **`stop()`.** No-op if `_session` is null. Otherwise fires
  `client.cancel(_session)` and does not await — cancellation
  is a notification in ACP and a best-effort operation on our
  side.
- **`clearMessages()`.** Cancels any in-flight turn, nulls
  `_session`, resets refs and React state. The next
  `sendMessage` lazily creates a fresh session.
- **`clearError()`.** `setError(null)`. Wired to the toast's
  `onDismiss` / `onAutoClose`.

### Return shape

```
{
  messages: AgentMessage[];
  streamingMessage: AgentMessage | undefined;
  isStreaming: boolean;
  selectedModel: string;
  selectedApiFormat: ApiFormat;
  setSelectedModel: (id: string, fmt: ApiFormat) => void;
  sendMessage: (prompt: string) => Promise<void>;
  stop: () => void;
  clearMessages: () => void;
  error: string | null;
  clearError: () => void;
  models: BodhiModelInfo[];
  isLoadingModels: boolean;
  loadModels: () => Promise<void>;
}
```

Every authenticated-state-guarded field collapses to
empty/undefined/null/`false` when `isAuthenticated === false`.
The collapse happens in the **return** expression, not in the
state itself, so a rapid sign-in/sign-out toggle doesn't race
the underlying state clear.

## Known M0 limitations

- **No persistence.** Page reload drops `_session` and the
  entire `messages` state. M1 fixes this.
- **Single session.** `_session` is a scalar; there's no UI or
  state for multiple concurrent chats. M1 introduces the
  session list / switcher.
- **Transcript drift on `clearMessages`.** See
  [`./startup-sequence.md § Phase 4`](./startup-sequence.md#phase-4--subsequent-prompts)
  — `clearMessages()` resets the main-thread view and cancels
  the current session; the next prompt gets a fresh
  `session/new`. The worker's `InlineAgent` transcript still
  lives in memory until the next `authenticate` (which calls
  `inline.clearMessages`); this is a wart we live with in M0.
- **No tool-call UI.** `sessionUpdate.update.sessionUpdate`
  values other than `agent_message_chunk` are silently ignored.
- **No progressive catalog update.** The auth effect fetches
  the full catalog on every token change; refreshing should be
  rare enough that this isn't a problem, but M1+ may introduce
  SWR-style caching.

## Tests

- `packages/web-acp/e2e/chat.spec.ts` exercises the happy path
  end-to-end (OAuth → list models → send prompt → render
  stream).
- No vitest coverage yet. M1's test plan adds:
  - `ensureRuntime` singleton idempotence under StrictMode.
  - Auth-effect dedupe by `authKey`.
  - Streaming accumulation on `messageId` change mid-turn.

## Constraints

1. **Do not re-create the worker on re-render.** The singleton
   guard is load-bearing; any refactor that threads the
   runtime through props or context must preserve the
   "one worker per tab" invariant.
2. **Do not leak ACP types to UI components.** `ChatDemo`
   should not see `AcpClient`, `ClientSideConnection`, or any
   SDK type. The hook's return shape is the UI contract.
3. **Do not reach into `_runtime.client.#conn`.** If a new
   feature needs a passthrough, add it to `AcpClient`
   (`src/acp/client.ts`) and expose it through the hook.
4. **Preserve the sign-out-collapses-state rule.** Both the
   auth effect and the sign-out effect must end up clearing
   the same invariants (session, auth key, models), and the
   return shape must mask any residual state on
   `isAuthenticated === false`.

## Change procedure

Any plan that edits `packages/web-acp/src/hooks/useAcp.ts` must
update this file in the same commit. When adding a new piece of
hook state that surfaces to the UI, also update
[`./startup-sequence.md`](./startup-sequence.md) if the new
state ties into boot / auth / prompt ordering.

See [`./index.md` § Change procedure](./index.md#change-procedure).
