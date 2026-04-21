# M8 — Extensions

**Status:** ✅ Phase 1 landed. Phases 2 + 3 deferred.

Phase 1 ships a browser-native extension runtime: `.pi/extensions/<name>/index.js` is discovered from the vault, loaded inside the agent Worker via Blob-URL dynamic `import()`, and surfaces the `before_agent_start` / `tool_result` hooks plus `registerTool` / `registerCommand`. The main-thread `ExtensionsPanel` provides per-extension toggles, a global "Disable all" trip switch (the M8 gate), and surfaces both load-time and runtime errors. See [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md) for the full technical reference and [`../extension-impl/phase-1-report.md`](../extension-impl/phase-1-report.md) for the change log.

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

- [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md) — authoritative Phase 1 technical reference (types, loader, runner, wrapper, worker-host wiring, RPC, main-thread store + panel).
- [`../extension-impl/phase-1-report.md`](../extension-impl/phase-1-report.md) — what shipped, known gaps, open questions carried into Phase 2.
- [`../extension-impl/phase-2-prompt.md`](../extension-impl/phase-2-prompt.md), [`../extension-impl/phase-3-prompt.md`](../extension-impl/phase-3-prompt.md) — handoff prompts for the deferred phases (UI channel + widgets; iframe sandbox, TS sources, marketplace).
- [`ai-docs/extension-spike/`](../extension-spike/) — spike archive retained for context; superseded by the Phase 1 implementation.
- [`ai-docs/decisions/m8-extensions.md`](../decisions/m8-extensions.md) — spike-era decisions (D20, D21); treat as historical.
