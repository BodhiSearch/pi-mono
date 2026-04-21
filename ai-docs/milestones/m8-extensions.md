# M8 — Extensions

**Status:** 🧪 spike complete, production implementation deferred.

A research spike explored the design space; see [`ai-docs/extension-spike/`](../extension-spike/) for the feasibility report, spike writeup, unbiased from-scratch recommendation, gap analysis, lessons learned, and open questions. The spike code lives on the current branch for reference only. No commitment has been made on the production shape; the next iteration begins from the open-questions gate.

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

- [`ai-docs/extension-spike/`](../extension-spike/) — spike archive; start with `README.md`, then `01-feasibility.md` and `03-unbiased-approach.md` before drafting the next plan.
- [`ai-docs/extension-spike/06-open-questions.md`](../extension-spike/06-open-questions.md) — decision gates that must close before implementation starts.
- [`ai-docs/decisions/m8-extensions.md`](../decisions/m8-extensions.md) — spike-era decisions (D20, D21); treat as historical, not forward commitments. Supersede if the next iteration overturns them.
