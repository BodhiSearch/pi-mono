# web-acp — 005 — M4 Commands + Skills

Drive [`../milestones/m4-commands-and-skills.md`](../milestones/m4-commands-and-skills.md)
to completion. M3 shipped MCP over Streamable HTTP with per-session
toggles and a refcounted worker pool; M4 layers slash commands,
prompt templates, and vault-sourced skills onto the same session
surface.

> **Skeleton.** Only the scaffolding is filled in. Locked decisions,
> read-before-planning list, phase source/spec/e2e breakdowns, and
> exit criteria land before implementation begins.

## How to use this prompt

1. Read **Read before planning** in full, then draft a phased plan
   at `ai-docs/web-acp/plans/m4-commands-and-skills.md`. One phase
   per sub-milestone (M4.1 / M4.2 / M4.3), one commit per phase,
   each gated independently. Do not start implementing before the
   plan is reviewed.
2. Mark to-dos `in_progress` as you work (one at a time). Don't
   stop until every exit-criteria box is ticked.
3. Use `AskUserQuestion` only when a decision changes the plan's
   shape. Cosmetic choices: pick and move on.

## Decisions (do not re-ask)

1. **ACP-canonical command surface.** Slash commands ride
   `available_commands_update` + `session/prompt`
   (`agent-client-protocol/docs/protocol/slash-commands.mdx`). No
   extension method for advertising commands.
2. **Vault-sourced discovery.** Commands, templates, and skills
   live under `/vault/.bodhi/{commands,prompts,skills}/` and are
   read via the worker's `IFileSystem` from M2. Extension-
   registered entries are an M5 concern and must merge into the
   same discovery pipeline without reshaping it.
3. **Client-side template expansion.** Prompt templates expand on
   the main thread into `session/prompt` content blocks. No ACP
   surface beyond the existing prompt path.
4. **Skill activation is an agent-side extension.**
   `_bodhi/skills/activate` (client → agent) augments the next
   turn's system prompt; activation state lives in the session
   record and rehydrates via `bodhi/getSession`. Principle 15 for
   the `_bodhi/*` prefix; constants in `acp/methods.ts`.
5. **One turn by default.** Skills activate for the next turn
   only unless the manifest sets `persist: true`.
6. **No new tool registration from skills.** That layer is M5
   (extensions). Skills that need extra capability delegate to
   the already-present `bash` + MCP tool surface.

## Open design decisions for phase planning

> To be settled once the milestone kicks off; raise via
> `AskUserQuestion` if the answer changes the plan's shape.

- **Command discovery refresh cadence** — boot-only, per-prompt,
  or watch-based. Start simple (boot + per-prompt re-read) and
  layer a watcher only if latency becomes a problem.
- **Template parameter UI shape** — inline in the input
  composer vs. a modal form.
- **Skill chip placement** — input area, header, or sidebar.
- **How `activeSkills` interacts with session fork (M6)** — does
  a fork inherit or reset? Park until M6 plan.

## Read before planning

### In this repo

1. [`../steering/`](../steering/) — principle 2 (ACP is the wire),
   6 (extensions via `_bodhi/*` only when stock ACP is
   insufficient), 14 (agent owns tools), 15 (`_bodhi/*` naming).
2. [`../specs/web-acp/`](../specs/web-acp/) —
   [`acp.md`](../specs/web-acp/acp.md),
   [`agent.md`](../specs/web-acp/agent.md),
   [`sessions.md`](../specs/web-acp/sessions.md),
   [`vault.md`](../specs/web-acp/vault.md),
   [`tools.md`](../specs/web-acp/tools.md),
   [`mcp.md`](../specs/web-acp/mcp.md).
3. [`../milestones/m4-commands-and-skills.md`](../milestones/m4-commands-and-skills.md)
   — the milestone doc to land as "shipped" at exit.
4. [`../milestones/m2-tools.md`](../milestones/m2-tools.md) and
   [`../milestones/m3-mcp.md`](../milestones/m3-mcp.md) — cadence
   to mirror (phase A/B/C, gate scripts, spec co-commit).
5. [`../milestones/deferred.md`](../milestones/deferred.md) —
   permission bridge + provider-native tools stay deferred; any
   M4-carve-out lands here.
6. `packages/web-acp/src/acp/agent-adapter.ts` +
   `packages/web-acp/src/acp/client.ts` — extension-method wiring
   pattern established in M2 (features) and M3 (mcpToggles).
7. `packages/web-acp/src/agent/session-store.ts` — Dexie schema
   (v3 at M3 exit); any new session slot lands as a v4 migration.
8. `packages/web-acp/src/hooks/useAcp.ts` — main-thread hook that
   composes per-ACP-call state and handles replay.
9. `packages/web-acp/src/agent/system-prompt.ts` — the existing
   composition point that a skill's system-prompt addition hooks
   into.
10. `packages/web-acp/src/agent/tools/bash-tool.ts` — reference
    for a vault-path-aware worker consumer (skills read from the
    same mounted tree).

### External

11. `agent-client-protocol/schema/schema.json` —
    `available_commands_update`, `AvailableCommand`,
    `SessionUpdate.available_commands_update`.
12. `agent-client-protocol/docs/protocol/slash-commands.mdx` —
    wire contract for the picker.
13. `agentclientprotocol/claude-agent-acp/src/acp-agent.ts` —
    reference for commands discovery + advertisement.

### E2E harness

