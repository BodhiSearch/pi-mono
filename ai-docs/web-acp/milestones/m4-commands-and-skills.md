# M4 — Commands + Skills

## ACP compliance header

**Posture.** Fully ACP-canonical. Slash commands ride ACP's stable
`available_commands_update` + `session/prompt` surface
(`agent-client-protocol/docs/protocol/slash-commands.mdx`); prompt
templates and skills are agent-side affordances layered on top.
No divergence, no new extension methods in the default path.

## What this milestone delivers

Three related affordances that make the agent more useful without
writing an extension:

- **Slash commands (M4.1).** `/foo` in the chat input opens a picker
  populated from `available_commands_update`. When the user selects
  a command and sends, the agent receives the literal `/cmd args`
  text in a regular `session/prompt`, expands its body
  agent-side (front-matter stripped + bash-style argument
  substitution), and the LLM sees the rendered template — never
  the slash invocation. ACP's `AvailableCommand` schema has no
  `type` field; M4.1 ships template expansion only and built-in
  agent actions like `/compact` arrive in the milestone that needs
  them (M7 for `/compact`) as agent-internal keyword detection,
  not a new `AvailableCommand` shape.
- **Prompt templates (M4.2).** Reusable, parameterised prompt
  scaffolds addressable by name. Sourced from
  `<mount>/.pi/prompts/<name>.md` at session boot. Ride the same
  `available_commands_update` surface as M4.1 commands so the
  picker is unified.
- **Skills (M4.3).** Bundled "persona + template + optional tool-hint"
  units that can be activated per-turn. Sourced from
  `<mount>/.pi/skills/<name>/`. A skill can rename the command
  picker entry that activates it; it cannot register new tools
  in v1 (that's an extension concern — M5).

All three sources live in the user's vault by default, reachable
via the agent-owned filesystem from M2 — under the **pi convention
`<mount>/.pi/...`** (matching `web-agent`'s `.pi/prompts/`,
`.pi/skills/`, `.pi/extensions/` layout, and `pi-acp`'s
`<cwd>/.pi/prompts/`). The earlier preview's `<vault>/.bodhi/...`
text was a misnomer corrected at M4.1 kickoff. Extension-registered
commands / templates / skills enter in M5.

## ACP surface touched

- **`available_commands_update`** notification (agent → client) —
  advertises the command list. See
  `agent-client-protocol/docs/protocol/slash-commands.mdx`. The
  `AvailableCommand` schema has only `name`, `description`, an
  optional `input.hint`, and the standard `_meta` slot — no `type`
  field, no structured arguments yet.
- **`session/prompt`** — the literal `/cmd args` text flows in as
  a regular `text` content block. No structured `slashCommand`
  field on the wire; the agent recognises the leading `/` and
  expands the matching template before the LLM call.
- **`_bodhi/skills/activate`** — agent-side extension method
  (client → agent) to activate a skill for the next turn.
  Rationale: skills mutate the agent's system prompt for a turn,
  which is an agent-side concern; the client needs a way to say
  "use skill X now". Falls under principle 15 (extension-method
  naming) and principle 6 (ACP extensibility before sub-protocols).
- Prompt templates ride the same `available_commands_update` surface
  as M4.1 commands. Expansion stays agent-side for parity (a single
  expander module owns the substitution rules), so the wire shape
  is identical.

## Sub-milestones

M4 ships in three slices.

### M4.1 — Slash commands (vault-sourced)

Deliverables:

- Worker-side command discovery at session boot: recursively scan
  `<mount>/.pi/commands/**/*.md` on every mounted volume via the
  agent's `IFileSystem` (from M2). Front-matter (`description`,
  `argument-hint`) is parsed by a hand-rolled minimal parser —
  no new YAML dep. Richer Claude-Code fields (`allowed-tools`,
  `model`, `disable-model-invocation`, named `arguments`,
  `when_to_use`) are out of scope for M4.1 and re-enter with M5.
- Canonical naming: every command is mount-prefixed
  `<mount>:<subdir>:<name>` (mirroring Claude Code's mandatory
  `<plugin>:<skill>` rule). Conflicts within a mount resolve
  first-wins by sorted relative path with a warning. The picker
  always shows the fully qualified name.
