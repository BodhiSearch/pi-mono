# M8 — Extensions — Phase 2b implementation report

**Status:** landed.

**Source of truth:** [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md).

Phase 2b closes the remaining feature-level gap between the web-agent
and coding-agent extension surfaces (isolation excepted). Everything
coding-agent hosts can ask of an extension — widgets, inline editor,
title, LLM providers, skills, read-only session access, compaction
hooks, widened initial-mount lifecycle — now has a web-agent analogue.
The only deliberate divergence is the editor UX (modal dialog vs
inline), documented in [`../specs/coding-vs-web-agent/divergence.md`](../specs/coding-vs-web-agent/divergence.md).

## Decisions recorded

| Decision | Value | Rationale |
| --- | --- | --- |
| `session_loaded.reason` discriminator | `'mount' \| 'reload' \| 'switch' \| 'fork' \| 'new' \| 'navigate'` | Widens Phase 2a's single `'reload'` enum. Every `WorkerAgentHost` session-transition path now fires `emitSessionLoaded` exactly once with the matching reason; factory subscriptions still miss `mount` (factories run *inside* the mount flow), but any `on('session_loaded')` registered before the first transition will see it. |
| Compaction hook shape | `reducer + observer` | `before_compact` returns `{ cutIndex?, preserveEntries? }` (later handlers see the running override; host clamps `cutIndex` to `[0, entries.length)` and ORs `preserveEntries` before re-preparing). `after_compact` is observer-only (`{ summary, beforeCount, afterCount }`). Errors stay isolated per-handler so one broken extension can never break compaction. |
| Widget kind enum | `closed: progress \| info \| choice` | Extensions cannot smuggle arbitrary React through `postMessage`; a closed enum lets the host own rendering while still covering the three shapes coding-agent's widgets actually express. |
| Editor UX | `modal dialog` | Web-agent's modal vocabulary is the cleanest path — merging buffer surfaces with the transcript would require taking focus/keyboard ownership away from the composer. `setEditorText` buffers round-trips through the same FIFO queue so cancellation semantics stay unified. |
| `ctx.session` shape | `ReadonlySessionForwarder` + `InvalidSessionError` | Re-reads the live `SessionManager` every call so extensions can never cache a stale snapshot across `loadSession` / `newSession` / `forkSession` / `navigateToLeaf`. The error-on-mismatch behaviour forces explicit failure instead of silent stale reads. |
| Skill storage | `in-memory body, no ScriptSourceResolver` | Phase 2b only surfaces inline SKILL.md bodies — the optional extension JS script runner from the original plan is deferred, so `bash-skill.ts` stays untouched. `ExtensionSkillController.expandBody` reuses `CommandRegistry.expandSkill`'s wrapper text verbatim. |
| Provider dispatch key | `Model.provider` | Requests route to the first extension provider whose `getAvailableModels()` includes the target id; unknown ids fall through to the base Bodhi provider. Compatible with Phase 1 / 2a (where the base provider handled everything). |
| Provider churn signal | `extension_providers_changed` event | Main-thread UI refreshes the model picker off the event rather than polling; emitted only when the deduplicated set actually changes. |
| Extension skills > filesystem skills on name collision | `first-registered wins` | Matches the command-registration precedence rule from Phase 1. Flagged in the Phase 3 handoff for user-facing conflict reporting. |

## What shipped

### Worker-side runtime

- `core/extensions/types.ts` —
  - Added `BeforeCompactEvent` / `BeforeCompactEventResult` (reducer payload) and `AfterCompactEvent` (observer payload).
  - Widened `SessionLoadedEvent.reason` to `'mount' | 'reload' | 'switch' | 'fork' | 'new' | 'navigate'`.
  - `ExtensionUIContext` gained `setTitle`, `setWidget`, `editor`, `setEditorText`.
  - `ExtensionWidget` union (`progress | info | choice`) + payload types (`ExtensionUISetTitlePayload`, `ExtensionUISetWidgetPayload`, `ExtensionUIEditorPayload`, `ExtensionUISetEditorTextPayload`).
  - `RegisteredProvider` / `RegisteredSkill` runtime records.
  - `ExtensionAPI.on(...)` overloads for every new event; `ExtensionAPI.registerProvider(provider)` and `ExtensionAPI.registerSkill(skill)` registration helpers.
  - `ExtensionContext.session?: ReadonlySessionManager` exposed to every handler / tool invocation.
