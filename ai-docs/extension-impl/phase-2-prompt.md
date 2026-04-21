# M8 — Extensions — Phase 2 handoff prompt

Use this as the starting prompt for the Phase 2 implementation plan.

---

## Context

Phase 1 landed a browser-native extension runtime in `packages/web-agent`: extensions discovered from `<vault>/.pi/extensions/<name>/index.js` are loaded inside the agent Worker via Blob-URL dynamic `import()` and expose `before_agent_start` + `tool_result` hooks plus `registerTool` + `registerCommand`. The main thread owns an `ExtensionsPanel` with per-extension toggles, a global disable-all trip switch, and renders both load-time and runtime errors.

Read before planning:

- [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md) — Phase 1 reference.
- [`./phase-1-report.md`](./phase-1-report.md) — what shipped, known gaps, open questions.
- [`../specs/worker-agent/index.md`](../specs/worker-agent/index.md) — worker-agent scope, constraints, change procedure.
- [`../specs/coding-vs-web-agent/feature-gaps.md`](../specs/coding-vs-web-agent/feature-gaps.md) — alignment with coding-agent's extension runtime.
- `packages/coding-agent/src/core/extensions/` — the reference implementation to port from (UI channel, context hooks, provider registration).

## Goal

Close the gap between Phase 1 and coding-agent's full extension surface, **without** introducing iframe / Worker-per-extension isolation (that's Phase 3). The deliverable is a browser-native analogue of every coding-agent extension-API method that makes sense in a Worker + React world.

## Scope (proposed)

### Context hooks

- `on('context', handler)` — fires before the LLM call with `{ messages, tools }`. Handler can return updated arrays to modify the turn. Integration point is `AgentSession.setBeforeLlmCall()` (needs adding; `pi-agent-core` already has the underlying hook).
- `on('tool_call', handler)` — fires before a tool executes. Handler can mutate `input`, deny the call with `{ isError: true, content: [...] }`, or approve. Routes through `session.setBeforeToolCall()` (already exposed; just wire runner dispatch).
- `on('message_end', handler)` / `on('session_loaded', handler)` / `on('turn_start', handler)` — observers for logging / telemetry extensions. No override semantics.
- `on('before_compact', handler)` / `on('after_compact', handler)` — for extensions that want to inject / strip compaction-only content.

### UI channel

New RPC pair:

- `extension_ui_request` (worker → host): `{ type: 'extension_ui_request', requestId, extensionPath, kind, payload }` where `kind` ∈ `'notify' | 'setStatus' | 'setWidget' | 'setTitle' | 'select' | 'confirm' | 'input' | 'editor' | 'setEditorText'`.
- `extension_ui_response` (host → worker): `{ type: 'extension_ui_response', requestId, result, error? }`.

Main-thread handlers:

- `notify` → `toast` (sonner).
- `setStatus` / `setTitle` → chat header slots.
- `setWidget` → transient bubble with a React-rendered custom component. Widget kinds are a closed enum (progress, info card, choice list) in Phase 2; full custom HTML lands in Phase 3.
- `select` / `confirm` / `input` → modal components reusing the existing `shadcn/ui` primitives.
- `editor` / `setEditorText` → inline editor in the transcript; reuses `MarkdownEditor` with an ok/cancel bar.

Extension-side `ExtensionAPI` grows:

```ts
pi.ui.notify(title: string, options?: { kind?: 'info' | 'warning' | 'error', detail?: string })
pi.ui.setStatus(text?: string)
pi.ui.setTitle(text?: string)
pi.ui.setWidget(widget?: { kind: 'progress' | 'info' | 'choice', props: Record<string, unknown> })
pi.ui.select<T>(prompt: string, options: { label: string; value: T }[]): Promise<T | undefined>
pi.ui.confirm(prompt: string, options?: { yes?: string; no?: string }): Promise<boolean>
pi.ui.input(prompt: string, options?: { default?: string }): Promise<string | undefined>
pi.ui.editor(path: string, options?: { language?: string }): Promise<void>
pi.ui.setEditorText(text: string): void
```

