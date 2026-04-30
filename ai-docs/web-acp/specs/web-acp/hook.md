# hook

**Source of truth:** `packages/web-acp/src/hooks/useAcp.ts` plus the
per-concern slice hooks under `src/hooks/useAcp*.ts` and the
host-side ACP plumbing under `src/acp/`.

**Parent:** [`./index.md`](./index.md)

## Functional scope

`useAcp()` is the **single React hook** that `ChatDemo` consumes.
It is now a **thin facade** (~180 LoC) that composes seven
per-concern slice hooks and applies the
`isAuthenticated ? real : EMPTY_*` gating to its return shape.
The actual ACP wire orchestration lives in pure modules under
`src/acp/` and the per-concern hooks under `src/hooks/`. Slice
hooks are internal — they are not exported from `useAcp.ts`. New
state that needs to surface to the UI lifts into the facade's
return shape, not into a sibling hook called separately by a
component.

Responsibilities (now split across files):

1. Spawn and own the singleton `Worker` + `AcpClient` runtime —
   `src/acp/runtime.ts` (module-scope state survives StrictMode
   double-mounts; M8 lifts it to context-bound).
2. Translate Bodhi auth state into ACP calls
   (`authenticate` + `bodhi/listModels`, plus token-rotation
   `session/load` rebuild) — `src/hooks/useAcpAuth.ts`.
3. Surface the model catalog and selection — `src/hooks/useAcpModels.ts`.
4. Drive the per-prompt turn (turn-start, stream accumulation
   over the typed `streamingReducer`, turn-end commit) —
   `src/hooks/useAcpStreaming.ts` + `src/acp/streaming-reducer.ts`.
5. ACP session lifecycle: `session/new`, `session/load`,
   `session/cancel` + state reset, `_bodhi/sessions/delete`,
   `bodhi/listSessions` mirror, auto-ensure-on-auth effect,
   auth-loss teardown — `src/hooks/useAcpSession.ts`.
6. MCP slice: per-session toggles, server composition for
   `session/new`/`session/load`, `_bodhi/mcp/toggles/set` mutation,
   `/mcp add` / `/mcp remove` built-in action dispatcher,
   requested-MCPs IDB hydration — `src/hooks/useAcpMcp.ts` +
   `src/acp/builtin-dispatch.ts` (pure dispatcher).
7. Feature bag: `_bodhi/features/list` + `_bodhi/features/set`,
   per-session reset on `clearMessages` — `src/hooks/useAcpFeatures.ts`.
8. Volumes registry mounting: `src/hooks/useAcpRuntime.ts` (which
   wraps `useVolumes` — see [`./vault.md`](./vault.md)).
9. Collapse state to empty when `isAuthenticated === false` so
   unauthenticated renders show a clean UI regardless of lingering
   internal state — handled in the facade's return expression.

Non-responsibilities (unchanged):

- OAuth flow — owned by `@bodhiapp/bodhi-js-react`'s
  `BodhiProvider` + `useBodhi`.
- Message persistence — delegated to the worker-owned `SessionStore`
  (see [`./sessions.md`](./sessions.md)).
- Error formatting beyond the shared `getErrorMessage(err, fallback)`
  helper in `src/lib/utils.ts`.
- Transcript compaction — M7.
- Extensions runtime — M5.

## File map

```
src/
  acp/
    runtime.ts            # AcpRuntime singleton + module-scope state + accessor surface
    streaming-reducer.ts  # Pure reducer for session/update + turn lifecycle (ToolCallView lives here)
    streaming-reducer.test.ts  # 12 unit tests pinning replay guard, builtin tag carry, tool-call merge, etc.
    builtin-dispatch.ts   # Pure dispatchBuiltinAction with injected LoginTrigger (copy / mcp-add / mcp-remove)
    permissions.ts        # session/request_permission stub (deferred, see milestones/deferred.md)
    message-shape.ts      # emptyAssistantMessage, getAssistantText, withAssistantText, userMessage,
                          # detectBuiltinTag, mapToolStatus, toolCallContentText, extractMcpMeta
    session-meta.ts       # authKeyOf, toBodhiModelInfo, composeSessionMeta
    client.ts             # AcpClient (unchanged)
    fs-handlers.ts        # fs/* IDE-integration seam (unchanged; see vault.md)
  hooks/
    useAcp.ts             # Thin facade composing the seven slice hooks; owns isAuthenticated gating
    useAcpRuntime.ts      # ensureRuntime + volumes mount
    useAcpAuth.ts         # Bodhi auth observation, model load, token-rotation session/load rebuild
    useAcpModels.ts       # models, selectedModel, ensureDefaultModel, applyLastModel, loadModels
    useAcpFeatures.ts     # features, featureDefaults, refreshFeatures, setFeature, clearFeatures
    useAcpMcp.ts          # mcpToggles, composeCurrentMcpServers, triggerLoginWithRequested,
                          # dispatchAction, setMcpToggle; exposes refs (instances, toggles,
                          # requestedMcpUrls) for sibling hooks
    useAcpSession.ts      # ensureSession, loadSession, clearMessages, deleteSession,
                          # refreshSessions, auto-ensureSession effect, auth-loss teardown
    useAcpStreaming.ts    # session/update listener, useReducer driver, sendMessage, stop, clearError
    useVolumes.ts         # volumes registry (unchanged; see vault.md)
```

