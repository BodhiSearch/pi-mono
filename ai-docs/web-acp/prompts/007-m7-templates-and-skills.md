# web-acp — 007 — M7 Templates + Skills

Drive [`../milestones/m7-templates-and-skills.md`](../milestones/m7-templates-and-skills.md)
to a shipped state. M7 closes the commands / templates / skills
pipeline that M4 opened: prompt templates gain a parameter form
and skills land as vault-sourced "persona + template + tool-hint"
units that augment the system prompt per-turn. M6 already wired
the discovery layer skills will reuse — extension-contributed
skills participate from day one.

> **Skeleton.** Mission, locked decisions, open decisions, hard
> constraints, and exit criteria are scaffolded. Phase plan +
> per-phase research live in `ai-docs/web-acp/plans/m7-templates-and-skills.md`
> after the kickoff research memo.

## How to use this prompt

1. Read this file end-to-end, then read
   [`../milestones/m7-templates-and-skills.md`](../milestones/m7-templates-and-skills.md)
   for the milestone-level scope, the M4 commands prompt
   ([`005-m4-commands-and-skills.md`](005-m4-commands-and-skills.md))
   for the discovery layer skills inherit, and the M6 extensions
   prompt ([`006-m6-extensions.md`](006-m6-extensions.md)) for
   the `pi.registerCommand` / `ExtensionAPI` shape that
   `pi.registerSkill` must mirror.
2. Draft a phased plan at
   `ai-docs/web-acp/plans/m7-templates-and-skills.md`.
   One phase per sub-milestone (M7.1 parameter form, M7.2
   skills, M7.3 exit gate). One commit per phase. Real-LLM e2e
   per phase. `npm run check` green at every commit.
3. Mark to-dos `in_progress` as you work (one at a time). Don't
   stop until every exit-criteria box is ticked.
4. Use `AskUserQuestion` only when a decision changes the plan's
   shape. Cosmetic choices: pick and move on.

## Mission

Two capabilities that round out the M4 commands surface:

1. **Parameter form for prompt templates (M7.1).** Templates
   declaring `arguments:` in their front-matter open a quick
   inline form in the chat input before expansion; the filled
   values interpolate into the template; the LLM sees the
   rendered prompt, never the raw `/review {{file}}` invocation.
2. **Skills (M7.2).** Bundled "persona + template + optional
   tool-hint" units activated per-turn from
   `<mount>/.pi/skills/<name>/SKILL.md`. A skill augments the
   agent's system prompt for the activated turn and optionally
   persists across the session. Skills appear in the same
   command picker as built-ins, vault commands, and extension
   commands — one popover for every addressable entry
   (principle § 10).

Both capabilities lived as pending sub-milestones (M4.2-form,
M4.3) on the M4 file. They moved here because M6 introduced
`pi.registerCommand` and reserved `pi.registerSkill` /
`pi.registerPromptTemplate`, which need a concrete `SkillDef`
shape to consume. Bundling the skills definition work with the
parameter form in one milestone keeps the types coherent and
ensures extension-contributed skills participate from day one.

## Locked decisions (do not re-ask)

These were confirmed at M4 kickoff and remain in force.

1. **ACP-canonical command surface.** Templates and skills ride
   `available_commands_update` + `session/prompt`. No new
   extension method for advertisement; only `_bodhi/skills/activate`
   for activation.
2. **Vault-sourced discovery.** Templates live under
   `<mount>/.pi/prompts/<name>.md`; skills under
   `<mount>/.pi/skills/<name>/SKILL.md`. Read via the agent's
   `IFileSystem` (M2 + M6). Extension-contributed entries
   merge into the same `available_commands_update` payload via
   `pi.registerSkill` / `pi.registerPromptTemplate`.
3. **Client-side template expansion.** Templates expand on the
   main thread into `session/prompt` content blocks. The agent
   only sees the rendered prompt.
4. **Skill activation is an agent-side ext-method.**
   `_bodhi/skills/activate` (client → agent) augments the next
   turn's system prompt; activation state lives on the session
   record and rehydrates via `LoadSessionResponse._meta.bodhi`
   (M5 envelope). Constants in the agent's wire module per
   principle § 15.
5. **One turn by default.** Skills activate for the next turn
   only unless the manifest sets `persist: true` (or the
   activation request overrides via `persist: true`).
6. **No new tool registration from skills.** That layer is M6
   (extensions). Skills that need extra capability delegate to
   the already-present `bash` + MCP + extension-registered
   tool surface; the manifest's `toolHint?: string[]` is a
   plain-text recommendation block injected inline, not a
   binding.
7. **Per-host scope: `packages/web-acp/` only.** `cli-acp-client`
   does not get the parameter form (its picker is text-based);
   skills are agent-side and benefit both hosts equally, but
   M7's e2e gate runs on `packages/web-acp/` only.
8. **Test-driven, sub-milestone-by-sub-milestone.** Each phase
   ports an example template / skill, ships an e2e step asserting
   end-to-end behaviour, and updates the spec. No callback ships
   without a real fixture and a real assertion.

## Open decisions for the planning agent

Settle these in the kickoff research memo, then proceed.

- **`arguments:` front-matter shape.** A list of objects
  (`[{ name, description?, required?, default?, values? }]`) is
  the working hypothesis. Decide whether to support `values?:
  string[]` (enum dropdown) in M7.1 or carry it forward to
  later UI polish.
