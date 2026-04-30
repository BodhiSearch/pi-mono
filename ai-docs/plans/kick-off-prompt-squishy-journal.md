# Plan — host-side wire/engine split for `useAcp.ts`

## Context

`packages/web-acp/src/hooks/useAcp.ts` is 1,133 LoC in one React hook,
~22% of the package by line count. The agent side just shipped its
analogous wire/engine split (commit `c68a284f` — `acp/agent-adapter.ts`
shrank 1,254 → ~245 LoC by lifting state into
`acp/engine/{services, session-runtime, prompt-driver, builtin-dispatch,
ext-methods/}`). The host side is the asymmetric half: same god-object
shape, no split.

This refactor applies the same discipline on the host while honouring
the user's stated priority: **organise host-side files around ACP
wire concerns**, so the structure is self-documenting against
`agent-client-protocol/schema/schema.json`. Concretely it (a) extracts
non-React ACP plumbing into pure modules under `src/acp/`, (b) splits
the React hook into per-concern sub-hooks under `src/hooks/`, and
(c) keeps `useAcp()` as a thin facade so the single consumer
(`ChatDemo.tsx:36`) sees a one-line update at most.

Goal alignment:

- **CLAUDE.md** — wire surface byte-identical, no new bespoke RPC,
  agent subtree (`packages/web-agent/`, `packages/coding-agent/`)
  remains uncited. Transport boundary unchanged.
- **04-principles.md §2 (ACP is the wire)** — module names match
  ACP method namespaces (`session/*`, `fs/*`, `_bodhi/*`,
  `available_commands_update`).
- **04-principles.md §5 (inward-only imports)** — the new
  non-React engine modules under `src/acp/` import nothing from
  `src/hooks/`, `src/components/`, or `@/env`. They take auth
  context as arguments, not via side-imports. Unblocks M8
  extraction.
- **04-principles.md §11 (ask before scope creep)** — three
  load-bearing decisions confirmed up-front via AskUserQuestion:
  multi-hook split, defer `useBodhi()` decoupling, pure reducer.

## Final file structure

```
packages/web-acp/src/
  acp/
    runtime.ts                # NEW — module-scope AcpRuntime singleton + ensureRuntime + wrapVolumeControl
    streaming-reducer.ts      # NEW — pure reducer for session/update notifications
    builtin-dispatch.ts       # NEW — dispatchBuiltinAction (copy / mcp-add / mcp-remove)
    message-shape.ts          # NEW — pure helpers: empty/get/withAssistantText, userMessage, detectBuiltinTag, mapToolStatus, toolCallContentText, extractMcpMeta
    session-meta.ts           # NEW — composeSessionMeta, authKeyOf, toBodhiModelInfo
    permissions.ts            # NEW — single-export stub for session/request_permission (deferred per milestones/deferred.md)
    client.ts                 # KEPT as-is
    fs-handlers.ts            # KEPT as-is
    methods.ts                # KEPT as-is
    wire-utils.ts             # KEPT as-is (agent-side use)
    index.ts                  # KEPT as-is
    agent-adapter.ts          # KEPT as-is (worker side, untouched)
    engine/                   # KEPT as-is (worker side, untouched)
  hooks/
    useAcp.ts                 # SHRUNK — facade composing the sub-hooks, owns auth-gating in return shape (~150 LoC)
    useAcpRuntime.ts          # NEW — ensureRuntime + volumes + handleInitialVolumes (~50 LoC)
    useAcpAuth.ts             # NEW — Bodhi auth observation, models load, token-rotation re-issue (~150 LoC)
    useAcpSession.ts          # NEW — ensureSession, loadSession, deleteSession, clearMessages, sessions list, auto-ensure effect, auth-loss teardown (~280 LoC)
    useAcpStreaming.ts        # NEW — useReducer over streaming-reducer, sendMessage, stop, available_commands_update routing, MCP-state routing (~230 LoC)
    useAcpModels.ts           # NEW — selectedModel/format state + setSelectedModel + loadModels (~90 LoC)
    useAcpFeatures.ts         # NEW — features bag + refreshFeatures + setFeature (~50 LoC)
    useAcpMcp.ts              # NEW — mcp.* slice: composeCurrentMcpServers, triggerLoginWithRequested, setMcpToggle, requestedMcpUrls hydration (~210 LoC)
    useVolumes.ts             # KEPT as-is
```

Total reconstructed surface ~1,310 LoC across 14 files (vs 1,133 in
1 file today). The ~15% line-count overhead is the cost of explicit
module boundaries — the same cost the agent-side split paid.

