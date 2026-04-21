# Plan: Fix web-agent model-switching bug by aligning with coding-agent

## Context

**Bug.** The Worker's per-session model is authoritative only within a
single turn: `useAgent.sendMessage` pushes the UI's `selectedModel` via
`rpcClient.setModel` right before every `prompt` call
(`packages/web-agent/src/hooks/useAgent.ts:220-243`), which masks the
real defect. On session **load / fork / navigate**, `WorkerAgentHost`
reads `ctx.model` from `sm.buildSessionContext()` but throws it away —
only `ctx.messages` is applied
(`packages/web-agent/src/web-agent/worker/worker-host.ts:269-322`).
Nothing persists a mid-session model switch either: the current
`WorkerAgentHost.setModel` (worker-host.ts:135) never calls
`sessionManager.appendModelChange()`, and `RpcSessionState` carries only
a `hasModel: boolean` — the UI can't recover the selected model after
reload or fork.

**Root cause.** The current web-agent protocol diverges from
coding-agent's proven shape in three places: (a) `set_model` takes a
full `Model<Api>` instead of `(provider, modelId)` identifiers; (b)
`RpcSessionState.hasModel: boolean` instead of `RpcSessionState.model:
Model<Api>`; (c) `setModel` is a plain delegate with no persistence.
Because of (a), the Worker has no model registry — it can't resolve a
persisted `model_change` entry back into a `Model<Api>` to call
`session.setModel(...)` on restore. All three drift together; any fix
has to close them together.