- `core/extensions/runner.ts` —
  - `emitBeforeCompact(event, ctx)` — reducer with per-handler `try/catch`; later handlers see the running override.
  - `emitAfterCompact(event, ctx)` — observer fan-out via the shared `emitObserverEvent` helper.
  - `getRegisteredProviders()` / `getRegisteredSkills()` — dedupe across extensions (first wins).
- `core/extensions/loader.ts` —
  - `buildExtensionAPI` wires `registerProvider`, `registerSkill`, and every new `pi.ui.*` verb onto the factory surface.
  - `NOOP_UI` updated so extensions loaded against a no-UI host still type-check and no-op every new verb.
- `core/extensions/session-forwarder.ts` — new. Implements `ReadonlySessionManager` by delegating to a live supplier; throws `InvalidSessionError` when the supplier returns `null` or a different instance than the one captured at construction time.
- `core/compaction/prepare.ts` — `prepareCompaction` accepts optional `{ preferredCutIndex, preserveEntries }` from extension hooks; exported `PrepareCompactionOptions` through the barrel.
- `core/commands/registry.ts` — `SlashCommandSource` gained `'extension-skill'`; added `setExtensionSkills` / `clearExtensionSkills` / `findExtensionSkill` / refreshed `list()` and `expandSkill()` to cover the extension-skill source.
- `core/commands/types.ts` — surfaces the `'extension-skill'` variant.

### Worker controllers

- `worker/extension-ui-controller.ts` — `createContextFor` exposes `setTitle`, `setWidget`, `editor`, and `setEditorText` with the Phase 2b semantics (immediate resolution for fire-and-forget verbs, FIFO queue entry for `editor`). Cancel-on-reset resolves pending editor promises to `undefined`.
- `worker/extension-provider-controller.ts` — new. Maintains a registered set of `LlmProvider`s and exposes `composite()` — a stable provider whose `streamMessage` / `setAuthToken` / `getAvailableModels` fan out over the base provider + every registered extension provider, dispatching per-request by `Model.provider`. Churn emits `extension_providers_changed`.
- `worker/extension-skill-controller.ts` — new. Owns `RegisteredSkill` records keyed by `(extensionPath, name)`, pushes deduplicated entries into `CommandRegistry.setExtensionSkills`, and exposes `expandBody(name, args)` for the inline expansion path.
- `worker/extension-host.ts` —
  - `ExtensionHostDeps` gained `providerController`, `skillController`, and `getSessionManager` fields.
  - `loadFromVault()` now pushes registered providers/skills to their controllers.
  - `emitBeforeCompact` / `emitAfterCompact` helpers delegating to the runner.
  - `emitSessionLoaded(reason)` accepts every Phase 2b reason.
  - `buildContext()` attaches `session: new ReadonlySessionForwarder(sessionManager)` so extension handlers always see the live session manager.
- `worker/worker-host.ts` —
  - Instantiates `ExtensionProviderController` and `ExtensionSkillController` at boot.
  - Installs `providerController.composite()` as the active `LlmProvider` that backs `streamFn`, summarisation, and the model-catalog RPC; removed the redundant `session.setStreamFn` call in the `boot.ts` / `agent-worker.ts` shims.
  - `runCompaction()` now fires `extensions.emitBeforeCompact(...)` before `prepareCompaction`, clamps `cutIndex` / ORs `preserveEntries`, then fires `extensions.emitAfterCompact(...)` after `compactSummarize` commits.
  - `setAuthToken`, `mountVault`, `mountDevSeed`, `loadSession`, `newSession`, `forkSession`, and `navigateToLeaf` all emit `session_loaded` with their matching reason.

### RPC protocol

- `rpc/rpc-types.ts` —
  - `ExtensionUIRequestKind` now spans `'notify' | 'setStatus' | 'setTitle' | 'setWidget' | 'editor' | 'setEditorText' | 'select' | 'confirm' | 'input'`.
  - Payload types for every new kind.
  - `RpcExtensionProvidersChangedEvent` (`{ type: 'extension_providers_changed', providers: ExtensionProviderDescriptor[] }`).
- `rpc/rpc-server.ts` / `rpc/rpc-client.ts` —
  - Routing and subscriber support for the new kinds.
  - `onExtensionProvidersChanged(listener)` subscription on the client; `dispose()` clears it.
