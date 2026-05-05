# M7 — Prompt template parameter form + skills

**Status:** planned. Finishes the commands / templates / skills
pipeline that M4 started. Ships after M6 extensions so
extension-contributed skills can participate from day one.

**Host scope.** Agent-primary. Browser host addenda inline under
§ "Browser host addendum".

## What this milestone delivers

Two capabilities that round out the M4 commands surface:

- **Parameter form for prompt templates (M7.1).** Templates with
  named parameters (e.g.
  `<mount>/.pi/prompts/review.md` declaring `{file, focus}`)
  open a quick inline form in the chat input before expansion.
  The filled values interpolate into the template; the LLM sees
  the rendered prompt, never the raw `/review {{file}}`
  invocation.
- **Skills (M7.2).** Bundled "persona + template + optional
  tool-hint" units activated per-turn. Sourced from
  `<mount>/.pi/skills/<name>/SKILL.md` with an `assets/` folder
  for ancillary files (reference data, checklists). A skill
  augments the agent's system prompt for the activated turn and
  optionally persists across the session.

Both capabilities existed as pending sub-milestones on the M4
file (M4.2-form, M4.3). They move to a dedicated milestone
because M6 extensions introduced `ExtensionContext.registerSkill`
and `ExtensionContext.registerPromptTemplate`, which need a
concrete `SkillDef` shape to consume. Bundling the skills
definition work with the parameter form in one milestone keeps
the types coherent.

## ACP compliance header

**Posture.** Fully ACP-canonical. Templates ride the same
`available_commands_update` advertisement that M4 phase A and
phase B use; the parameter form is a host-side picker UX on top
of the same `PromptRequest`. Skills introduce one new
extension method (`_bodhi/skills/activate`) — the spec has no
analog, and this remains firmly inside the `_bodhi/*` namespace
per principle § 15.

## Sub-milestones

### M7.1 — Prompt template parameter form

Deliverables:

- Front-matter parser in
  `packages/web-acp-agent/src/agent/commands/front-matter.ts`
  gains support for a structured `arguments:` block declaring
  named parameters with `{ name, description?, required?,
  default? }` entries. Unchanged behaviour for templates that
  declare no parameters.
- Expander at
  `packages/web-acp-agent/src/agent/commands/expander.ts`
  learns `{{name}}` substitution alongside the existing
  `$1..$9` / `$@` / `$ARGUMENTS` bash-style substitution so
  authors can mix the two (plain positional for quick
  one-shots, named for forms).
- `AvailableCommand._meta.bodhi` gains a
  `parameters?: Array<{ name, description?, required,
  default? }>` field the host picker reads to decide whether
  to open the form. Absence of the field (or empty array)
  means the picker opens the template with positional
  expansion as today.
- Host-side inline form component under
  `packages/web-acp/src/components/chat/PromptParameterForm.tsx`.
  Triggers when the selected entry carries non-empty
  `parameters`. Validates `required` fields; submits as a
  plain-text `PromptRequest` with `{{name}}` placeholders
  already resolved client-side (agent-side expansion stays a
  no-op for pre-resolved text). Autoc-omplete for file-typed
  parameters remains out of scope; M11 polish or later.

**Depends on:** M4 phase A (vault command pipeline), M4.2 first
slice (prompt template discovery).

**Gate items:**

- Unit: parse a vault template declaring `arguments: [{ name:
  file, required: true }, { name: focus, default: "style" }]`;
  expand against explicit params; missing-required throws; missing
  optional uses `default`.
- Real-LLM e2e: seed a volume with `.pi/prompts/review.md`
  carrying two params; pick `/review` from the picker; fill the
  form; submit; assert the assistant reply references the
  filled values.

### M7.2 — Skills

Deliverables:

- Worker-side skill discovery at session boot from
  `<mount>/.pi/skills/<name>/SKILL.md`. Skill manifest front-
  matter declares:
  - `name` (required; canonical name is
    `<mount>:<name>`).
  - `description` (required; picker secondary text).
  - `systemPromptAddition` (required; string appended to the
    base system prompt for activated turns).
  - `defaultModel?` (optional; auto-selects this model when
    the skill activates — only if the catalog contains it).
  - `persist?: boolean` (optional, default `false`; when
    `true` the skill stays active across subsequent turns in
    the session until explicitly deactivated).
  - `toolHint?: string[]` (optional; a free-form hint block
    the LLM sees inline — use to recommend particular tools
    without forcing them).
- Skills appear in the command picker alongside commands and
  templates via `available_commands_update` (principle § 10 —
  one picker for every addressable entry). Per-session skill
  activation via `_bodhi/skills/activate`:
  - Request: `{ sessionId, skillName, persist?: boolean }`.
    `persist` overrides the manifest default.
  - Response: `{ active: true | false, activeSkills:
    string[] }` echoing the current set.
- Per-session `activeSkills: string[]` slot on the session
  row; persisted via `SessionStore` through the standard
  `turn` payload metadata or a new `activeSkills` column (plan
  picks one at kickoff). Surfaces on
  `LoadSessionResponse._meta.bodhi.activeSkills` so reload
  restores the active set.