14. `packages/web-acp/e2e/tests/pages/ChatPage.ts` — command
    picker interactions land here; mirror the existing `login`
    option pattern.
15. `packages/web-acp/e2e/mcp-*.spec.ts` — `forceToolCall`
    pattern to emulate for deterministic command firing.
16. `packages/web-acp/e2e/tests/global-setup.ts` — seed a
    fixture `/vault/.bodhi/commands|prompts|skills/` tree before
    the first spec runs.

---

## Phase A — M4.1 — slash commands (vault-sourced)

### Source

- To be scoped: worker-side discovery under
  `packages/web-acp/src/commands/` (or similar), front-matter
  parser, `available_commands_update` notification emission, main-
  thread picker component + hook, command expansion helper.
- Action vs template command split — action commands ride
  `session/prompt` with an `_meta.slashCommand: <name>` tag;
  template commands expand client-side before the prompt call.

### Spec

- New [`../specs/web-acp/commands.md`](../specs/web-acp/commands.md):
  vault layout, discovery timing, `available_commands_update`
  contract, action vs template routing, extension merge seam.
- Cross-links from [`../specs/web-acp/index.md`](../specs/web-acp/index.md)
  and [`../specs/web-acp/sessions.md`](../specs/web-acp/sessions.md)
  if the session record gains new fields.

### E2E

- Fixture vault entries under
  `packages/web-acp/e2e/fixtures/vault/.bodhi/commands/`.
- `commands-discover.spec.ts` — after login, command picker opens
  with the fixture list; arrow-select + Enter expands; prompt
  fires with expected content.

### Gate

`npm run check` + vitest + full M3 e2e + `commands-discover.spec.ts`.
Commit: `web-acp: M4 phase A — slash commands (vault-sourced)`.

---

## Phase B — M4.2 — prompt templates

### Source

- To be scoped: template discovery, parameter schema parsing, UI
  for parameter prompts, template expansion path.

### Spec

- Extend `commands.md` with the `type: template` variant and the
  parameter-form contract.

### E2E

- `commands-templates.spec.ts` — fixture template with one
  required parameter; picker shows the template, prompts for the
  parameter, fires a prompt with the interpolated content.

### Gate

`npm run check` + vitest + full previous e2e +
`commands-templates.spec.ts`. Commit:
`web-acp: M4 phase B — prompt templates`.

---

## Phase C — M4.3 — skills + exit

### Source

- To be scoped: skill manifest parser, `_bodhi/skills/activate`
  handler, per-turn vs persistent activation bookkeeping, session
  record slot (`activeSkills`) + `bodhi/getSession` surface,
  main-thread chip UI.
- Dexie v4 migration if the session record grows beyond what M3
  left in place.

### Spec

- Extend `commands.md` (or split into `skills.md` if the surface
  justifies it) with the activation wire, persistence contract,
  and UI affordance.
- Update [`../specs/web-acp/sessions.md`](../specs/web-acp/sessions.md)
  to document the `activeSkills` slot on the session snapshot.

### E2E

- `skills-activate.spec.ts` — activate a fixture skill, assert
  the skill chip renders, run a prompt, assert the system prompt
  addition took effect (e.g. persona keyword appears in the
  response), reload, assert the chip survives.

### Exit audits

- Grep: no `request_permission|allow_always` outside deferred
  docs; `_bodhi/skills/` only in `acp/methods.ts` + adapter +
  client + tests; Dexie schema version matches the new migration.
- Finalise `m4-commands-and-skills.md` with status "shipped",
  decision log, test inventory. Update
  [`../milestones/index.md`](../milestones/index.md) board.
- Draft `006-<next>.md` skeleton once scope is known.

### Gate

`npm run check` + full web-acp e2e suite green (chat +
sessions-persist + sessions-resume + volumes + bash-smoke +
features + mcp-connect + mcp-roundtrip + mcp-toggles +
commands-discover + commands-templates + skills-activate).
Commit: `web-acp: M4 phase C — skills + M4 exit gate`.

---

## Hard constraints

1. Specs co-commit with code.
2. No `any`; no `@ts-ignore`; no skipped tests.
3. Main thread owns UI (picker, chips, parameter forms); worker
   owns vault reads + ACP surface emission. Dexie imports are
   worker-only.
4. Stable ACP schema only (`schema.json`).
5. Prefer stock ACP over extensions. When an extension is
   unavoidable (skill activation), use `_bodhi/*` with constants
   in `acp/methods.ts` (principle 15).
6. No `page.waitForTimeout` in new e2e; wait on `data-test-state`
   / `data-teststate`.
7. One task in-progress at a time.
8. If a test fails, it fails — no flake budget.

## Exit criteria

- [ ] Plan at `ai-docs/web-acp/plans/m4-commands-and-skills.md`
      reviewed.
- [ ] Three phase commits landed with matching spec updates.
- [ ] `npm run check` green at every commit.
- [ ] Fixture `/vault/.bodhi/{commands,prompts,skills}/` tree
      seeded in `global-setup.ts`.
- [ ] `commands-discover.spec.ts`, `commands-templates.spec.ts`,
      `skills-activate.spec.ts` green alongside every pre-M4 spec.
- [ ] Milestone doc marked "shipped"; any carve-outs recorded in
      [`../milestones/deferred.md`](../milestones/deferred.md).
- [ ] Next prompt skeleton drafted.
- [ ] Exit-audit greps pass.