## Technical reference

### Module-scope state (`src/acp/runtime.ts`)

Held outside any React component so StrictMode and fast-refresh
never spawn a second worker:

- `_runtime: AcpRuntime | null` — `{worker, client, volumeControl,
  mainZenfs, initialize, resolveInit}`.
- `_authKey: string | null` — `${baseUrl}::${token}`. Dedupes
  `authenticate + bodhi/listModels` across StrictMode double-mounts.
- `_authPromise: Promise<void> | null` — the in-flight or resolved
  promise chaining authenticate + listModels.
- `_authModels: BodhiModelDescriptor[]` — the last-known catalog.
- `_session: string | null` — the current ACP session id.
- `_sessionPromise: Promise<string> | null` — the in-flight
  `newSession` promise (protects against concurrent first-prompt
  races).

Accessor surface: `getSession()` / `setSession()`,
`getSessionPromise()` / `setSessionPromise()`, `getAuthKey()` /
`setAuthKey()`, `getAuthPromise()` / `setAuthPromise()`,
`getAuthModels()` / `setAuthModels()`. The slice hooks read/write
through these accessors rather than touching `let`s directly.

`ensureRuntime()` is the idempotent singleton constructor; see
[`./startup-sequence.md § Phase 1`](./startup-sequence.md#phase-1--worker-spawn-and-acp-handshake)
for the full flow. Notable design notes:

- **Late-bound client handler.** A `const holder: {client?: AcpClient} = {}`
  closure breaks the circular reference between the `Client`
  handler (which calls `holder.client?.dispatchSessionUpdate`) and
  the `AcpClient` (which needs the `ClientSideConnection`).
- **`requestPermissionStub` lives in `acp/permissions.ts`.** M0
  does not implement the permission flow; throwing makes a
  premature call by the agent (which would be a bug) loud. The
  bridge re-enters at a future milestone (see
  [`../../milestones/deferred.md`](../../milestones/deferred.md)).
- **`initialize` is fire-and-hold.** `ensureRuntime` starts the
  initialize call but does not await it; the returned promise is
  stored so later calls can `await runtime.initialize` as needed.

### Streaming reducer (`src/acp/streaming-reducer.ts`)

A pure typed reducer drives the prompt-turn state machine. State:

```ts
interface StreamingState {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | undefined;
  streamingMessageId: string | undefined;
  toolCalls: Map<string, ToolCallView>;
  turnIndex: number;
  isStreaming: boolean;
  isReplaying: boolean;
  availableCommands: readonly AvailableCommand[];
  mcpStates: Record<string, McpConnectionMeta>;
}
```

Actions:

- `'turn-start' { userMessage }` — append user message, clear
  streaming, set `isStreaming = true`.
- `'turn-end' { stopReason, finalMessage? }` — append `finalMessage`
  unless `stopReason === 'cancelled'`, clear streaming, bump
  `turnIndex`.
- `'load-start'` — clear streaming, set `isReplaying = true`.
- `'load-end' { messages? }` — replace `messages` and clear
  toolCalls/turnIndex on success; just clear `isReplaying` on error
  (when `messages` is omitted).
- `'session-update' { notif }` — route an ACP `session/update`
  notification: MCP-meta side channel, `available_commands_update`,
  `agent_message_chunk` accumulation (with `_meta.bodhi.builtin`
  tag carry), `tool_call`, `tool_call_update`. The replay guard
  suppresses live chunks but lets MCP and command updates through.
- `'reset'` — fresh slate; used by `clearMessages`,
  `deleteSession` on the active row, and the auth-loss teardown.

The replay guard is now state, not a ref. Stale-closure risk for
`messagesRef` / `mcpInstancesRef` / `mcpTogglesRef` is gone for the
streaming path because reducer transitions are synchronous with
each notification. Two refs survive in `useAcpStreaming.ts`
(`streamingMessageRef`, `messagesRef`) purely as closure-safe
read snapshots for `sendMessage`'s post-prompt continuation.

Unit tests: 12 cases in `streaming-reducer.test.ts` pin envelope
round-trip, replay guard, builtin tag carry, chunk accumulation,
tool-call merge, turn-end success / cancelled, load-end with /
without messages, reset.

### Slice hooks

Each slice hook owns a contiguous slice of React state plus the
callbacks that mutate it. The facade calls each hook in a fixed
order so the dependency graph (e.g. `useAcpSession` needs
`composeCurrentMcpServers` from `useAcpMcp`; `useAcpStreaming`
needs `ensureSession` from `useAcpSession`) resolves naturally.

| Hook | State | Callbacks |
| --- | --- | --- |
| `useAcpRuntime` | — | wraps `useVolumes`, returns `{ volumes }`. |
| `useAcpModels` | `models`, `isLoadingModels`, `selectedModel`, `selectedApiFormat`, `loadingModelsRef` | `setSelectedModel`, `loadModels`, `ensureDefaultModel`, `applyLastModel`. Also exposes setters (`setModels`, `setIsLoadingModels`) so `useAcpAuth` can populate models on token change. |
| `useAcpFeatures` | `features`, `featureDefaults` | `refreshFeatures`, `setFeature`, `clearFeatures`. |
| `useAcpMcp` | `mcpToggles` | `setMcpToggles`, `setMcpToggle`, `composeCurrentMcpServers`, `triggerLoginWithRequested`, `dispatchAction` (binds `dispatchBuiltinAction` to this hook's login closure). Owns refs: `mcpInstancesRef`, `mcpTogglesRef`, `requestedMcpUrlsRef` (IDB-hydrated). |
| `useAcpAuth` | `lastWorkerTokenRef` (rotation fingerprint) | (no return) — runs the auth effect that calls `authenticate` + `bodhi/listModels`, populates models via injected setters, and re-issues `session/load` on token rotation. |
| `useAcpSession` | `sessions`, `currentSessionId`, `isLoadingSession` | `refreshSessions` (+ auto-refresh effect on `isAuthenticated`), `ensureSession` (+ auto-ensure effect), `loadSession`, `clearMessages`, `deleteSession`, auth-loss teardown effect. |
| `useAcpStreaming` | (drives `streamingReducer` lifted in facade) | `sendMessage`, `stop`, `clearError`; subscribes `runtime.client.onSessionUpdate` and dispatches `'session-update'`. |

### Cross-hook coordination

The facade lifts `useReducer(streamingReducer, ...)` so both
`useAcpSession` and `useAcpStreaming` dispatch into the same
reducer instance:

1. **`loadSession` clears streaming state** — `useAcpSession`
   dispatches `'load-start'` on entry, `'load-end' { messages }`
   on success, `'load-end' {}` on error.
2. **`clearMessages` / `deleteSession`-active / auth-loss** —
   `useAcpSession` dispatches `'reset'`.
3. **`setMcpToggle` re-issues `session/load`** — `useAcpMcp`
   calls `runtime.client.loadSession` directly (NOT through
   `useAcpSession.loadSession`) because the response shape
   differs and we don't want a UI `isLoadingSession` flicker
   mid-toggle. The streaming reducer remains in the live (non-
   replay) state during this transparent reload; the worker's
   re-emitted notifications during `session/load` will append to
   the live stream. **Known issue**: this produces a phantom
   trailing assistant bubble after a server-level toggle when
   there was a streamed assistant in the current turn. Not a
   refactor regression — the pre-split code had the same gap.
4. **Token rotation re-issues `session/load`** — `useAcpAuth`
   calls `runtime.client.loadSession` directly. Same rationale
   as (3).

### Effects (split across hooks)

1. **Mount guard** (`useAcpRuntime`) — `useEffect(() => { ensureRuntime(); }, [])`
   kicks the singleton on the first render.
2. **Session-update subscription** (`useAcpStreaming`) —
   subscribes `runtime.client.onSessionUpdate` and dispatches
   `'session-update'`. Replay guard lives in reducer state.
3. **Auth / catalog** (`useAcpAuth`) — runs on
   `[auth.accessToken, bodhiClient, isReady]` plus stable setters.
   Sets `cancelled` flag so stale runs can't overwrite newer
   state. Module-scope `_authKey` / `_authPromise` dedupes across
   double-mounts.
4. **Sessions auto-refresh** (`useAcpSession`) — re-fires on
   `[refreshSessions]` (which itself depends on `isAuthenticated`).
5. **Auto-ensure session** (`useAcpSession`) — when authenticated +
   no current session + `mcpInstances.isReady`, awaits any
   in-flight `_authPromise` and calls `ensureSession()`.
6. **Auth-loss teardown** (`useAcpSession`) — on
   `isAuthenticated === false` with an active session, fires
   `client.cancel(_session)` and clears `_session` +
   `currentSessionId`.
7. **Requested-MCPs hydration** (`useAcpMcp`) — one-shot effect
   that loads the IDB-backed `web-acp:mcp-requested` list (DEV
   seed applied first when `window.__mcpRequestedSeed` is set).
8. **State mirror effects** (`useAcpMcp`, `useAcpStreaming`) —
   one-line `mcpInstancesRef.current = mcpInstances.instances` /
   `mcpTogglesRef.current = mcpToggles` /
   `streamingMessageRef.current = state.streamingMessage` /
   `messagesRef.current = state.messages` mirrors that keep
   closure-safe snapshots fresh.

### Return shape (unchanged)

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
  sessions: BodhiSessionSummary[];
  refreshSessions: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;
  deleteSession: (sessionId: string) => Promise<void>;
  currentSessionId: string | null;
  isLoadingSession: boolean;
  volumes: UseVolumesResult;
  features: BodhiFeatureBag;
  featureDefaults: BodhiFeatureBag;
  setFeature: (key: string, value: boolean) => Promise<void>;
  toolCalls: ToolCallView[];
  availableCommands: readonly AvailableCommand[];
  mcp: {
    instances: McpInstanceView[];
    states: Record<string, McpConnectionMeta>;
    toggles: McpToggleSnapshot;
    isLoading: boolean;
    error: string | null;
    refresh: () => Promise<void>;
    setToggle: (serverSlug: string, value: boolean, toolName?: string) => Promise<void>;
  };
}
```

`ToolCallView` is re-exported from `useAcp.ts` as a type-only
re-export (the declaration lives in `acp/streaming-reducer.ts`).
Every authenticated-state-guarded field collapses to
empty/undefined/null/`false` when `isAuthenticated === false`. The
collapse happens in the facade's **return** expression, not in
the state itself, so a rapid sign-in/sign-out toggle doesn't race
the underlying state clear.

## Known limitations

- **Phantom bubble after MCP toggle / token rotation.** The
  transparent `session/load` paths in `useAcpMcp.setMcpToggle`
  and `useAcpAuth` (rotation) bypass the streaming reducer's
  replay guard. The worker re-emits `agent_message_chunk`
  notifications during `session/load`, and they accumulate as a
  fresh streaming bubble. Pre-split behavior; not a refactor
  regression.
- **Single live session in `_session`.** `_session` is still a
  scalar; multi-session concurrency (streaming in one tab while
  inspecting another) is out of scope until a later milestone
  adds per-session state dictionaries.
- **No progressive catalog update.** The auth effect fetches the
  full catalog on every token change; M1+ may introduce
  SWR-style caching.

## Tests

- `packages/web-acp/e2e/chat.spec.ts` exercises the happy path
  end-to-end (OAuth → list models → send prompt → render stream).
- `packages/web-acp/src/acp/streaming-reducer.test.ts` — 12
  unit tests pinning the reducer's behavior under each action
  variant. The host-side prompt-turn state machine has explicit
  unit coverage for the first time.

## Constraints

1. **Do not re-create the worker on re-render.** The
   module-scope singleton in `acp/runtime.ts` is load-bearing;
   any refactor that threads the runtime through props or context
   must preserve the "one worker per tab" invariant.
2. **Do not leak ACP types to UI components.** `ChatDemo` should
   not see `AcpClient`, `ClientSideConnection`, or any SDK type.
   The hook's return shape is the UI contract.
3. **Do not reach into `_runtime.client.#conn`.** If a new feature
   needs a passthrough, add it to `AcpClient` (`src/acp/client.ts`)
   and expose it through the relevant slice hook.
4. **Preserve the sign-out-collapses-state rule.** Both the
   `useAcpAuth` effect and the `useAcpSession` auth-loss teardown
   must end up clearing the same invariants (session, auth key,
   models), and the facade's return shape must mask any residual
   state on `isAuthenticated === false`.
5. **Do not export slice hooks.** `useAcp()` is the single entry
   point. Library extraction at M8 may expose the slice hooks
   formally; today they are internal.
6. **Inward-only imports under `src/acp/`.** The new pure modules
   (`runtime.ts`, `streaming-reducer.ts`, `builtin-dispatch.ts`,
   `message-shape.ts`, `session-meta.ts`, `permissions.ts`) must
   not import from `src/hooks/`, `src/components/`, or `@/env`.

## Change procedure

Any plan that edits files under `packages/web-acp/src/hooks/useAcp*.ts`
or `packages/web-acp/src/acp/{runtime,streaming-reducer,builtin-dispatch,
message-shape,session-meta,permissions}.ts` must update this file
in the same commit. When adding a new piece of hook state that
surfaces to the UI, also update
[`./startup-sequence.md`](./startup-sequence.md) if the new state
ties into boot / auth / prompt ordering.

See [`./index.md` § Change procedure](./index.md#change-procedure).
