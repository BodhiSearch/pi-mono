# M5 — Resources

## What this milestone delivers

Three related affordances for making the agent more useful without
writing extensions:

- **Slash commands.** `/foo` in the input expands into a pre-filled
  prompt or triggers a known action.
- **Prompt templates.** Reusable prompt scaffolds addressable by
  name, parameterised at invocation time.
- **Skills.** Bundled "persona + template + optional tool" units
  that can be activated per-turn.

All three are sourced from the vault by default (e.g. from
`/vault/.pi/commands/`, `/vault/.pi/prompts/`, `/vault/.pi/skills/`)
— the pattern web-agent's M9 landed. Extension-registered resources
enter in M6.

## ACP surface touched

- Slash commands — ACP has `session/prompt` with structured content
  blocks. Slash-command expansion is ideally a client-side expansion
  before the prompt is sent, so no ACP surface is needed. If the
  command triggers a server-side action (e.g. `/compact`), that
  maps to the relevant ACP call.
- Prompt templates — client-side, no ACP surface.
- Skills — trickier. If a skill carries tools, those tools need to
  be registered on the agent side. Options:
  - Agent discovers skills from `/vault/.pi/skills/` at
    `session/new` time via `fs/*` reads.
  - Client sends a namespaced notification advertising the active
    skills; agent configures itself accordingly.
- pi-acp's `src/acp/slash-commands.ts` is the closest prior-art
  reference. Read it before planning.

## Depends on

- **M1** — sessions persist command/skill state across reload.
- **M2** — `fs/*` delegation is how the agent reads skill files
  from `/vault/.pi/**`.

## Out of scope

- Sandboxed `bash` shim for skill scripts. web-agent shipped this
  behind a Worker + iframe; we do not inherit that pattern. If
  skills need to execute something, they request it via a tool —
  and in v1 that means the tool already exists (read/write/edit).
  Full script execution is post-v1.
- Remote / marketplace resources. Local-only for v1.
- Themes. web-agent had these under resources; for web-acp they're
  UI polish (M7) not a resource.

## Why this ordering

Resources are pure UX sugar on top of M1 + M2 — every resource
eventually bottoms out in `session/prompt` + tool calls. Landing
them after the core is stable keeps the affordance layer thin.

Before M6 (extensions) because M6 must be able to register its own
resources. That's only coherent once the vault-sourced resource
pipeline is the established default.