All methods wrap the RPC round-trip in promises the extension awaits.

### `registerProvider`

`pi.registerProvider(provider: LlmProvider)` — contribute an additional `LlmProvider` to the worker's provider registry. The worker's `createStreamFn` + catalog merger picks up the new provider on the next turn. Main thread sees the new models via `get_models` automatically; no UI change needed.

### `resources_discover` for skills

`pi.registerSkill({ name, description, body, scripts? })` — extensions contribute skills programmatically. These appear in `CommandRegistry` with `source: 'extension-skill'` (new enum entry). Skills registered this way can ship scripts as inline strings; the sandbox host loads them from memory rather than ZenFS.

### Compaction hooks

- `on('before_compact', { entries, cutIndex })` — handler can return `{ cutIndex?, preserveEntries? }` to influence cut selection.
- `on('after_compact', { summary })` — observer only.

### Session-manager access

`ExtensionContext.session: ReadonlySessionManager` — gives extensions read-only access to entries, branches, labels, fork IDs. The snapshot-vs-live question is open; proposal: return a thin wrapper that forwards to the currently active `SessionManager`, throwing `InvalidSessionError` when the session has been unloaded.

## Deliverables

1. **Types + runtime.** Extend `core/extensions/types.ts`, `runner.ts`, `wrapper.ts` with the new hook surfaces and the `pi.ui.*` / `pi.registerProvider` / `pi.registerSkill` APIs. Keep per-extension error isolation intact.
2. **RPC.** Add the extension-UI command pair and any new events. Update `rpc-types.ts`, `rpc-server.ts`, `rpc-client.ts`. Update `extensions.md`.
3. **Agent-session hooks.** Add `setBeforeLlmCall` and the compaction hooks to `AgentSession`; wire them from `worker-host.ts` on first extension registration, matching the lazy-install pattern used for `setAfterToolCall`.
4. **Main-thread UI.** Implement the widget / modal / editor renderers. All must respect `data-testid` discipline for e2e. Reuse existing `shadcn/ui` primitives.
5. **Fixtures.** Port `packages/coding-agent/examples/extensions/` entries that exercise each new hook (notify, select, confirm, widget, provider registration). Adapt the same way Phase 1 adapted `pirate.ts` and `hello.ts`.
6. **Tests.** Unit for every new runner dispatch path + RPC round-trip; e2e for at least one extension per new hook.
7. **Spec + cross-links.** Update `ai-docs/specs/worker-agent/extensions.md`, `feature-gaps.md`, `alignment.md`, `guidance.md`, `divergence.md`, `milestones/m8-extensions.md`. Draft [`./phase-2-report.md`](./phase-2-report.md) with decisions + gaps.

## Constraints (hard)

- **No iframe isolation yet.** Keep extensions inline in the agent Worker.
- **No TypeScript sources.** Same Phase 1 rule.
- **No bare-specifier imports.** Grow `pi` rather than letting extensions import modules.
- **Structured-clone-safe RPC.** Widget payloads must be plain data; React components cannot cross the Worker boundary. The UI channel speaks in **kind + props**, not in JSX.
- **No cross-extension interference.** One misbehaving extension may not block the UI channel for others — each request carries `extensionPath` and the main thread can surface errors per source.

## Open questions to resolve in the Phase 2 plan

1. **Widget kinds.** Is a closed enum (`progress | info | choice`) sufficient, or do we need an open-ended `data-extension-kind` attribute for extension-specific renderers?
2. **Modal stacking.** If two extensions call `pi.ui.confirm` simultaneously, do we queue, stack, or reject later callers?
3. **Provider registration ordering.** When an extension registers a provider mid-session, does the catalog refresh immediately or wait until the next turn boundary?
4. **Session access lifetime.** Does `ctx.session` expire at `session_loaded` for a different session, and if so, how do we surface that to the extension author?
5. **Rate limiting.** Do we cap the number of concurrent UI requests per extension? Coding-agent doesn't; the browser's modal UX might need it.