`ToolCallView` re-export at the bottom of `useAcp.ts` (line 1133)
stays — `ChatMessages.tsx:5` and `BashToolCall.tsx:1` keep importing
`type { ToolCallView } from '@/hooks/useAcp'`. Move the type
*declaration* into `acp/streaming-reducer.ts` (where the reducer
state owns it) and re-export from `useAcp.ts`. No churn at the
type-only consumer call sites.

## Module ownership table

Mapped from `useAcp.ts` line ranges to target files. Source: my
own read of the file plus the explorer reports.

| Source lines | What | Target file |
| --- | --- | --- |
| 1–47 | imports | redistributed |
| 49–60 | EMPTY\_\* frozen constants | move with each owning hook (e.g. `EMPTY_MCP_TOGGLES` → `useAcpMcp.ts`) |
| 62–71 | `ToolCallView` type | `acp/streaming-reducer.ts` (re-exported from `useAcp.ts`) |
| 73–80 | `AcpRuntime` interface | `acp/runtime.ts` |
| 82–146 | module-scope `_runtime/_authKey/_authPromise/_authModels/_session/_sessionPromise` + `ensureRuntime` | `acp/runtime.ts` (see "Module-scope state" below) |
| 148–177 | `wrapVolumeControl` | `acp/runtime.ts` |
| 179–261 (per explorer) | pure helpers | `acp/message-shape.ts`, `acp/session-meta.ts`, `acp/builtin-dispatch.ts` (`dispatchCopyAction`) |
| 340–435 | hook setup, state declarations, runtime memo, volumes | `useAcp.ts` (facade) + `useAcpRuntime.ts` |
| 437–516 | streaming-update notification effect | `acp/streaming-reducer.ts` (pure) + `useAcpStreaming.ts` (subscribes) |
| 518–601 | auth effect with token rotation | `useAcpAuth.ts` |
| 603–633 | `loadModels` | `useAcpModels.ts` |
| 635–638 | `setSelectedModel` | `useAcpModels.ts` |
| 640–668 | `refreshSessions` + auto-refresh effect | `useAcpSession.ts` |
| 670–696 | `refreshFeatures`, `setFeature` | `useAcpFeatures.ts` |
| 698–711 | `composeCurrentMcpServers` | `useAcpMcp.ts` |
| 713–748 | `triggerLoginWithRequested` | `useAcpMcp.ts` |
| 750–795 | `dispatchBuiltinAction` | `acp/builtin-dispatch.ts` (pure dispatch core) + `useAcpMcp.ts` (wires login) |
| 797–831 | `setMcpToggle` (re-issues `session/load`) | `useAcpMcp.ts` |
| 833–891 | `ensureSession` + auto-ensure effect | `useAcpSession.ts` |
| 893–950 | `loadSession` | `useAcpSession.ts` |
| 952–1013 | `sendMessage` | `useAcpStreaming.ts` |
| 1015–1019 | `stop` | `useAcpStreaming.ts` |
| 1021–1040 | `clearMessages` | `useAcpSession.ts` |
| 1042–1067 | `deleteSession` | `useAcpSession.ts` |
| 1069–1071 | `clearError` | `useAcpStreaming.ts` (errors live with the prompt turn) |
| 1073–1090 | auth-loss teardown effect | `useAcpSession.ts` |
| 1092–1131 | return shape composition | `useAcp.ts` (facade) |

### Module-scope state — keep where it is

`_runtime`, `_authKey`, `_authPromise`, `_authModels`, `_session`,
`_sessionPromise` (lines 82–89) stay at module scope inside
`acp/runtime.ts`, exported via a small accessor surface
(`getSession() / setSession() / clearSession() / getAuthPromise() / …`).
Reasons:

1. They survive React StrictMode double-mounts. That property is
   load-bearing; rebuilding it via context introduces remount races
   for no benefit.
2. Today the codebase is single-instance (one `<WebAcpProvider>` per
   tab). A library lift at M8 will replace module scope with a
   context-bound runtime; not the job here.

This is documented at the top of `acp/runtime.ts` with a `// M8:`
comment marking the future migration boundary.

## Streaming reducer shape

