# M8 — Extensions — Phase 2b handoff prompt

Use this as the starting prompt for the Phase 2b implementation plan.

---

## Context

Phase 2a landed the minimal slice of M8 Phase 2: every context/lifecycle hook coding-agent exposes (minus compaction) plus a modal-only `pi.ui.*` channel (`notify`, `setStatus`, `select`, `confirm`, `input`). Widgets, editor, `setTitle`, `registerProvider`, `registerSkill`, session-manager access, and compaction hooks were explicitly deferred so the runtime, RPC protocol, and UI plumbing could stabilise first.

Phase 2b closes the remaining gap to coding-agent's extension surface — still **without** iframe / Worker-per-extension isolation (that's Phase 3).

Read before planning:

- [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md) — Phase 1 + Phase 2a reference.
- [`./phase-2a-report.md`](./phase-2a-report.md) — what landed, what's explicitly deferred.
- [`./phase-1-report.md`](./phase-1-report.md) — architectural decisions + cleanup-pass lessons.
- [`./phase-2-prompt.md`](./phase-2-prompt.md) — the original Phase 2 scope; Phase 2b is the remainder of the list below.
- `packages/coding-agent/src/core/extensions/` — reference implementation for the deferred surfaces.

## Goal

Close the remaining delta so web-agent extensions can shape every part of the agent turn coding-agent extensions can. Specifically: widgets in the transcript, inline editors, `setTitle`, LLM-provider contributions, skill contributions, read-only session-manager access, and compaction hooks. Clarify the initial-mount lifecycle for `session_loaded` as part of the same pass.

## Scope (proposed — refine in the plan)

### Remaining UI-channel verbs

- `pi.ui.setTitle(text?)` — chat-header slot (new `data-testid="extension-title"`).
- `pi.ui.setWidget({ kind, props })` — transient transcript bubble rendered by a closed enum (`progress | info | choice`). Widget props must stay structured-clone safe.
- `pi.ui.editor(path, { language? })` + `pi.ui.setEditorText(text)` — inline `MarkdownEditor` with an ok/cancel bar; resolves to `undefined` on cancel.

### `registerProvider` / `registerSkill`

- `pi.registerProvider(provider)` — contribute an additional `LlmProvider`. Worker's provider registry + catalog merger picks it up on the next turn; main-thread `get_models` reflects it automatically.
- `pi.registerSkill({ name, description, body, scripts? })` — skill contribution lands in `CommandRegistry` with a new `source: 'extension-skill'`. Sandbox host must load inline scripts from memory rather than ZenFS.

### Session-manager access

`ExtensionContext.session: ReadonlySessionManager` — read-only view of entries, branches, labels, fork IDs. Preferred approach: a thin forwarder that throws `InvalidSessionError` when the underlying session has been unloaded. Snapshotted DTO is a fallback.

### Compaction hooks

- `on('before_compact', { entries, cutIndex })` — handler can return `{ cutIndex?, preserveEntries? }` to influence cut selection.
- `on('after_compact', { summary })` — observer only.

### `session_loaded` lifecycle clarification

Phase 2a only fires `session_loaded` from `/reload` because extensions subscribe *during* factory execution, which itself happens inside the mount flow. Phase 2b must decide:

- Should `session_loaded` fire once after every factory completes, with a `reason` discriminator (`'mount' | 'reload' | 'switch'`)?
- Should the lifecycle add a distinct `on('extension_loaded')` instead, leaving `session_loaded` for session transitions?
- How does this compose with `newSession` / `forkSession` / `loadSession` / `navigateToLeaf`, each of which currently cancels pending UI requests but does not fire a lifecycle event?

Deliver a spec patch as part of the Phase 2b plan and mirror it in `extensions.md` alongside the runtime change.

## Deliverables

1. **Types + runtime.** Extend `core/extensions/types.ts`, `runner.ts` with the deferred hook surfaces and the `pi.ui.setTitle` / `setWidget` / `editor` / `setEditorText` / `registerProvider` / `registerSkill` APIs. Keep per-extension error isolation intact.
2. **RPC.** Grow `extension_ui_request` / `extension_ui_response` with the new kinds (`setTitle`, `setWidget`, `editor`, `setEditorText`). Add any new lifecycle events needed for session-manager access. Update `rpc-types.ts`, `rpc-server.ts`, `rpc-client.ts`.
3. **Agent-session hooks.** Add `setBeforeCompact` / `setAfterCompact` pass-throughs mirroring the Phase 2a `setTransformContext` / `setBeforeToolCall` installs.
4. **Main-thread UI.** Implement the widget / editor / title renderers. Respect `data-testid` discipline for e2e. Reuse existing `shadcn/ui` primitives.
5. **Providers + skills.** Extend `WorkerAgentHost` provider catalog + skill registry so extension contributions interleave with built-ins correctly. Preserve the cleanup-pass invariants (one owner per piece of state, reconcile maps on registration churn).
6. **Fixtures.** Port the remaining `packages/coding-agent/examples/extensions/` entries that exercise each new hook (widget, editor, provider, skill, compaction). Adapt the same way Phase 1 + 2a adapted `pirate.ts`, `hello.ts`, etc.
7. **Tests.** Unit for every new runner dispatch path + RPC round-trip; e2e for at least one extension per new hook. Carry the Phase 2a discipline: assert on DOM / RPC / files-on-disk witnesses, never on LLM text.
8. **Spec + cross-links.** Update `specs/worker-agent/extensions.md`, `specs/worker-agent/index.md`, `coding-vs-web-agent/{feature-gaps,alignment,divergence,guidance}.md`, `milestones/m8-extensions.md`, `milestones/index.md`. Draft `phase-2b-report.md` with decisions + gaps.

