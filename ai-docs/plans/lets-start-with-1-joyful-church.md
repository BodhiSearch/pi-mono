# M4.2 — Prompt templates (delivery plan)

Plan for the next slice of `packages/web-acp/`'s M4 milestone:
**vault-sourced prompt templates**, sibling to the M4.1 vault
slash-commands that already shipped at commit `7bc96d59`.

Milestone doc:
[`../web-acp/milestones/m4-commands-and-skills.md`](../web-acp/milestones/m4-commands-and-skills.md)
§ M4.2.

## Context

M4 Phase A (vault commands) and Phase B (built-ins `/help`, `/version`,
`/session`, `/copy`, `/mcp`) are shipped. Two M4 sub-milestones remain:
**M4.2 prompt templates** and **M4.3 skills**. Templates are the
shorter slice and the prerequisite for skills (skills layer system-prompt
addition + activation onto the same discovery + advertise pipeline).

The milestone preview is explicit:

> Worker-side template discovery from `<mount>/.pi/prompts/**/*.md`
> at boot. Templates register alongside M4.1 commands so the picker
> is unified.
>
> Parameter prompts: templates with named parameters trigger a quick
> form in the input area before expansion; the filled values
> interpolate into the template. **Until the form lands templates
> expand exactly like M4.1 commands (same expander).**

This plan covers the **first slice** — vault discovery + advertise +
expansion via the existing M4.1 expander. The parameter form is a
follow-up slice (carved out in "Out of scope" below). Wire and store
shape is unchanged: ACP `available_commands_update` already carries
templates and commands identically (`AvailableCommand` has no `type`
field; pi-acp confirms templates are advertised via the same
notification — `svkozak/pi-acp/src/acp/slash-commands.ts:115`).

## Why the design is constrained

Three things eliminate degrees of freedom:

1. **`AvailableCommand` has no kind discriminator.** Templates and
   commands look identical on the wire. The picker is already a
   black-box consumer (`src/components/chat/CommandPicker.tsx`) — no
   UI changes required.
2. **The expander is reusable as-is.** `expandCommand` in
   `packages/web-acp/src/agent/commands/expander.ts:26` matches by
   `name` against any `CommandDef[]`; templates with the same shape
   slot in unchanged.
3. **The loader is already factored against an `IFileSystem`-shaped
   `CommandsFs`.** `loadCommandsFromVolumes` in
   `packages/web-acp/src/agent/commands/loader.ts:42` only needs the
   directory relpath generalised.

The one judgement call: when the same canonical name resolves under
both `<mount>/.pi/commands/foo.md` and `<mount>/.pi/prompts/foo.md`,
how do we resolve? **Recommendation: flat namespace, commands win
first, warn on collision.** Rationale: the milestone says "register
alongside" → unified list, not parallel lists; collisions in practice
will be rare (different directory intent) and the warning makes them
loud; introducing a discriminator (`<mount>:prompt:<name>`) would
violate "the picker stays a black-box consumer" by leaking source-type
into the visible name.

## Scope

### In

1. Generalise the loader to scan a parameterised `dirRelpath` so the
   same code services both `.pi/commands/` and `.pi/prompts/`.
2. Discover `<mount>/.pi/prompts/**/*.md` at every `session/new` and
   `session/load`, parse the same frontmatter (`description`,
   `argument-hint`), merge into the unified `#availableCommands`
   cache after commands (commands win on conflict, warn).
3. Same canonical naming as commands: `<mount>:<subdir>:<name>`.
   Reuse `canonicalCommandName` from `path.ts:21` unchanged.
4. Expansion: zero changes — the existing expander matches by name
   regardless of source.
5. E2E spec `e2e/prompt-templates.spec.ts` mirroring
   `e2e/slash-commands.spec.ts:1-68`.
6. Unit tests for the prompt loader (mirror of `loader.test.ts`).
7. Spec doc update: new "Prompt templates" subsection in
   `ai-docs/web-acp/specs/web-acp/commands.md` under "Phase A".
8. Milestone bookkeeping in
   `ai-docs/web-acp/milestones/m4-commands-and-skills.md` §
   M4.2 → mark **shipped**; status row in
   `ai-docs/web-acp/milestones/index.md`.

### Out

- **Parameter form** — defer to a sibling slice (M4.2-form) once
  this lands. Milestone preview pre-authorises the split.