```ts
// acp/streaming-reducer.ts
export interface ToolCallView { /* moved verbatim from useAcp.ts */ }

export interface StreamingState {
  messages: AgentMessage[];
  streamingMessage: AgentMessage | undefined;
  streamingMessageId: string | undefined;
  toolCalls: Map<string, ToolCallView>;
  turnIndex: number;
  isStreaming: boolean;
  isReplaying: boolean;
  availableCommands: readonly AvailableCommand[];
  mcpStates: Record<string, McpConnectionMeta>;
  error: string | null;
}

export type StreamingAction =
  | { type: 'turn-start'; userMessage: AgentMessage }
  | { type: 'turn-end'; finalMessage?: AgentMessage; stopReason: string }
  | { type: 'load-start' }
  | { type: 'load-end'; messages: AgentMessage[] }
  | { type: 'session-update'; notif: SessionNotification }
  | { type: 'reset' }                 // clearMessages / deleteSession-active / auth-loss
  | { type: 'set-error'; error: string | null };

export const initialStreamingState: StreamingState = { /* ... */ };
export function streamingReducer(s: StreamingState, a: StreamingAction): StreamingState;
```

The `'session-update'` case routes the three sub-cases
(`agent_message_chunk`, `tool_call`, `tool_call_update`,
`available_commands_update`, MCP-meta side channel) the same way
the current effect does — pure transformation, no refs. Replay-guard
is now state, not a ref. Stale-closure risk for `messagesRef` /
`mcpInstancesRef` / `mcpTogglesRef` does not transfer to the
reducer because the reducer is invoked synchronously with the
notification.

`useAcpStreaming.ts` uses `useReducer(streamingReducer,
initialStreamingState)` and dispatches into it from:

1. `runtime.client.onSessionUpdate` listener → `'session-update'`
2. `sendMessage` entry → `'turn-start'`, exit → `'turn-end'`
3. `useAcpSession.ts` calls (cross-hook coordination): `'load-start'`,
   `'load-end'`, `'reset'`. Implemented by passing the dispatcher
   down through a small `StreamingDispatch` context (or by lifting
   the reducer into `useAcp.ts` facade and threading through props
   — chosen at step 6 below based on which is mechanically simpler
   given hooks-rules constraints).

## Public surface — single facade, single hook

`useAcp()` keeps the same return shape (29 fields, including the
nested `mcp` slice and `volumes` / `features` / `featureDefaults`).
The `isAuthenticated ? real : EMPTY_*` gating moves to the facade
(it composes the slices and applies the gate in one place; the
sub-hooks never lie about their state). `ChatDemo.tsx:36` is
unchanged.

Slice hooks are not exported from `useAcp.ts`. Library extraction
at M8 may expose them; today they're internal so consumers can't
accidentally couple to a sub-hook before the API stabilises.

## Step ordering (single sweeping commit, 8 logical steps)

Mirrors the agent-side cadence (`c68a284f`). Each step leaves
`npm run check` + `npm test -- --run` green; commit only after
all 8 succeed.

1. **Pure helpers move** — extract `acp/message-shape.ts`,
   `acp/session-meta.ts`. Update `useAcp.ts` imports. ~150 LoC moved,
   no logic change.
2. **Runtime singleton extract** — extract `acp/runtime.ts` with
   module-scope state + `ensureRuntime` + `wrapVolumeControl` +
   accessor functions. `useAcp.ts` imports `ensureRuntime` and
   the session-state accessors. ~110 LoC moved.
3. **Permissions stub + builtin dispatch core** — `acp/permissions.ts`
   (single-export stub, references `milestones/deferred.md`),
   `acp/builtin-dispatch.ts` (pure `dispatchCopyAction` +
   `dispatchBuiltinActionCore` taking a `LoginTrigger` callback
   so the IDB list mutation is testable without `useBodhi`).
4. **Streaming reducer extract** — `acp/streaming-reducer.ts`
   moves `ToolCallView`, defines `StreamingState`/`StreamingAction`,
   ports the dispatcher logic from lines 437–516 into a pure
   function. `useAcp.ts` continues using refs as today (will be
   converted in step 6); the reducer module exists but is unused
   yet. Add a unit test for the reducer (envelope round-trips,
   replay guard, builtin-tag carry, tool-call merge). This is the
   one place we add a unit test — the rest ride on existing
   coverage.
5. **`useAcpRuntime`, `useAcpFeatures`, `useAcpModels`** — extract
   the three smallest hooks. `useAcp.ts` imports them and threads
   their return values into the facade return. ~90+50+90 = ~230
   LoC moved. Smallest blast radius first.