- `worker-agent/index.ts` — exports every new payload / descriptor / event type for host consumption.

### Main-thread surface

- `hooks/useExtensionUI.ts` — extended state with `titles` + `titleOrder`, `widgetMap` + `widgetOrder`, and `editorDialog`. Handlers for `setTitle` / `setWidget` / `setEditorText` apply immediately; `editor` joins the modal queue. Exposes `{ activeDialog, statusChips, title, titleExtensionPath, widgets, respond, dismissActive }`.
- `components/extensions/ExtensionTitleSlot.tsx` — new. Renders the active extension title in the chat header with `data-testid="extension-title"` + `data-extension-path`.
- `components/extensions/ExtensionWidgetSlot.tsx` — new. Renders `progress | info | choice` bubbles via dedicated `ProgressWidgetBody` / `InfoWidgetBody` / `ChoiceWidgetBody` components. `choice` buttons call back through `sendExtensionUIResponse`.
- `components/extensions/ExtensionUIRenderer.tsx` — adds the `EditorDialog` branch (textarea + Cancel / Save bar; Escape / backdrop / Cancel resolves with `undefined`; Cmd/Ctrl+Enter or Save resolves with the value). Dialog shell widens to `max-w-2xl` for the editor kind.
- `components/chat/ChatDemo.tsx` — wires `ExtensionTitleSlot` into the header next to `SessionPicker` and `ExtensionWidgetSlot` above `ChatInput`.

### Fixtures

New under `packages/web-agent/e2e/data/sample-with-extensions/.pi/extensions/`:

| Fixture | Exercises |
| --- | --- |
| `title-marker/` | `pi.ui.setTitle` — `/title-show` / `/title-clear`. |
| `progress-widget/` | `pi.ui.setWidget` — one slot command per kind (`/widget-progress`, `/widget-info`, `/widget-choice`) + `/widget-clear`. |
| `note-editor/` | `pi.ui.editor` + `pi.ui.setEditorText` — `/note-edit` opens the modal; saved text echoes back through `pi.ui.setTitle` + `pi.ui.notify` for DOM assertions. `/note-prefill` demonstrates `setEditorText`. |
| `echo-provider/` | `pi.registerProvider` — registers a deterministic fake `LlmProvider` (canned models; fixed stream). |
| `compaction-nudger/` | `on('before_compact')` + `on('after_compact')` — mutates `cutIndex` / `preserveEntries`, surfaces counters via `/compact-stats`. |
| `skill-nudge/` | `pi.registerSkill` — two skills (`nudge`, `nudge-disabled`); `disable-model-invocation` honoured. |

### Tests

- Unit:
  - `core/extensions/runner.test.ts` — reducer chain / clamping / error isolation for `emitBeforeCompact`; observer fan-out + error isolation for `emitAfterCompact`.
  - `core/extensions/session-forwarder.test.ts` — live forwarding against a stubbed `SessionManager`; throws `InvalidSessionError` on null supplier / swapped manager.
  - `worker/extension-ui-controller.test.ts` — `setTitle` / `setWidget` / `setEditorText` fire-and-forget, `editor` pending queue, cancel-on-reset resolves `undefined`.
  - `worker/extension-provider-controller.test.ts` — composite dispatch by `Model.provider`, fallback to base provider, `setAuthToken` fan-out, model merging, churn event (no-op on identical sets).
  - `worker/extension-skill-controller.test.ts` — registry push, cross-extension dedupe, `expandBody` envelope, `disableModelInvocation` elision, churn + disposal clears registry entries.
  - `rpc/rpc.test.ts` — extension_ui_request round-trips for every new kind; `extension_providers_changed` event reach.
  - `core/commands/registry.test.ts` — extension-skill listing order / expansion / `findExtensionSkill`.
- e2e: `e2e/extensions-ui-2b.spec.ts` — fixture discovery / enablement, DOM-only assertions across:
  - `ExtensionTitleSlot` visibility after `/title-show`, disappearance after `/title-clear`.
  - Progress / info / choice widget rendering with `data-widget-kind`; `choice` button click round-trips through `sendExtensionUIResponse`.
  - `/note-edit` modal — cancel resolves `undefined`, Save echoes through the title slot + toast; Cmd/Ctrl+Enter acts as Save.
  - `echo-provider` models appear in the model picker with the `echo` provider id.
  - `/skill:nudge` and `/skill:nudge-disabled` surface in the palette with `data-command-source="extension-skill"`; `nudge-disabled` is omitted from the `<available-skills>` system-prompt section but remains invocable.
  - `/compact-stats` returns `before_compact = N, after_compact = M` via a toast.
  - Zero LLM-text assertions — DOM / RPC witnesses only.