**Outcome.** Mirror coding-agent's protocol and server behavior. Don't
invent new protocol messages — adopt coding-agent's `set_model`
/ `get_available_models` / `RpcSessionState.model` shapes verbatim. The
Worker becomes the owner of a model registry (seeded by the main
thread's `fetchBodhiModels` results), persists `appendModelChange` on
every switch, and restores on load/fork/navigate — same flow as
`coding-agent/src/core/agent-session.ts:1394-1409` and
`packages/coding-agent/src/core/sdk.ts:190-206`. The main-thread UI
syncs by calling `getState()` after each `session_loaded` envelope
(coding-agent TUI pattern).

## Coding-agent shapes we adopt verbatim

From `packages/coding-agent/src/modes/rpc/rpc-types.ts` and
`rpc-client.ts`:

- **Command** `{ type: "set_model"; provider: string; modelId: string }` — line 31.
- **Response** `{ command: "set_model"; success: true; data: Model<any> }` — lines 122-128 (server returns the resolved model).
- **Command / response pair** `get_available_models` returning `{ models: Model<any>[] }` — lines 33, 136-142.
- **`RpcSessionState.model?: Model<any>`** — line 91 (not `hasModel: boolean`).
- **Server-side `setModel` effect**: `agent.state.model = model` **and** `sessionManager.appendModelChange(model.provider, model.id)` — `agent-session.ts:1401-1402`.
- **Restore path**: `buildSessionContext()` walks the branch, returns the latest `model_change` (or assistant-message metadata) so the Worker can re-apply it on load — `session-manager.ts:247-315` in web-agent already ports this 1:1.
- **Fork inherits branch model** — forked session's restored model is whatever the `model_change` chain along the copied path yielded.

## One necessary adaptation (not a new protocol invention)

Coding-agent's Worker (a node CLI) owns its `ModelRegistry` because
config files + CLI args populate it at boot. Web-agent's Worker can't
own a catalog unprompted — model list comes from the Bodhi server, and
only the main thread has the `bodhiClient`. We therefore push the
catalog into the Worker with `set_available_models` whose wire shape is
identical to `get_available_models`' response — same `Model<Api>[]`
payload, different direction. This is adaptation of *topology*, not new
protocol vocabulary.

## Scope

**In-scope**

- `packages/web-agent/src/web-agent/rpc/rpc-types.ts` — migrate `set_model`, `RpcSessionState`, add `set_available_models`, `get_available_models`.
- `packages/web-agent/src/web-agent/rpc/rpc-server.ts` — dispatch new commands.
- `packages/web-agent/src/web-agent/rpc/rpc-client.ts` — new method signatures.
- `packages/web-agent/src/web-agent/core/agent-session.ts` — `getState()` returns `model` (was `hasModel`).
- `packages/web-agent/src/web-agent/worker/worker-host.ts` — model registry, persistence on setModel, restore on load/fork/navigate.
- `packages/web-agent/src/hooks/useAgent.ts` — push catalog after `fetchBodhiModels`; switch `setModel` call sites to identifier form; sync selected-model UI from `getState()` on `session_loaded`.
- `packages/web-agent/e2e/tests/global-setup.ts` + `.env.test.example` — add Gemini provider.
- `packages/web-agent/e2e/model-switch.spec.ts` — **new** spec.
- Vitest cases for the Worker's model-registry / persist / restore paths.

**Out-of-scope**

- `packages/coding-agent/*` (CLAUDE.md core value #1).
- Thinking-level parallel fix — same shape of bug, **deferred** per user direction.
- `cycle_model` / model-picker UX changes.
- `ModelChangeEntry` / `appendModelChange` / `buildSessionContext` shape — already wired in M5/M8 forward-compat port.

## Implementation steps

### Protocol — adopt coding-agent shapes

1. **`rpc-types.ts::RpcCommand`**
   - Replace `{ type: 'set_model'; model: Model<Api> | undefined }` with
     `{ type: 'set_model'; provider: string; modelId: string }` (coding-agent line 31).
   - Add `{ type: 'get_available_models' }` (coding-agent line 33).
   - Add `{ type: 'set_available_models'; models: Model<Api>[] }` (topology adaptation — documented inline).
2. **`rpc-types.ts::RpcResponse`**
   - `set_model` response → `{ success: true; data: Model<Api> }` (coding-agent lines 122-128).
   - `get_available_models` response → `{ success: true; data: { models: Model<Api>[] } }` (coding-agent lines 136-142).
   - `set_available_models` response → `{ success: true }`.
3. **`rpc-types.ts::RpcSessionState`** — replace `hasModel: boolean` with `model?: Model<Api>` (coding-agent line 91).

### Worker — mirror coding-agent server behavior

4. **`worker-host.ts`** — add a model registry:
   ```
   private availableModels: Model<Api>[] = [];
   private findModel(provider, modelId): Model<Api> | undefined
   setAvailableModels(models: Model<Api>[]): void  // replace wholesale
   getAvailableModels(): Model<Api>[]
   ```
   Match coding-agent's registry semantics: lookup by `(provider, id)` equality.
5. **`worker-host.ts::setModel(provider, modelId)`** (signature change):
   - Resolve via `findModel`; throw `RpcError` if unknown (mirrors coding-agent line 1395-1397 "No API key for…" — our variant: "Model not registered").
   - Compare `(provider, modelId)` to the last `model_change` entry on the branch (read via `sessionManager.buildSessionContext().model`). Equal → skip append (dedupe — lets the post-`session_loaded` re-apply step 10 not double-log).
   - Otherwise, chain `sessionManager.appendModelChange(provider, modelId)` onto `this.writeChain` (serialises against the `message_end` appender).
   - Always call `this.session.setModel(resolvedModel)` so in-memory state follows.
   - Return `resolvedModel` as RPC response data (coding-agent shape).
6. **`worker-host.ts::loadSession` / `forkSession` / `navigateToLeaf`** — after
   `restoreMessages(ctx.messages)`, if `ctx.model` is non-null and the
   registry has it, call `this.session.setModel(resolved)` *without*
   re-appending (mark the append-path as skipped via the dedupe check in
   step 5). If the registry doesn't know that `(provider, modelId)`
   yet (catalog hasn't been pushed, or it's stale), leave the Worker
   model undefined — the main-thread's fallback in step 11 handles it.
   Call `this.session.setModel(undefined)` first so stale state from the
   previous session can't leak.
7. **`worker-host.ts::newSession`** — parent-inheritance already flows through
   `SessionManager.create`'s parent-walk and surfaces via
   `buildSessionContext().model`. Same restore logic as step 6 applies.
8. **`agent-session.ts::getState()`** — populate `model: this.currentModel`
   (mirrors coding-agent `_getSessionState`). Remove `hasModel`.

### Main thread — mirror coding-agent client usage

9. **`rpc-client.ts::setModel(provider, modelId)`** — new signature returning `Model<Api>` (coding-agent `rpc-client.ts:213-216`).
10. **`useAgent.ts`** — after `fetchBodhiModels` succeeds and all
    `BodhiModelInfo` entries have been resolved to `Model<Api>` via
    `buildModel(id, serverUrl, apiFormat)`, call
    `rpcClient.setAvailableModels(allResolvedModels)` *once*, and re-push
    whenever the catalog reloads. This is the "seed the registry"
    moment.
11. **`useAgent.ts::sendMessage`** — change
    `await rpcClient.setModel(model)` to
    `await rpcClient.setModel(model.provider, selectedModel)`. The
    Worker now owns resolution.
12. **`useAgent.ts::onSessionLoaded`** — coding-agent's TUI polls
    `get_state` after session swaps; mirror that here.
    - On every `session_loaded` envelope, call
      `rpcClient.getState()`; read `state.model` (`Model<Api> | undefined`).
    - When `state.model` is set: look up the matching `BodhiModelInfo`
      in `models` by `model.id`, call `setSelectedModelState(model.id)` +
      `setSelectedApiFormat(matched.apiFormat)`. Fall back to the
      first-available model on stale-id (per user decision).
    - When `state.model` is undefined: leave `selectedModel` as-is
      (first-available default from `loadModels` covers first-boot).
13. **`useAgent.ts::onSessionLoaded` race** — `session_loaded` may fire
    before `models` has loaded (boot). Stash the latest `state.model` in
    a `pendingRestoredModelRef`; drain it from the effect that runs
    after `loadModels` completes. Same fallback to first-available if
    the id is no longer in the catalog.

### Provider config (e2e bootstrap)

14. **`global-setup.ts`** —
    - Add `'GEMINI_API_KEY'` to `REQUIRED_ENV_VARS`.
    - Export `GEMINI_API_MODEL_PREFIX = 'google/'`,
      `GEMINI_API_MODEL_NAME = 'gemini-2.0-flash-lite'`,
      `SECOND_FULL_MODEL_ID = '${GEMINI_API_MODEL_PREFIX}${GEMINI_API_MODEL_NAME}'`.
    - After the existing OpenAI `configureApiModel` call (line 155-159),
      add `await apiModelsPage.configureApiModel(getEnv('GEMINI_API_KEY'), GEMINI_API_MODEL_PREFIX, GEMINI_API_MODEL_NAME)`.
15. **`.env.test.example`** — add `GEMINI_API_KEY=` stanza (if the file exists).

### E2E spec

16. **New** `packages/web-agent/e2e/model-switch.spec.ts`. Reuse
    `ChatPage`, `SessionsPanel` page objects. `test.step(...)` per concern.
17. **Flow** (single spec, multiple steps):
    - `loadModels()` + `selectModel(FULL_MODEL_ID)` (OpenAI).
    - `send("what day comes after monday?")`, wait turn 1, assert `/tuesday/i`.
    - `send("who trained you?")`, wait turn 2, assert `/openai/i`.
    - Capture turn-1 assistant `data-entry-id` as `forkParentEntryId`
      (pattern at `session-persistence.spec.ts:120`).
    - `sessions.forkFromEntry(forkParentEntryId)` — wait for active
      session id to change.
    - `chatPage.selectModel(SECOND_FULL_MODEL_ID)` on the fork.
    - `send("who trained you?")`, assert `/(google|gemini)/i`.
    - `page.reload()`; assert forked session id still active **and**
      model-selector still shows the Gemini id (proves persistence +
      restore via `getState()` sync).

### Unit tests (vitest)

18. Alongside existing `core/session/session-manager` and
    `worker/worker-host` suites, cover:
    - `setAvailableModels` + `setModel(provider, id)` round-trip → `getState().model` returns the resolved `Model<Api>`.
    - `setModel` persists a `model_change` entry exactly once per identity change (dedupe on no-op).
    - `setModel` throws when the provider/id isn't in the registry.
    - `loadSession` with a persisted `model_change` and a populated
      registry → in-memory Worker model matches; `getState().model` returns it.
    - `loadSession` when the registry is empty (race) → Worker model
      stays undefined; `getState().model` is undefined.
    - `forkSession` off an entry **before** any model change → Worker model is undefined; off an entry **after** → Worker model reflects most recent branch entry.
    - `navigateToLeaf` across branches → Worker model tracks per-branch.

## Verification

- `cd packages/web-agent && npm run check` — biome + `tsc -b` (authoritative — see CLAUDE.md dead-ends).
- `cd packages/web-agent && npm test` — new unit cases pass.
- `cd packages/web-agent && npm run test:e2e` — existing specs unchanged and green; new `model-switch.spec.ts` passes.
- Manual smoke: `npm run dev` — fork, switch model, reload, confirm combobox value + a fresh `send` hits the new provider.
- Gate check against `ai-docs/milestones/gate.md`.

## Risks & rollbacks

- **Breaking RPC shape.** `set_model`, `RpcSessionState`, plus new
  `set_available_models` / `get_available_models` commands. All call
  sites are in-repo — no external consumers yet (M11 hasn't shipped).
  Typechecker will enforce the migration; there's no wire-compat concern.
- **Catalog push-race** — `session_loaded` arriving before the catalog
  is seeded leaves the Worker model undefined. Mitigated by step 13's
  pending-ref drain + fall-back to first-available.
- **Stale `modelId` after API-config deletion.** User chose
  "fall back to first available" — implemented in step 12/13.
- **Gemini provider config.** If Bodhi's `ApiFormat` doesn't currently
  whitelist `gemini-2.0-flash-lite`, `ApiModelsPage.configureApiModel`
  fails fast with a clear error. Fallback = pick a different model.
- **Rollback.** Revert the protocol diff in one commit — `rpc-types.ts`,
  `rpc-server.ts`, `rpc-client.ts`, `worker-host.ts`, `agent-session.ts`,
  `useAgent.ts`. `model_change` entries already in Dexie remain
  forward-compatible (already handled by `buildSessionContext`).

## Critical files

- `packages/web-agent/src/web-agent/rpc/rpc-types.ts`
- `packages/web-agent/src/web-agent/rpc/rpc-server.ts`
- `packages/web-agent/src/web-agent/rpc/rpc-client.ts`
- `packages/web-agent/src/web-agent/worker/worker-host.ts`
- `packages/web-agent/src/web-agent/core/agent-session.ts`
- `packages/web-agent/src/hooks/useAgent.ts`
- `packages/web-agent/e2e/tests/global-setup.ts`
- `packages/web-agent/e2e/model-switch.spec.ts` *(new)*

## Reused existing utilities (no re-implementation)

- `SessionManager.appendModelChange(provider, modelId)` — `packages/web-agent/src/web-agent/core/session/session-manager.ts:~860` (already ported from coding-agent).
- `SessionManager.buildSessionContext()` — same file, 247-315 — already returns `model: { provider, modelId } | null`.
- `ModelChangeEntry` — `packages/web-agent/src/web-agent/core/session/types.ts:59-63`.
- `buildModel(modelId, serverUrl, apiFormat)` + `apiFormatToProvider(fmt)` — `packages/web-agent/src/lib/agent-model.ts`.
- `ChatPage.selectModel` / `send` / `lastAssistantText` — `packages/web-agent/e2e/tests/pages/ChatPage.ts`.
- `ApiModelsPage.configureApiModel` — `packages/web-agent/e2e/tests/pages/ApiModelsPage.ts`.
- Fork-entry capture pattern — `packages/web-agent/e2e/session-persistence.spec.ts:106-148`.

## Decisions confirmed with user

- Gemini model for e2e: `google/gemini-2.0-flash-lite`.
- Thinking-level parallel bug: **defer** to a follow-up change.
- `RpcSessionState.model`: **include now** (coding-agent shape).
- Stale `modelId` on restore: **fall back to first available**.