6. **`useAcpStreaming`** — switch from imperative refs to
   `useReducer(streamingReducer, …)`. `useAcp.ts` lifts the
   reducer (or a `StreamingDispatch` context — pick whichever
   makes step 7 easier) so other hooks can issue `'load-start'`
   / `'reset'`. Move `sendMessage`, `stop`, `clearError`. ~230
   LoC moved.
7. **`useAcpSession`** — extract `ensureSession`, `loadSession`,
   `clearMessages`, `deleteSession`, `refreshSessions`,
   `auto-ensureSession` effect, `auth-loss teardown` effect.
   Receives `streamingDispatch`, `composeCurrentMcpServers`, and
   `refreshFeatures` from facade. ~280 LoC moved. Largest single
   step.
8. **`useAcpAuth` + `useAcpMcp` + facade slim-down** — extract
   the auth effect (with token-rotation policy), the MCP slice,
   thread the remaining wiring. `useAcp.ts` ends ~150 LoC: state
   for `isAuthenticated`-gating + the return assembly. Update
   `ai-docs/web-acp/specs/web-acp/` index to reference the new
   layout and add a one-line entry to
   `ai-docs/web-acp/milestones/index.md` under "scope adjustments
   vs. original plan" matching the agent-side note.

After every step run from `packages/web-acp/`:

```bash
npm run check        # lint + typecheck (tsc -b authoritative)
npm test -- --run    # vitest, ~259 tests today
```

If a step regresses behaviour, the wire surface is byte-identical
by design — investigate the React state-flow before continuing.
Do not move to the next step on red.

## Cross-hook coordination

Three cross-hook flows need handling (today they live in one hook
so coordination is implicit):

1. **`loadSession` clears streaming state** — today via
   `streamingRef.current = undefined` + `setStreamingMessage(undefined)`
   + `isReplayingRef.current = true`. After the split: facade owns
   the streaming reducer; passes `dispatch` down to `useAcpSession`
   which dispatches `'load-start'` / `'load-end'`.
2. **`setMcpToggle` re-issues `session/load`** — `useAcpMcp` calls
   `runtime.client.loadSession(_session, …)` directly using
   accessors from `acp/runtime.ts`. The `session/load` here does
   not go through `useAcpSession.loadSession` because (a) the
   server response shape differs and (b) we don't want a UI
   `isLoadingSession` flicker mid-toggle. Documented inline.
3. **Token rotation re-issues `session/load`** — same shape as
   (2). Lives in `useAcpAuth`. Same direct-runtime-call rationale.

(2) and (3) reveal that `runtime.client.loadSession` is invoked from
three places: `useAcpSession.loadSession` (user-initiated, full
replay), `useAcpAuth` (rotation, transparent), `useAcpMcp` (toggle,
transparent). The current code already does this; the split makes
it visible. **Not in scope to consolidate** — that's a real
behavioural change, not a refactor.

## Out of scope (explicit)

- **`useBodhi()` decoupling.** Confirmed deferred to M8. The new
  `useAcpAuth.ts` keeps the direct `useBodhi()` import. M8 will
  introduce a `BodhiAuthSource` interface; today's structure
  doesn't preclude it.
- **Feature additions.** No new fields in the return shape, no new
  ACP methods, no new `_bodhi/*` extensions. Bug discoveries get
  filed, not fixed inline.
- **Race-condition fixes.** The explorer flagged 5–8 smells
  (`_sessionPromise` finally-clear race, `loadSession` doesn't
  abort in-flight `sendMessage`, etc.). All preserved verbatim.
  Reducer extraction *does* incidentally remove three
  freshness-by-ref patterns (`messagesRef`, `mcpInstancesRef`,
  `mcpTogglesRef`) but only because those refs become reducer
  state, not because we change the underlying ordering.
- **`useVolumes.ts`** — already isolated, untouched.
- **`acp/fs-handlers.ts`** — already isolated, untouched.
- **Worker side (`acp/agent-adapter.ts`, `acp/engine/`)** — not
  touched. This refactor is host-only.

## Anti-recommendations (don't do these)

- **Don't introduce a non-React engine class hierarchy** that emits
  events the hook subscribes to via `useSyncExternalStore`. That
  was option B in the upfront question; user chose multi-hook
  split. Going down that road would convert React idioms (refs,
  effects) into event-emitter classes and is a larger,
  higher-regression-risk refactor — out of scope.
- **Don't decouple `useBodhi()` now.** Confirmed deferral to M8.
  Premature abstraction without a second consumer.