- **Bash slice operators `${@:N:L}`** that web-agent's
  `prompt-templates.ts` carried — not in M4.1's expander, not in
  the milestone deliverables. Out.
- **Live vault watcher / re-emit on file change** — already deferred
  for commands per the milestone doc; same posture for templates.
- **Skills, extension-registered templates, themes** — M4.3 / M5 / M8.

## Touchpoints

### Refactor — generalise the loader

| File | Change |
|---|---|
| `packages/web-acp/src/agent/commands/path.ts` | Add `PROMPTS_DIR_RELPATH = '.pi/prompts'` next to existing `COMMANDS_DIR_RELPATH` (line 11). The `canonicalCommandName` function takes `pathBelowCommands` already — no logic change; just rename the parameter mentally. |
| `packages/web-acp/src/agent/commands/loader.ts` | Extract a private `loadFromVolumes({ ...input, dirRelpath, kind })` helper. Re-export `loadCommandsFromVolumes` as a thin wrapper passing `COMMANDS_DIR_RELPATH` + `kind: 'command'`. Add a parallel `loadPromptsFromVolumes` passing `PROMPTS_DIR_RELPATH` + `kind: 'prompt'`. The `kind` only affects warning text (`[commands] …` vs `[prompts] …`). The existing `seen` Map de-dups within one call only — cross-kind dedup happens in the caller. |
| `packages/web-acp/src/agent/commands/types.ts` | No change. `CommandDef` is the right shape for both. (Adding a `kind` field is tempting but unused — defer until something needs to discriminate.) |

### Wire into the agent

| File | Change |
|---|---|
| `packages/web-acp/src/acp/agent-adapter.ts` | In `#refreshAvailableCommands` (line 848): after the existing `loadCommandsFromVolumes` call, run `loadPromptsFromVolumes` against the same `mounts` + `commandsFs`. Merge `[...commandDefs, ...promptDefs]` with first-wins dedup on `name` (warn on collision via the same `defaultWarn` path; commands win). Assign the merged list to `this.#availableCommands`. The `availableCommands` wire payload at line 863 picks up templates without further change. |

### Tests

| File | Change |
|---|---|
| `packages/web-acp/src/agent/commands/loader.test.ts` | Add a `describe('loadPromptsFromVolumes', …)` block: covers happy path (`.pi/prompts/foo.md` discovered with frontmatter parsed), missing-dir tolerated, mount-name validation, sub-directory canonicalisation, duplicate within a mount warned + first-wins. Mirror the existing command tests one-for-one. |
| `packages/web-acp/src/acp/agent-adapter.test.ts` | Add a unit test seeding both `.pi/commands/foo.md` and `.pi/prompts/bar.md` in a mock `CommandsFs`, asserting both names appear in the emitted `available_commands_update`. Add a collision test: same `<mount>:dup` in both directories → only the command version advertised, warning emitted. |
| `packages/web-acp/src/agent/commands/expander.test.ts` | Add one parametric test confirming a `CommandDef` with a `template` body containing `$1` and `$@` expands identically whether sourced from a command or a prompt (sanity, since the expander is source-agnostic). |
| `packages/web-acp/e2e/prompt-templates.spec.ts` (new) | Mirror `e2e/slash-commands.spec.ts`. Seed a single volume with `/.pi/prompts/poem.md` containing a verifiable template body (e.g. `Reply with exactly: BODHI-PROMPT-OK $1`). Assert: (a) typing `/` opens the picker; (b) the seeded template appears as `<mount>:poem`; (c) selecting inserts `/<mount>:poem `; (d) appending an arg + sending drives an LLM reply containing `BODHI-PROMPT-OK <arg>`. |
| `packages/web-acp/e2e/prompt-templates.spec.ts` — second `test.step` | Seed both `/.pi/commands/dup.md` ("CMD-WIN") and `/.pi/prompts/dup.md` ("PROMPT-LOSE"). Drive `/wiki:dup x` and assert reply contains `CMD-WIN`, not `PROMPT-LOSE`. (Verifies first-wins precedence end-to-end.) |

### Spec + milestone docs

