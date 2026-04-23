# M8 — Extensions

**Status:** ✅ Done. Phases 1 + 2a + 2b landed. Phase 3 deferred by
product decision — installed extensions are **fully trusted** and run
inline in the agent Worker with full core capabilities. No isolation /
sandboxing is planned; the current Blob-URL `import()` loader is the
permanent design. See [`deferred.md`](deferred.md) §
*Extension sandboxing* for the rationale, and
[`../extension-impl/phase-3-prompt.md`](../extension-impl/phase-3-prompt.md)
(archived with a DEFERRED banner) for the original Phase 3 scope.

Phase 1 shipped the browser-native extension runtime foundation: `.pi/extensions/<name>/index.js` is discovered from the vault, loaded inside the agent Worker via Blob-URL dynamic `import()`, and surfaces the `before_agent_start` / `tool_result` hooks plus `registerTool` / `registerCommand`. The main-thread `ExtensionsPanel` provides per-extension toggles, a global "Disable all" trip switch (the M8 gate), and surfaces both load-time and runtime errors.

Phase 2a widened the hook surface to every context/lifecycle event coding-agent exposes except compaction (`context`, `tool_call`, `turn_start`, `message_end`, `session_loaded` — reload-only) and introduced a modal `pi.ui.*` channel (`notify`, `setStatus`, `select`, `confirm`, `input`) backed by a dedicated `extension_ui_request` / `extension_ui_response` RPC pair, an `ExtensionUIController` worker-side, and an `ExtensionUIRenderer` + `ExtensionStatusChips` main-side.

Phase 2b closed the remaining coding-agent parity gap: the UI channel gained `setTitle`, `setWidget`, `editor`, and `setEditorText` verbs (with `ExtensionTitleSlot` + `ExtensionWidgetSlot` + `EditorDialog` main-thread surfaces); the loader exposes `pi.registerProvider` (orchestrated by a new `ExtensionProviderController` composite `LlmProvider` + `extension_providers_changed` event) and `pi.registerSkill` (backed by `ExtensionSkillController` and the new `extension-skill` source on `CommandRegistry`); extension handlers receive a read-only `ctx.session` through `ReadonlySessionForwarder`/`InvalidSessionError`; `before_compact` / `after_compact` hooks wire into `WorkerAgentHost.runCompaction`; and `session_loaded.reason` widened to `'mount' | 'reload' | 'switch' | 'fork' | 'new' | 'navigate'` so every transition path fires the event with a matching discriminator.

See [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md) for the full technical reference, [`../extension-impl/phase-1-report.md`](../extension-impl/phase-1-report.md) for the Phase 1 change log, [`../extension-impl/phase-2a-report.md`](../extension-impl/phase-2a-report.md) for Phase 2a, and [`../extension-impl/phase-2b-report.md`](../extension-impl/phase-2b-report.md) for Phase 2b.

The spike archive under [`ai-docs/extension-spike/`](../extension-spike/) is retained for historical context; the Phase 1 implementation superseded its open questions with the `inline_worker` / `minimal` / `per_ext_toggle` decisions captured in the plan.

---

## What this milestone delivers (feature-facing)

A mechanism for the web-agent to gain **optional, toggleable behaviours** beyond its built-in surface, covering at least the following genres:

- **Prompt shaping.** An enabled extension can influence the system prompt for a turn (prefix, suffix, or replace).
- **Tool output shaping.** An enabled extension can transform tool results before they return to the agent (text mutation, filtering, annotation).
- **Tool registration.** An enabled extension can contribute new tools that the agent can call.
- **Skill injection.** An enabled extension can register scoped instructions and tools on demand (skills-as-extensions), giving the agent task-specific playbooks without bloating the default prompt. *Note:* vault-sourced skills (`<vault>/.pi/skills/`) already ship as part of M9 independently of the extension runtime — see [`m9-resources.md`](m9-resources.md). M8 adds the ability for extensions to register skills programmatically.

Additional genres considered in scope for consideration but deferred from v1: tool-call policy gates (block/allow), custom providers (extra LLM backends), custom message renderers (charts, Mermaid), and per-call permission prompts.

---

## User-observable properties

- **Dynamic.** Enabling / disabling an extension takes effect without requiring a page reload. Mid-stream toggles apply consistently on a turn boundary, never inside an in-flight response.
- **Discoverable.** The user sees what extensions are available, which are enabled, and what each does, from a dedicated UI surface.
- **Reversible.** An extension can be disabled (and uninstalled, where applicable) cleanly, returning the agent to its baseline behaviour.
- **Observable.** Failures surface to the user as visible errors — an extension that cannot load or crashes is shown, not silent.
- **Persistent.** The user's extension choices survive page reloads, new sessions, and browser restarts.

---

## Non-goals (for M8)

- Marketplace / third-party distribution infrastructure.
- Signing, integrity verification, or review processes.
- DOM-rendering extensions (custom widgets, charts).
- Replacing any core agent functionality.
- Cross-device sync of extension choices.

---

## Gate

- One spec exercising the full lifecycle of at least two extensions from different genres, asserting both the UI state transitions and an observable effect on the conversation.
- Unit tests cover lifecycle state, toggle-deferral semantics, and error paths.
- A user-observable "disable all" affordance verified to restore baseline behaviour.
- No new `any`, no new `@ts-ignore`, no new skipped tests.
- Build + preview (`npm run build` + `npm run preview`) e2e smoke, in addition to the dev-mode e2e pass.

---

## References

- [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md) — authoritative Phase 1 + Phase 2a technical reference (types, loader, runner, wrapper, UI controller, worker-host wiring, RPC, main-thread store + panel + UI renderer).
- [`../extension-impl/phase-1-report.md`](../extension-impl/phase-1-report.md) — what shipped in Phase 1, known gaps, open questions carried into Phase 2.
- [`../extension-impl/phase-2a-report.md`](../extension-impl/phase-2a-report.md) — what shipped in Phase 2a, known gaps, open questions carried into Phase 2b.
- [`../extension-impl/phase-2b-report.md`](../extension-impl/phase-2b-report.md) — what shipped in Phase 2b, known gaps, open questions carried into Phase 3.
- [`../extension-impl/phase-2-prompt.md`](../extension-impl/phase-2-prompt.md) — original Phase 2 prompt (superseded by Phase 2a + Phase 2b split).
- [`../extension-impl/phase-2b-prompt.md`](../extension-impl/phase-2b-prompt.md) — Phase 2b handoff (widgets, editor, `setTitle`, `registerProvider`, `registerSkill`, session-manager access, compaction hooks).
- [`../extension-impl/phase-3-prompt.md`](../extension-impl/phase-3-prompt.md) — **archived** (Phase 3 deferred by decision; file carries a DEFERRED banner but the landed API shapes and hard constraints in its lower half remain ground truth).
- [`ai-docs/extension-spike/`](../extension-spike/) — spike archive retained for context; superseded by the Phase 1 / 2a implementation.
- [`ai-docs/decisions/m8-extensions.md`](../decisions/m8-extensions.md) — spike-era decisions (D20, D21); treat as historical.