## Gate for Phase 2

- Extensions can call every `pi.ui.*` method and get a working result.
- At least one provider-registering extension (e.g. an echo provider) renders in the model picker alongside Bodhi's.
- At least one `on('context')` extension demonstrably mutates the outgoing tool list.
- All Phase 1 tests still pass; new e2e specs cover the new surface.
- `npm run check` (biome + tsgo + tsc -b) is clean.
- `npx vitest run` in `packages/web-agent/` stays fully green.
- `npm run test:e2e` in `packages/web-agent/` is green **in two back-to-back runs**. The suite runs serially (`fullyParallel: false`, `workers: 1`), so flakes surface quickly. `compaction.spec.ts` is a known pre-existing flake tracked separately — any new failures must be fixed before closing Phase 2.

## Wrap-up checklist (mandatory at Phase 2 close)

Treat this as a hard gate. Do not declare Phase 2 done until every item is signed off in the phase-2 report.

1. **Add / update e2e coverage.** For every new hook, UI-channel verb, and provider/skill registration path, either extend `e2e/extensions.spec.ts` or add a new spec alongside it (e.g. `e2e/extensions-ui.spec.ts`). Each spec must follow the same fixture-under-`e2e/data/sample-with-extensions/.pi/extensions/` pattern used in Phase 1 and must be phrased against **infrastructure invariants** (DOM state, RPC-visible effects, tool-call arguments) rather than LLM output text. The `data-test-state` attribute on the extensions panel should be the primary sync handle whenever a test toggles state.
2. **Run the full e2e suite twice from `packages/web-agent/`.** Both runs must be green (excluding the pre-existing `compaction.spec.ts` flake). Attach the last-run summary to the phase-2 report.
3. **Run `npm run check` at repo root and `npx vitest run` inside `packages/web-agent/`.** Both must be clean.
4. **Update `ai-docs`.** Touch `specs/worker-agent/extensions.md`, `specs/worker-agent/index.md`, the three `coding-vs-web-agent/*.md` alignment docs, and `milestones/m8-extensions.md` + `milestones/index.md`. Cross-link the phase-2 report from the milestone entry.
5. **Author the next handoff.** Refresh `phase-3-prompt.md` with the concrete API shapes that landed, the open questions that remain, and the isolation approach (iframe vs. Worker-per-extension) the Phase 3 implementer should consider first. Include this same wrap-up checklist, updated for Phase 3 gate checks.

## Learnings from Phase 1 (apply to Phase 2)

Carry these forward; they were paid for in debugging time during Phase 1.

- **Do not assert on `gpt-4.1-nano`'s textual output.** The small model routinely:
  - returns an empty string after a tool call instead of echoing stdout,
  - paraphrases instructions (e.g. replies `HELLO` when told to reply `HELLO-Alice`),
  - skips a required tool call on the second round-trip in a single session when earlier turns already ran a similar tool.

  Phase 1 moved every such assertion onto DOM state or tool-call argument/result widgets (`tool-call-content`). Phase 2 must do the same: assert on what the runner / RPC / DOM observably did, not on what the model said.

- **Watch out for strict-mode locator violations after repeated tool calls.** `chat.toolCall('bash')` matches every bash widget on the page; once a later step lands a second call, `toBeVisible()` on the bare locator throws a strict-mode error. Use `.last()` (or an explicit `.nth(N)`) whenever a step adds a *new* instance of a widget that already appeared in an earlier step.