## Constraints (hard)

- **No iframe isolation yet.** Keep extensions inline in the agent Worker.
- **No TypeScript sources.** Same Phase 1 rule.
- **No bare-specifier imports.** Grow `pi` rather than letting extensions import modules.
- **Structured-clone-safe RPC.** Widget / editor payloads must be plain data; React components cannot cross the Worker boundary. The UI channel speaks in **kind + props**, not in JSX.
- **No cross-extension interference.** One misbehaving extension may not block the UI channel for others — each request still carries `extensionPath` and the main thread must surface errors per source. The FIFO modal queue established in Phase 2a extends to widgets / editor only if UX testing confirms it; otherwise widgets should render concurrently and editor should compete for the same transcript slot.

## Open questions to resolve in the Phase 2b plan

1. **Widget kinds.** Is the closed enum (`progress | info | choice`) sufficient, or do we need an open-ended `data-extension-kind` attribute for extension-specific renderers?
2. **Provider registration ordering.** When an extension registers a provider mid-session, does the catalog refresh immediately or wait until the next turn boundary?
3. **Session access lifetime.** Does `ctx.session` expire at `session_loaded` for a different session? If so, how do we surface that to the extension author — throw, return stale, return `undefined`?
4. **`session_loaded` vs. `extension_loaded`.** See above. Pick one and document the decision in `extensions.md`.
5. **Rate limiting.** Phase 2a's FIFO queue is the only backpressure. Do widgets need a per-extension cap (coding-agent doesn't enforce one, but the browser's modal / overlay UX may require it)?
6. **Editor concurrency.** If two extensions call `pi.ui.editor` simultaneously, do we queue, stack (tabs?), or reject later callers?

## Gate for Phase 2b

- Extensions can call every `pi.ui.*` method (including Phase 2a's verbs) and get a working result.
- At least one provider-registering extension (e.g. an echo provider) renders in the model picker alongside Bodhi's.
- At least one `on('before_compact')` extension demonstrably shifts the cut index.
- At least one `pi.registerSkill(...)` extension surfaces in the slash palette with `source: 'extension-skill'`.
- All Phase 1 + Phase 2a tests still pass; new e2e specs cover the new surface.
- `npm run check` (biome + tsgo + tsc -b) is clean.
- `npx vitest run` in `packages/web-agent/` stays fully green.
- `npm run test:e2e` in `packages/web-agent/` is green **in two back-to-back runs**. Compaction's pre-existing flake remains tracked separately — new failures must be fixed before closing Phase 2b.

## Wrap-up checklist (mandatory at Phase 2b close)

Treat this as a hard gate. Do not declare Phase 2b done until every item is signed off in the phase-2b report.

1. **Add / update e2e coverage.** For every new hook, UI-channel verb, and provider/skill registration path, extend `e2e/extensions-ui.spec.ts` or add a new spec alongside it. Each spec must follow the same fixture-under-`e2e/data/sample-with-extensions/.pi/extensions/` pattern used in Phase 1 + 2a and must be phrased against **infrastructure invariants** (DOM state, RPC-visible effects, tool-call arguments, files on disk) rather than LLM output text. The `data-test-state` attribute on the extensions panel should remain the primary sync handle whenever a test toggles state.
2. **Run the full e2e suite twice from `packages/web-agent/`.** Both runs must be green (excluding the pre-existing `compaction.spec.ts` flake). Attach the last-run summary to the phase-2b report.
3. **Run `npm run check` at repo root and `npx vitest run` inside `packages/web-agent/`.** Both must be clean.
4. **Update `ai-docs`.** Touch `specs/worker-agent/extensions.md`, `specs/worker-agent/index.md`, the four `coding-vs-web-agent/*.md` alignment docs, and `milestones/m8-extensions.md` + `milestones/index.md`. Cross-link the phase-2b report from the milestone entry.
5. **Refresh the next handoff.** Update `phase-3-prompt.md` with the concrete API shapes that landed, the remaining open questions, and the isolation approach (iframe vs. Worker-per-extension) the Phase 3 implementer should consider first. Include this same wrap-up checklist, updated for Phase 3 gate checks.

## Learnings to carry forward

All Phase 1 + Phase 2a learnings still apply. In particular:

- **Do not assert on `gpt-4.1-nano`'s textual output.** Every new e2e assertion must target DOM / RPC / files-on-disk witnesses.
- **One owner per piece of state.** Phase 2b introduces provider + skill registries. Pick one owner (host or runner, not both) and reconcile on registration churn.
- **Pre-seed the Worker via init, not via a follow-up push.** Any new main-thread-persisted value (extension-contributed provider credentials, widget prefs) forwards through the init protocol.
- **Extract when a host file crosses ~800 lines.** Phase 2a landed a dedicated `ExtensionUIController`; Phase 2b should introduce `ExtensionProviderController` and `ExtensionSkillController` rather than inlining them in `ExtensionHostController`.
- **Consume command responses; don't re-fetch.** `registerProvider` / `registerSkill` commands should return their descriptors inline and emit the corresponding `*_states` event in the same flow.
- **Keep tests aligned to reality.** Only claim coverage that exists; the RPC + worker-host tests must move in lockstep with the host changes.