- **Don't rewrite the streaming reducer's wire-handling semantics.**
  The reducer must reproduce today's `agent_message_chunk` / `tool_call` /
  `tool_call_update` / `available_commands_update` / MCP-meta
  routing exactly. Add a unit test that pins each path; refactor
  underneath the test.
- **Don't expose sub-hooks from `useAcp.ts`.** They're internal.
  Library users at M8 see one `useAcp()`. Sub-hook exposure is a
  separate decision.
- **Don't split per-method.** `useAcpAuth` + `useAcpMcp` look big
  but are cohesive units. Splitting `useAcpMcp` into "compose" /
  "trigger-login" / "set-toggle" hurts readability without giving
  any hook a smaller dependency surface.
- **Don't mirror the agent-side `engine/` directory wholesale.**
  Agent has `services / session-runtime / prompt-driver /
  builtin-dispatch / ext-methods/`; host has different cuts
  (auth, models, sessions, streaming, features, MCP) because
  React state shape doesn't match the agent's runtime-state shape.
  ACP wire concerns inform the *names*, not the structure
  one-to-one.

## Future-proofing

- **M5 extensions** — extension registration surfaces will plug
  into `useAcpStreaming.ts` (slash command list) and a future
  `useAcpExtensions.ts` (extension UI side channel). The split
  gives them a clean home.
- **M6 session fork** — `session/fork` request lives in
  `acp/client.ts`; the host wrapper goes into `useAcpSession.ts`
  alongside `loadSession`. `streamingDispatch('reset')` covers
  the UI clear.
- **M7 compaction** — `before_compact` / `after_compact` events
  ride `session/update`; `acp/streaming-reducer.ts` gains action
  variants. No new hook needed.
- **M8 library extraction** — the new `acp/` modules are
  React-free; the new `hooks/` modules accept dependencies via
  parameters where possible. The extracted package = `acp/` +
  `hooks/` + `transport/` + `mcp/` + `vault/` + a re-export
  barrel. Module-scope state in `acp/runtime.ts` becomes
  context-scoped; the rename is mechanical.

## Critical files to (re-)read during execution

- `packages/web-acp/src/hooks/useAcp.ts` (the centerpiece, 1133 LoC).
- `packages/web-acp/src/components/chat/ChatDemo.tsx` — lines 30–55
  carry the destructuring, prop-forwarding, and toast effect.
  Verify after step 8.
- `packages/web-acp/src/acp/client.ts` (220 LoC) — only depended on,
  not modified.
- `packages/web-acp/src/acp/index.ts` — DTO types referenced by
  the new modules (`AnyBodhiBuiltinAction`, `BodhiSessionMeta`,
  `BodhiModelDescriptor`, etc.).
- `packages/web-acp/src/acp/engine/` — read for reference, do not
  duplicate. Especially the `ext-methods/` per-file pattern, which
  is what the host-side hook split mirrors at the *naming* level.

## Verification

End-to-end test plan after step 8 commits cleanly:

1. **Static** — `cd packages/web-acp && npm run check && npm test
   -- --run`. Both green.
2. **Repo gate** — `npm run check` from repo root (biome + tsgo +
   browser-smoke + web-ui + web-agent + web-acp). Pre-commit hook
   runs this; do not bypass.
3. **Smoke (claude-in-chrome MCP)** with the user's dev server
   on `localhost:5173` and Bodhi on `localhost:1135`:
   - Built-ins: `/help`, `/version`, `/session`, `/copy`, `/mcp`
     all reply with the expected built-in bubble.
   - Real LLM round-trip: send a benign prompt, see streaming
     `agent_message_chunk` chunks render, see assistant message
     persist on completion.
   - Tab reload + session resume: pick a previous session in
     `SessionPicker`, observe `loadSession` replays messages and
     `lastModelId` is restored.
   - MCP server toggle: flip a server off/on in `McpPanel`,
     observe `_meta.bodhi.mcp` lifecycle events update the panel.
   - DevTools console: clean (no errors, no React warnings about
     stale closures or missing deps).
4. **Spot-check** of unchanged behaviours: token rotation
   re-issues `session/load`; auth-loss clears the session;
   `clearMessages` cancels in-flight prompt.

## Commit

Single commit, message style follows `c68a284f`:

```
web-acp: split useAcp into wire/engine layer + per-concern hooks

(short summary of structure + line-count delta + ChatDemo unchanged)
```

If anything regresses behaviour during smoke, the regression is
in the host-side state-machine extraction (steps 6–8). Investigate
before pushing. Do not amend prior commits to fix — create a new
fix-up commit on the same branch.
