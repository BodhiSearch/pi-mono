---
name: M8 Extensions — Research-First Plan
overview: Reframe M8 as a research phase that runs multiple feasibility spikes across two orthogonal axes (loading mechanism × lifecycle model), plus a brainstorm of browser-viable extension categories, before any implementation plan is locked.
todos:
  - id: e1-cross-origin
    content: "E1: cross-origin static server + dynamic import in Worker (A1); capture CORS/CSP/Vite findings"
    status: completed
  - id: e2-same-origin
    content: "E2: same-origin static file + dynamic import (A2)"
    status: completed
  - id: e3-zenfs-blob
    content: "E3: ZenFS /extensions mount -> Blob URL -> dynamic import (A3); compare against D13/D14 caveats"
    status: completed
  - id: e4-dexie-blob
    content: "E4: Dexie bytes table -> Blob URL -> dynamic import (A4)"
    status: completed
  - id: e5-build-time
    content: "E5: build-time import.meta.glob composition for extensions under src/web-agent-extensions/* (A5)"
    status: completed
  - id: e6-worker-restart
    content: "E6: agent-worker restart without page reload; session re-hydrates from Dexie (B3)"
    status: completed
  - id: e7-hot-swap
    content: "E7: true hot-swap -- live register/unregister on the winning A-axis (B4)"
    status: completed
  - id: e8-path-guard
    content: "E8: path-guard sample extension (tool_call block semantics)"
    status: completed
  - id: e9-vault-todos
    content: "E9: vault-todos sample (registerTool + vault FS access)"
    status: completed
  - id: e10-fetch-url
    content: "E10: fetch-url-tool sample (net:<origin> permission probe)"
    status: completed
  - id: e11-ollama-provider
    content: "E11: ollama-provider sample (registerProvider plumbing)"
    status: completed
  - id: e12-greeting-skill
    content: "E12: greeting-skill (skills-as-extensions via before_agent_start + scoped tool; K2/K4 goals)"
    status: completed
  - id: e13-renderer-stretch
    content: "E13 stretch: registerMessageRenderer / mermaid-render if time allows"
    status: cancelled
  - id: matrix-score
    content: Populate feasibility matrix for both axes in m8-extensions-plan.md
    status: completed
  - id: decision-gate
    content: "AskQuestion-driven decision gate: user picks one A x B pair + committed extension genres"
    status: completed
  - id: impl-plan
    content: Draft ai-docs/plans/m8-extensions-implementation-plan.md based on the decision
    status: completed
  - id: scratch-cleanup
    content: Promote or delete packages/web-agent/scratch/m8/* experiments (log decision)
    status: completed
isProject: false
---

# M8 Extensions — Research-First Plan

No implementation commits until the research gate passes. Two artifacts drive this phase:

- [ai-docs/plans/m8-extensions-exploration.md](ai-docs/plans/m8-extensions-exploration.md) — coding-agent anatomy, web-agent current state, extension taxonomy, loading × lifecycle approach matrix.
- [ai-docs/plans/m8-extensions-plan.md](ai-docs/plans/m8-extensions-plan.md) — experiment catalog, feasibility matrix (filled as spikes land), decision gate.

## Two design axes under study

- **Axis A — where extension code comes from.** Cross-origin URL (A1), same-origin static (A2), ZenFS+Blob URL (A3), Dexie+Blob URL (A4), build-time `import.meta.glob` (A5), or hybrid (A6).
- **Axis B — lifecycle / reconfiguration UX.** Rebuild required (B1), page reload on toggle (B2), agent-worker restart no page reload (B3), or true hot-swap (B4).

Experiments are cells in this matrix; findings go into the scorecard in the plan file.

## Experiment catalog (0.5–1 day each, time-boxed)

- **E1** — cross-origin static server + `import(url)` inside Worker (A1).
- **E2** — same-origin file + `import(url)` (A2).
- **E3** — ZenFS `/extensions` IDB mount → Blob URL → dynamic import (A3).
- **E4** — Dexie bytes table → Blob URL → dynamic import (A4).
- **E5** — build-time `import.meta.glob` composition (A5).
- **E6** — agent-worker restart without page reload (B3).
- **E7** — true hot-swap without restart (B4) on the winning A-axis.
- **E8–E12** — sample extensions exercising real genres: path-guard, vault-todos, fetch-url-tool, ollama-provider, greeting-skill.
- **E13** — stretch: `registerMessageRenderer` / mermaid.

Each experiment is feature-flagged and lives in `packages/web-agent/scratch/m8/<id>/`; nothing ships. Every experiment appends a findings block to the plan file.

## Execution environment (already provisioned)

- Web-agent dev server on `:25173` (`npm run dev` in `packages/web-agent/`).
- Bodhi server on `:11135` (running via `make app.run` in the BodhiApp repo).
- Credentials from `packages/web-agent/.env.local` + `packages/web-agent/e2e/.env.test`.
- Extension static server on `:21136` (Node `http` script for E1).
- `cursor-ide-browser` MCP for live browser exploration; Playwright for deterministic specs.

## Extension category brainstorm (validated across experiments)

Taxonomy lives in the exploration doc §3. Browser-viable genres we plan to actually touch during research:

- Pure text mutation (uppercase-echo, whimsical thinking-message).
- Policy gates (path-guard on `tool_call`).
- Vault-backed data tools (todos as `/vault/.todos.md`).
- Custom tools (fetch_url with net:<origin> permission).
- Custom providers (local Ollama via `registerProvider`).
- Skill-as-extension (`before_agent_start` + scoped tool, stand-in for M9 resource loader).
- Deferred (listed, not built in M8): renderer API, full UI overlays, game canvases.

## Decision gate (what closes the research phase)

After E1–E7 plus ≥2 of E8–E12 land:

1. Populate the feasibility matrix in the plan file.
2. Present the scorecard back via `AskQuestion`, user picks one A×B pair.
3. Commit the user-chosen genres for M8 (others deferred).
4. Draft `ai-docs/plans/m8-extensions-implementation-plan.md` as the next planning doc. No implementation code lands before that.

## Out of scope for the research phase

Production CSP hardening, full permission UI polish, marketplace / install-by-name, packaging tooling, M9 resource loader, SRI integrity pinning.