| File | Change |
|---|---|
| `ai-docs/web-acp/specs/web-acp/commands.md` | Under "Phase A — vault-sourced commands", add a sibling subsection **"Prompt templates (M4.2)"** explaining: same `CommandDef` shape, sourced from `<mount>/.pi/prompts/**/*.md`, same expander (`expandCommand`), same `available_commands_update` advertisement, same wire envelope on `session/prompt`. Document the conflict rule (commands win, warn). |
| `ai-docs/web-acp/milestones/m4-commands-and-skills.md` | Update the "Status (2026-04-29)" header line: M4.2 → **shipped**; keep M4.3 pending. Mention the parameter-form follow-up in the carry-forward bullet. |
| `ai-docs/web-acp/milestones/index.md` | Update the M4 row's status text to reflect M4.2 shipped, M4.3 still pending. |

## Phasing

Single PR, four sequential commits to keep the diff reviewable:

1. **Phase A — loader generalisation.** `path.ts` + `loader.ts`
   refactor + `loader.test.ts` extension. No behavioural change for
   commands; new `loadPromptsFromVolumes` export unused yet. Run
   `npm test` in `packages/web-acp/` — must stay green.
2. **Phase B — agent wiring.** `agent-adapter.ts` merge in
   `#refreshAvailableCommands` + `agent-adapter.test.ts` cases.
3. **Phase C — e2e + dogfood.** New `prompt-templates.spec.ts`.
   Run `npm run test:e2e -- prompt-templates`.
4. **Phase D — docs + milestone.** Spec doc + milestone bookkeeping.
   No code changes.

## Verification

End-to-end:

```bash
# in packages/web-acp/
npm run check          # biome + tsc -b
npm test               # vitest — new loader + adapter cases must pass
npm run test:e2e -- prompt-templates  # new spec, runs against real LLM via .env.test
npm run test:e2e -- slash-commands    # regression — commands still pass
```

Smoke checklist (DEV server at `npm run dev`):

- Mount a folder with `.pi/commands/hello.md` and `.pi/prompts/poem.md`.
- Type `/` — picker shows both, names mount-prefixed.
- Select `/<mount>:poem`, type an argument, send — assistant replies
  using the template body, not the literal `/<...>` text.
- Reload the tab, resume the session — picker still lists both
  (verifies `available_commands_update` re-emits on `session/load`,
  already covered by the M4.1 path).

## Critical files for implementation

- `packages/web-acp/src/agent/commands/loader.ts:42` — generalise.
- `packages/web-acp/src/agent/commands/path.ts:11` — add prompts relpath.
- `packages/web-acp/src/acp/agent-adapter.ts:848` —
  `#refreshAvailableCommands` merge point; line 1134 has the
  `toAvailableCommand` mapper unchanged.
- `packages/web-acp/src/agent/commands/expander.ts:26` — read-only,
  used as-is.
- `packages/web-acp/e2e/slash-commands.spec.ts:1-68` — template for
  the new spec.
- `packages/web-acp/e2e/helpers/install-volumes.ts` — seed helper,
  reused unchanged.

## Reused utilities (no new abstractions)

- `parseFrontMatter` (`commands/front-matter.ts`) — same parser.
- `canonicalCommandName` (`commands/path.ts:21`) — same canonicaliser;
  takes a `pathBelowCommands` argument that's directory-agnostic.
- `expandCommand` + `tokenizeBash` (`commands/expander.ts`) — fully
  reused, zero changes.
- `toAvailableCommand` (`acp/agent-adapter.ts:1134`) — fully reused.
- `installVolumes` helper (`e2e/helpers/install-volumes.ts`) — fully
  reused; the `files` object accepts arbitrary paths under the mount,
  so seeding `/.pi/prompts/<name>.md` requires no helper change.

## Risks

- **Collision warning floods.** If a user moves `.pi/commands/` to
  `.pi/prompts/` without deleting the old copy, every command warns.
  Acceptable — the warning is the signal.
- **Loader perf.** Two recursive scans per session boot instead of
  one. Negligible (worker-side, off the critical render path), but
  worth noting if a future mount holds thousands of files; we'd
  collapse the two scans into one walk in that case.

## Follow-ups (not this PR)

- **M4.2-form** — parameter form for templates declaring named
  parameters in frontmatter. Wire shape TBD (likely a new
  `_meta.bodhi.template` field on `AvailableCommand` describing the
  parameter list, with the form rendered client-side).
- **M4.3 skills** — `<mount>/.pi/skills/<name>/SKILL.md` discovery,
  `_bodhi/skills/activate`, `activeSkills` on the session record.
- **Live vault watcher** — re-emit `available_commands_update` when
  vault files change, covering both commands and prompts together.
