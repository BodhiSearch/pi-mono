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

- **Slash commands.** `/foo` in the chat input either expands to a
  pre-filled prompt client-side (purely textual commands) or
  triggers an agent-side action (commands with side effects). The
  agent advertises available commands via ACP's stable
  `available_commands_update` notification, and the UI shows them
  as a picker. When a command fires, the prompt is a normal
  `session/prompt` with the expanded content blocks.
- **Prompt templates.** Reusable, parameterised prompt scaffolds
  addressable by name. Sourced from
  `/vault/.bodhi/prompts/<name>.md` at session boot.
- **Skills.** Bundled "persona + template + optional tool-hint"
  units that can be activated per-turn. Sourced from
  `/vault/.bodhi/skills/<name>/`. A skill can rename the command
  picker entry that activates it; it cannot register new tools
  in v1 (that's an extension concern — M5).

All three sources live in the user's vault by default, reachable
via the agent-owned filesystem from M2. Extension-registered
commands / templates / skills enter in M5.

## ACP surface touched

- **`available_commands_update`** notification (agent → client) —
  advertises the command list. See
  `agent-client-protocol/docs/protocol/slash-commands.mdx`.
- **`session/prompt`** — expanded command content flows in as
  regular content blocks. No new method.
- **`_bodhi/skills/activate`** — agent-side extension method
  (client → agent) to activate a skill for the next turn.
  Rationale: skills mutate the agent's system prompt for a turn,
  which is an agent-side concern; the client needs a way to say
  "use skill X now". Falls under principle 15 (extension-method
  naming) and principle 6 (ACP extensibility before sub-protocols).
- Prompt templates are **pure client-side expansion** — the
  template file is read by the client (not the agent) and
  expanded into `session/prompt` content blocks before sending.
  No ACP surface.

## Sub-milestones

M4 ships in three slices.

### M4.1 — Slash commands (vault-sourced)

Deliverables:

- Worker-side command discovery at session boot: read
  `/vault/.bodhi/commands/*.md` via the agent's `IFileSystem`
  (from M2). Front-matter (YAML) carries name, description,
  arg schema.
- `AcpAgentAdapter` emits `available_commands_update` with the
  discovered commands after session setup and whenever the vault
  changes (file-watcher or on next `session/prompt`).
- Main-thread command picker UI: on typing `/`, show the
  advertised list; arrow-select + Enter expands into the input.
- Expansion strategy: commands with `type: prompt` expand
  client-side into the content block(s) and fire the normal
  `session/prompt`. Commands with `type: action` invoke an
  agent-side handler via the same `session/prompt` plus an
  `_meta.slashCommand: <name>` tag — the agent recognises the
  tag and runs the action (e.g. `/compact`, `/clear`) instead
  of relaying to the LLM.

### M4.2 — Prompt templates

Deliverables:

- Worker-side template discovery from
  `/vault/.bodhi/prompts/*.md` at boot. Templates register as a
  special flavour of slash command (`type: template`) so they
  ride the same `available_commands_update` surface.
- Parameter prompts: templates with named parameters trigger a
  quick form in the input area before expansion; the filled
  values interpolate into the template.
- Same `session/prompt` shape as M4.1 — expansion is client-side.

### M4.3 — Skills

Deliverables:

- Worker-side skill discovery from
  `/vault/.bodhi/skills/<name>/skill.md` at boot. Skill manifest
  declares a display name, description, system-prompt addition,
  and optional default model.
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