- **Refresh `useSlashCommands` on `extension_states` as well as `session_loaded`.** Extension load is independent of session transitions; if the initial vault scan lands after the first `session_loaded`, the palette will stay stale unless both channels refresh it. The same pattern applies to any future hook that contributes commands (Phase 2's `registerSkill`, any future `registerContextMenu`, etc.) — wire its registry event through a `rpcClient.on*` channel and have the palette / header listeners subscribe.

- **Reflect the worker's authoritative state, not optimistic UI, on `data-test-state`.** `ExtensionsPanel` bases the row state on `ext.loaded` / `ext.error` as reported by the worker. E2E tests use that attribute to synchronise with extension reloads, so optimistic flips (from `enabledMap`) caused a class of race that disappeared once the attribute mirrored the worker snapshot. Keep this pattern for every panel Phase 2 adds.

- **Respect the default 30 s Playwright test timeout.** Phase 1's skills spec drifts close to the limit because it performs six LLM turns in a single test. Any new Phase 2 spec that chains more than three or four LLM turns should call `test.setTimeout(…)` explicitly rather than adding in-test retry loops — retries inside a single test eat the same budget and produce `Target page, context or browser has been closed` errors when the outer test reaper fires.

- **If a flake is LLM-driven, retry the send, not the assertion.** Phase 1 codified this in the vault-writer step: send once, wait briefly for the infrastructure witness (file on disk, runtime error in the panel, etc.), and only re-prompt if that witness never arrives. That keeps the happy path fast and makes failure modes observable rather than hidden behind assertion-level retries.

- **Add every new extension RPC command to the unit-test coverage for both `rpc-client.ts` and `rpc-server.ts` before wiring the UI.** The RPC tests caught two shape regressions during Phase 1 that would have been invisible until e2e.

### Cleanup-pass lessons (added after the pre-commit review of Phase 1)

The pre-commit review surfaced four architectural smells before the
Phase 1 merge. Internalise these so Phase 2 doesn't recreate them:

- **One owner per piece of state.** Phase 1 had
  `ExtensionRunner.pendingEnabledChanges` and
  `WorkerAgentHost.extensionEnabledState` tracking the same map. The
  runner's buffer turned out to be used only as a boolean flag. When
  in doubt, pick the controller / host as the owner and give the
  runner a pure dispatch role. Apply the same rule to Phase 2's
  provider catalog: either the runner owns it or the host does, not
  both.
- **Consume command responses; don't re-fetch.**
  `setExtensionStates` already returns descriptors AND triggers an
  `extension_states` event. Phase 1 also called `listExtensions()` at
  mount and after every push — redundant round-trip, and a race
  window where the UI could momentarily disagree with the worker.
  Phase 2's `registerProvider` / `registerSkill` commands should
  return their descriptors inline the same way.
- **Pre-seed the Worker via init, not via a follow-up push.** Phase
  1's first mount loaded every extension and then unloaded the
  disabled ones when the persisted map arrived. Fix: forward the map
  through the init protocol so the Worker's first `mountDevSeed` /
  `mountVault` already honours the user's choices. Phase 2 should
  plumb the same way for anything else main-thread-persisted (custom
  model catalog entries, provider credentials, widget prefs).
- **Reconcile maps that can grow.** Any `Record<string, T>` keyed by
  a user-mutable namespace (extension names, skill names, provider
  ids) must be pruned when the namespace changes. Phase 1 shipped
  without this and the enable map grew monotonically across
  mount/unmount cycles. Fix landed in
  `ExtensionHostController.reconcileEnabledState`; use the same
  pattern for Phase 2's provider / skill registration maps.
- **Extract when a host file crosses ~800 lines.**
  `WorkerAgentHost` hit 938 lines with extensions threaded through
  five distinct lifecycle hooks. Extracting
  `ExtensionHostController` behind a narrow `ExtensionHostDeps`
  surface restored testability and dropped the host to 749 lines.
  Phase 2 should extract `ExtensionUIController` (for the `pi.ui.*`
  RPC channel) and `ExtensionProviderController` (for
  `registerProvider`) proactively — don't inline them.
- **Keep tests aligned to reality.** Phase 1's report claimed
  `worker-host.test.ts` was updated; it wasn't. Phase 2's report
  must only claim coverage that actually exists, and the RPC +
  worker-host tests must move in lockstep with the host changes. The
  user guidance landed alongside this cleanup: write unit tests for
  critical complex logic, cover the rest via e2e, don't add tests
  just to tick boxes.