- Vault split: the existing `extensions.spec.ts` (Phase 1) now seeds `e2e/data/sample-phase-1-extensions/` — a minimal vault that contains only `fancy-prompt`, `hello-tool`, `broken`, `thrower`. The comprehensive `sample-with-extensions/` vault (Phase 1 + 2a + 2b fixtures together) stays wired to `extensions-ui.spec.ts` and `extensions-ui-2b.spec.ts`. Rationale: the one LLM-coupled step in the Phase 1 spec (model calls the `hello` tool) was flaking once the Phase 2a `context-injector` and Phase 2b widget/title hooks started running concurrently; splitting the vault removes cross-phase coupling without weakening any assertion.

## Known gaps (intentional — carried into Phase 3)

1. **No iframe / Worker-per-extension isolation.** Extensions still run inline in the agent Worker. Cross-extension interference is prevented only by the runner's `try/catch` wrappers and the deduplication rules; CPU / memory hogs still degrade the agent Worker.
2. **No TypeScript sources / bundler.** Still single-file ESM `index.js`; bare-specifier imports remain unresolvable.
3. **No keybinding hook.** `pi-tui`'s `registerKeybinding` has no browser equivalent; the web host owns keyboard shortcuts globally.
4. **Editor UX is modal, not inline.** Deliberate divergence (see [`../specs/coding-vs-web-agent/divergence.md`](../specs/coding-vs-web-agent/divergence.md) § "Editor surface"). Revisit once UX testing reveals real demand for an inline editor.
5. **Extension skills silently override filesystem skills on name collision.** Currently first-registered wins (matches command behaviour). No user-facing conflict warning yet — flagged in the Phase 3 prompt.
6. **`before_compact` gating.** Handlers can only reduce the cut / preserve more entries; they cannot abort or defer compaction entirely. Intentional — compaction correctness stays under host control.
7. **Factory subscriptions miss `session_loaded: 'mount'`.** Factories run inside the mount flow; any subscription registered before the first transition will see subsequent `mount` reloads, but the very first mount that loaded the factory fires before the handler exists. Documented so extensions can treat "the first turn" as an implicit mount signal.
8. **Dialog timeout countdown not rendered.** The worker honours `opts.timeout`; the main-thread renderer still doesn't surface a visible countdown.
9. **Pre-existing compaction.spec.ts flake.** `e2e/compaction.spec.ts` occasionally fails its manual-compaction step because the summariser LLM call returns an empty bubble; tracked independently of Phase 2b (two back-to-back local runs reproduced only this spec).

## Open questions for Phase 3

- **Isolation model.** Iframe per extension? Worker per extension? Shared Worker with a capability broker? The answer drives the TypeScript / bundler story too.
- **Capability surface for sandboxed extensions.** Re-export today's `pi` API over a structured-clone channel, or narrow it to a subset that's safe to expose outside the agent Worker?
- **Name-collision UX.** Should the host surface a warning when two extensions register the same skill / command / provider id? Currently silent first-wins.
- **Extension marketplace story.** Out of scope for Phase 3 but a dependent decision for the isolation model.
- **Inline editor.** If we revisit it, does it share the composer focus/keyboard story or carve out its own surface?

## Cross-links

- Spec: [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md) — Phase 2b surface documented inline.
- Divergence note: [`../specs/coding-vs-web-agent/divergence.md`](../specs/coding-vs-web-agent/divergence.md) — editor modal vs inline, compaction reducer + observer split.
- Alignment note: [`../specs/coding-vs-web-agent/alignment.md`](../specs/coding-vs-web-agent/alignment.md) — registration / hook / `pi.ui.*` parity row.
- Feature-gap note: [`../specs/coding-vs-web-agent/feature-gaps.md`](../specs/coding-vs-web-agent/feature-gaps.md) — extension runtime row rewritten.
- Previous phase: [`./phase-2a-report.md`](./phase-2a-report.md).
- Next phase: [`./phase-3-prompt.md`](./phase-3-prompt.md).