- `AcpAgentAdapter` emits `available_commands_update` once after
  `session/new` and once after `session/load`. No live file
  watcher in M4.1.
- Main-thread command picker UI in `ChatInput`: typing `/` opens
  a popover filtered by the leading token; arrow-select + Enter
  inserts `/<full-name> ` and refocuses the textarea so the user
  can type arguments. The picker is purely a consumer of
  `availableCommands`; no extra request/response on selection.
- Agent-side expansion in `prompt()`: parse `/<name>` in the last
  user-text content block, tokenise arguments bash-style (single
  + double quotes, backslash escapes), substitute `$1..$9`, `$@`,
  and `$ARGUMENTS` (alias of `$@` for Claude Code parity), and
  rewrite the block in place. Unmatched positional placeholders
  stay literal so authors notice immediately. Unknown `/cmd` and
  non-slash text pass through untouched.

### M4.2 — Prompt templates

Deliverables:

- Worker-side template discovery from
  `<mount>/.pi/prompts/**/*.md` at boot. Templates register
  alongside M4.1 commands so the picker is unified.
- Parameter prompts: templates with named parameters trigger a
  quick form in the input area before expansion; the filled
  values interpolate into the template. Until the form lands
  templates expand exactly like M4.1 commands (same expander).

### M4.3 — Skills

Deliverables:

- Worker-side skill discovery from
  `<mount>/.pi/skills/<name>/SKILL.md` at boot (matches
  web-agent's frozen-archive layout). Skill manifest declares a
  display name, description, system-prompt addition, and
  optional default model.
- `_bodhi/skills/activate` request (client → agent): takes a
  skill name; the agent augments its next turn's system prompt
  with the skill's content. Activation is scoped to one turn
  unless the skill manifest declares `persist: true` (then it
  applies to all subsequent turns in the session until
  deactivated).
- Activation state persists in the session record (new
  `activeSkills` field). `bodhi/getSession` surfaces it on
  reload.
- UI: a "skill" chip in the input area shows the active skill;
  click to deactivate.

## Depends on

- **M1** — session persistence. Skill activation state lives
  in the session record.
- **M2** — agent-owned filesystem. Commands, templates, skills
  are all read from the vault via the worker's `IFileSystem`.
  (We do not round-trip through ACP `fs/*` for this; see M2
  compliance note.)

## Out of scope

### M4.1 specifically

- Live vault watcher / re-emit on file change (re-enters M4.2 or
  later — for now refresh fires once per `session/new` /
  `session/load`).
- Built-in agent actions (`/compact`, `/clear`) — they are
  agent-internal keyword detection, not a different shape of
  `AvailableCommand`. Land with the milestone that needs them
  (M7 ships `/compact`).
- Extended Claude-Code front-matter (`allowed-tools`, `model`,
  `disable-model-invocation`, named `arguments`, `when_to_use`)
  → M5 extensions.
- Conflict-resolution UX in the picker → M4.3 or M5.
- `_meta` on `AvailableCommand` (e.g. tagging source mount in the
  wire) → M5.
- `StructuredCommandInput` once ACP defines it → track upstream.
- Tier shadowing (user vs project). web-acp has no "user tier",
  only mounts. Reconsider if a global `/extensions` mount lands
  in M5.

### M4 milestone-wide

- Sandboxed `bash` shim for skill scripts. just-bash *is* the
  sandbox; skills that want to run scripts do so via the
  already-present `bash` tool. They don't get a private runtime.
- Skills registering new LLM-facing tools. That's an extension
  concern (M5).
- Remote / marketplace commands / templates / skills. Local-only
  for v1.
- Themes. web-agent had these under resources; for web-acp
  they're UI polish (M8).

## Why this ordering

Commands are pure UX sugar over `session/prompt`. They're the
smallest milestone after M2+M3 — one stable ACP surface
(`available_commands_update`) and agent-side plumbing over an
already-mounted vault.

**Before extensions (M5)** because extensions must be able to
register additional commands / templates / skills. The
vault-sourced discovery pipeline must exist first, so
extension-registered entries can merge into the same list.

**Before session tree (M6)** because each forked branch should
inherit the parent's active skills. Landing skills first means
the fork operation has a clear piece of state to copy.