- **Picker section vs prefix.** Do skills appear under a
  separate "Skills" header in the popover, or inline with a
  `[skill]` tag? `AvailableCommand._meta.bodhi.kind` gains a
  value to disambiguate either way; pick one and document.
- **Persistence column vs payload.** `activeSkills: string[]`
  on the session row, or fold into `LoadSessionResponse._meta.bodhi`
  payload only? The M5 envelope is the natural carrier; verify
  no separate `SessionStore` column is needed.
- **`pi.registerSkill` signature.** Mirror
  `pi.registerCommand` (factory-arg only, accepts a
  `SkillDef`)? Or a richer surface that mirrors the manifest
  front-matter? Decide based on what extensions need.
- **Default-model auto-selection on activation.** If a skill's
  `defaultModel` is not in the catalog, do we no-op silently or
  surface a chip warning? Pick.
- **Skill chip lifecycle on session reload.** Reload restores
  `activeSkills` from `LoadSessionResponse._meta.bodhi`.
  Confirm chips re-render on `loadSession` without a separate
  fetch.

## Hard constraints

1. **Specs co-commit with code.** Touch
   `ai-docs/web-acp/specs/web-acp-agent/commands.md` and
   `ai-docs/web-acp/specs/web-acp-client/commands.md`
   whenever the picker / activation / parameter-form surface
   changes. Add a `skills.md` spec under
   `ai-docs/web-acp/specs/web-acp-agent/` if the skill manifest
   shape grows beyond a paragraph in commands.md.
2. No `any`, no `@ts-ignore`, no skipped tests, no inline
   imports (`await import(...)` for types is forbidden — see
   `AGENTS.md`).
3. ACP wire stays canonical. Templates + skills + commands all
   ride one `available_commands_update`; activation rides one
   ext-method.
4. `packages/web-acp-agent/` MUST NOT import `@zenfs/dom`,
   `node:*`, or any browser-only / Node-only module from skill
   discovery or activation paths. Browser-only fetch / blob /
   URL access lives in `packages/web-acp/src/`.
5. No `page.waitForTimeout` in new e2e. Wait on
   `data-test-state`, message-bubble appearance, or explicit
   assertion polls.
6. One task `in_progress` at a time. Real-LLM e2e per phase, no
   model mocking unless an `AskUserQuestion` decides otherwise.
7. Per `AGENTS.md`: 2-space indent for new code, no emojis, no
   `git add -A`, no `git commit --no-verify`.

## Phase outline (refine in the plan)

- **M7.0 — Research memo + plan.** Settle the open decisions
  above, sketch the `SkillDef` shape, decide on the picker
  taxonomy, and lock the e2e fixtures. Plan reviewed before
  implementation.
- **M7.1 — Parameter form.** Front-matter parser + expander +
  `AvailableCommand._meta.bodhi.parameters` + host-side
  `PromptParameterForm.tsx`. E2e: seed a template with two
  params, fill the form, assert the rendered prompt reaches
  the LLM.
- **M7.2 — Skills.** Worker-side discovery + manifest parsing +
  `_bodhi/skills/activate` + system-prompt composition +
  `LoadSessionResponse._meta.bodhi.activeSkills` + browser
  picker entry + skill chip affordance. E2e: seed a skill,
  activate via picker, assert the system prompt augmentation
  hits the LLM, deactivate, assert it doesn't.
- **M7.3 — Exit gate + polish.** Unified picker rendering,
  spec updates, deprecation audit, milestone doc re-shape, M7
  marked shipped.

## Exit criteria

- [ ] Research memo + plan at
      `ai-docs/web-acp/plans/m7-templates-and-skills.md`
      reviewed.
- [ ] One commit per sub-milestone (M7.1 / M7.2 / M7.3).
      `npm run check` (from each affected package) green at
      every commit.
- [ ] Real-LLM e2e gate per sub-milestone — parameter form
      end-to-end, skill activation end-to-end. All prior e2e
      files still green.
- [ ] At least one ported example template (with `arguments:`)
      and one ported example skill, living under
      `packages/web-acp-agent/examples/skills/<name>/SKILL.md`
      and `packages/web-acp-agent/examples/prompts/<name>.md`
      (or wherever the plan locates them).
- [ ] `pi.registerSkill` + `pi.registerPromptTemplate` shipped
      on the M6 `ExtensionAPI`. At least one M6 example
      extension contributes a skill that lands in the
      advertised set alongside vault skills.
- [ ] Milestone doc `m7-templates-and-skills.md` re-shaped to
      reflect the actual phasing and marked **shipped**.
      Compliance row in `index.md` updated. Skills cross-
      reference linked from M6.
- [ ] Carve-outs (parameter widgets beyond text / dropdown,
      remote / marketplace skills, themes, per-message
      activation) documented in `deferred.md` with one-line
      rationales.
- [ ] Next prompt skeleton drafted at
      `ai-docs/web-acp/prompts/008-<next>.md` — likely M8
      session tree (forking + branching), since M7 lands the
      last piece of session-row state forks need to copy.
- [ ] Exit-audit greps pass: no `node:` or `@zenfs/dom`
      imports in the agent package's skill / template paths;
      no `page.waitForTimeout` in M7 e2e steps.