- System-prompt composition in
  `packages/web-acp-agent/src/agent/system-prompt.ts` learns
  to append each active skill's `systemPromptAddition` block
  in a `Skills:` section, ordered by activation time.
- Browser host picker shows skills in the same popover with a
  subtle marker (e.g. `[skill]` prefix or distinct section
  heading — TBD at M7.2 kickoff; stays a black-box consumer
  of the `AvailableCommand` payload otherwise).
- "Skill chip" affordance in the input area renders each
  active skill as a dismissible chip; click to deactivate.

**Depends on:** M4 phase A (command pipeline), M5 extraction
(the agent re-exports `SkillDef` so `ExtensionContext.registerSkill`
from M6 can contribute skills from code).

**Gate items:**

- Unit: discovery walks
  `<mount>/.pi/skills/code-review/SKILL.md`; front-matter parses
  cleanly; missing `description` or `systemPromptAddition`
  drops the skill with a warning.
- Unit: `_bodhi/skills/activate` writes through the store;
  second call toggles off; `persist: true` survives across
  subsequent prompts.
- Unit: extension-contributed skill (via
  `ExtensionContext.registerSkill` from M6) lands in the
  advertised set alongside vault skills.
- Real-LLM e2e: seed a volume with a
  `code-review` skill; activate via picker; prompt; assert
  that the system-prompt section lands in the first LLM
  call's headers (inspect via
  `agent_message_chunk` after a probing prompt); deactivate;
  follow-up prompt no longer sees the skill block.

### M7.3 — Exit gate + polish

- Unified picker rendering: one popover listing built-ins +
  commands + templates + skills + extension-contributed
  entries. Sections or tags as the plan decides at kickoff.
- Specs at
  [`../specs/web-acp-agent/commands.md`](../specs/web-acp-agent/commands.md)
  +
  [`../specs/web-acp-client/commands.md`](../specs/web-acp-client/commands.md)
  are updated with the parameter-form flow, the skill
  activation wire, and the unified picker contract.
- Deprecated-on-the-wire audit: no M4.2-form or M4.3
  placeholders remain; the `AvailableCommand._meta.bodhi`
  shape is complete.

## Browser host addendum (`packages/web-acp/`)

**Scope.**

- `PromptParameterForm.tsx` + its triggering logic in
  `ChatInput`.
- Skill chip affordance in the input area.
- Reducer arm in `panelsReducer` for `activeSkills` updates
  derived from `LoadSessionResponse._meta.bodhi.activeSkills`
  and subsequent `_bodhi/skills/activate` response echoes.

**Host hard constraints.** No new settings surface. Skills are
a chat-input concern; there is no dedicated Skills panel for
v1 (discovery shows up in the picker, activation is a chip).

## Out of scope

- **Remote / marketplace commands / templates / skills.**
  Local-only for v1.
- **Themes.** web-agent had these under resources; for web-acp
  they're UI polish (M11).
- **Parameter widgets beyond text / dropdown.** No file picker,
  no MCP-tool-output reference chips. Plain text inputs +
  enums (declared via `values?: string[]` on a parameter) only.
- **Skill composition / dependencies.** Activate multiple
  skills ⇒ ordered concatenation of `systemPromptAddition`.
  No cross-skill conflict detection beyond "last activation
  wins on `defaultModel`".
- **Per-message skill activation.** Skills activate for the
  whole next turn, not a specific message in a multi-message
  prompt.

## Depends on

- **M1** — session persistence (active-skill state lives on
  the session row).
- **M2** — agent-owned filesystem (skills read from
  `<mount>/.pi/skills/`).
- **M4** — commands / templates pipeline; shared picker.
- **M5** — engine split + agent-package extraction;
  `SkillDef` type ships from the agent package.
- **M6** — extension runtime; extensions contribute skills
  through `ExtensionContext.registerSkill`.

## Why this ordering (in the new sequence)

- **After M6 extensions** because skills want to be
  registerable from extension code (`ExtensionContext.registerSkill`).
  Shipping skills before extensions would force a rewrite of the
  registration path.
- **Before M8 session tree** because each forked branch should
  inherit the parent's active skills. Landing skills first means
  the fork operation has a clear piece of state to copy.
- **Before M10 permission bridge** because the bridge's
  tool-call pre-hook may interact with skill-provided
  `toolHint` lists (a skill suggesting `bash` specifically may
  want to inherit a relaxed permission prompt). Landing skills
  first keeps the permission work's scope narrow.

## Cross-references

- M4 (shipped, status: "phase A + B + M4.2 first slice
  shipped"):
  [`m4-commands-and-skills.md`](m4-commands-and-skills.md).
- M6 extensions (dependency):
  [`m6-extensions.md`](m6-extensions.md).
- Command spec (updates part of this milestone's gate):
  [`../specs/web-acp-agent/commands.md`](../specs/web-acp-agent/commands.md)
  +
  [`../specs/web-acp-client/commands.md`](../specs/web-acp-client/commands.md).
