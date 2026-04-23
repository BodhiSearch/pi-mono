---
name: m2 brief revision — multi-mount, defer permission, generic feature toggles
overview: "Revise the M2 executable brief at `ai-docs/web-acp/prompts/003-m2-vault-and-shell.md` and its companion milestone/steering docs to: defer the permission bridge to a new `deferred.md`, expand M2.1 to Linux-style multi-volume mounts with per-folder descriptions, introduce a generic `_bodhi/features/*` toggle (used by a just-bash on/off switch and a test-only force-tool-call flag), drop the \"don't touch chat/M1 e2e\" hard constraint, and require state-driven data-test* e2e (no timeouts)."
todos:
  - id: rewrite-brief
    content: "Rewrite `ai-docs/web-acp/prompts/003-m2-vault-and-shell.md`: new phase layout (multi-mount M2.1, feature-toggles + bash M2.2, fs/* handlers M2.3, polish M2.4), removed hard constraints 1 & 2, new testability section, port-don't-copy references."
    status: completed
  - id: seed-deferred
    content: Create `ai-docs/web-acp/milestones/deferred.md` seeded with the permission bridge + allow-always persistence carry-overs, mirroring the structure of the web-agent deferred doc.
    status: completed
  - id: update-m2-tools
    content: "Update `ai-docs/web-acp/milestones/m2-tools.md`: remove M2.3 permission bridge (link to deferred.md), expand M2.1 to multi-mount with descriptions, fold feature-toggle surface into M2.2, renumber fs/* handlers to M2.3."
    status: completed
  - id: update-milestones-index
    content: "Update `ai-docs/web-acp/milestones/index.md`: compliance-at-a-glance permission row becomes `deferred (see deferred.md)`; add deferred.md to Scope adjustments; link it from Load-when hooks."
    status: completed
  - id: update-steering-architecture
    content: "Update `ai-docs/web-acp/steering/02-architecture.md`: `/vault` → `/mnt/<name>`, multi-mount subsection, system-prompt descriptor injection; permission-flow section replaced with a deferred pointer."
    status: completed
  - id: update-steering-principles
    content: "Update `ai-docs/web-acp/steering/04-principles.md` principle 7: add data-test-state / no-timeout / no-`page.evaluate` rule."
    status: completed
isProject: false
---

## Files touched

- [ai-docs/web-acp/prompts/003-m2-vault-and-shell.md](ai-docs/web-acp/prompts/003-m2-vault-and-shell.md) — rewrite phase layout + hard constraints + deliverables.
- [ai-docs/web-acp/milestones/m2-tools.md](ai-docs/web-acp/milestones/m2-tools.md) — drop M2.3 permission bridge (→ deferred), expand M2.1 scope, fold the feature-toggle surface into M2.2, renumber `fs/*` handlers slice.
- **New:** [ai-docs/web-acp/milestones/deferred.md](ai-docs/web-acp/milestones/deferred.md) — explicit post-v1 carry-overs for web-acp; seeded with the permission bridge + allow-always persistence.
- [ai-docs/web-acp/milestones/index.md](ai-docs/web-acp/milestones/index.md) — compliance-at-a-glance table: permission row flips to `deferred (see deferred.md)`; new "Deferred to post-v1" bullet in Scope adjustments; link deferred.md.
- [ai-docs/web-acp/steering/02-architecture.md](ai-docs/web-acp/steering/02-architecture.md) — ZenFS mount layout: `/mnt/<name>` replaces `/vault`; permission-flow section marked as "deferred — see `milestones/deferred.md`"; add "System prompt carries volume descriptors" note.
- [ai-docs/web-acp/steering/04-principles.md](ai-docs/web-acp/steering/04-principles.md) — principle 7 (Test-driven, black-box, Playwright-first) gains a "testable internal state via `data-testid` / `data-test-state`; no `page.waitForTimeout`; wait on observable state" sub-point, replacing the former "don't touch prior specs" posture.

## Phase rewrite in the brief

Replace the current A–E sequence with:

- **Phase A — M2.1 — Vault multi-mount (worker-side).** Directory picker UX promoted to a "Volumes" panel: add volume, remove volume, optional description. Mount point becomes `/mnt/<folder-name>` with `-1`, `-2`, … collision suffixes. Per-volume optional description is persisted with the handle and folded into the agent's system prompt (e.g. `Volumes:\n- /mnt/wiki — Notes and drafts`). Worker `init` payload carries an array of `{ handle, mountName, description? }` rather than a single handle. e2e seed helper `installVolumes(page, seeds[])` supersedes `installVault` and drives the multi-volume path end-to-end.
- **Phase B — M2.2 — just-bash integration + `bash` tool + feature toggles.** Add `just-bash` from npm (published, pinned version; import from `just-bash/browser`). Register the single `bash` tool with `cwd = /mnt/<first-mount>`; compose `MountableFs` with each `/mnt/<name>` over `VaultFileSystem` and `InMemoryFs` for `/tmp` + `/home/user`. **No classifier**, **no permission prompts** in M2 — commands run as-is (noted in deferred.md). Generic feature-flag surface lands here: `_bodhi/features/list`, `_bodhi/features/set` extension methods + a session-scoped `features: Record<string, boolean>` slot on the session record; the worker honours `features.bashEnabled` (default `true`) by gating tool registration and honours `features.forceToolCall` (default `false`) by passing `tool_choice: 'required'` on the pi-ai request. UI exposes the just-bash toggle in settings; the `forceToolCall` toggle is gated on `import.meta.env.DEV`. e2e uses the dev toggle + targeted prompts to deterministically drive tool calls without `page.evaluate`.
- **Phase C — M2.3 — `fs/*` client handlers as IDE seam** (was Phase D). Unchanged content; renumbered because the old M2.3 is deferred.
- **Phase D — M2.4 — Polish + M2 exit** (was Phase E). Additionally confirms no permission-bridge code slipped in and that `deferred.md` is linked from the milestone index.

## Hard constraints changes in the brief

- Delete constraint 1 (`Do not edit chat.spec.ts`) and constraint 2 (`Do not edit existing M1 e2e specs`). Replace with: "Specs may be updated to match new testable surfaces (added `data-testid` / `data-test-state` hooks); changes must land same-commit with the code that motivates them."
- Keep constraints 3–10 (no renumbering, spec co-commits, no `any`, worker owns state, stable ACP only, `_bodhi/*` prefix, cite don't reproduce, gate honesty).
- Add a new constraint: "No timeouts in new e2e. Bubble internal state through `data-test-state="…"` attributes and wait on them."

## Testability / e2e conventions (brief § "Testing")

Add a short section encoding the Playwright-skill conventions the user called out:

- Components that carry runtime state expose `data-testid` for selection and `data-test-state` for state assertions (e.g. `data-test-state="idle|mounting|mounted|error"` on the volumes panel, `data-test-state="running|completed|failed"` on the bash tool-call bubble).
- Playwright waits via `toHaveAttribute('data-test-state', 'mounted')`; no `page.waitForTimeout`; no `page.evaluate` into internals.
- New `bash-smoke.spec.ts` asserts a small, representative command set (`cat`, `ls`, `grep`, a pipe, a redirect) rather than every bash command.
- A new `volumes.spec.ts` exercises add-volume, name-collision suffix, remove-volume, and "prompt mentions the volume description".

## Reference sources (brief)

Reword to "port, do not copy" and cite:

- [packages/coding-agent/src/](packages/coding-agent/src/) — turn loop, tool registry, extension hooks pattern.
- [packages/web-agent/src/providers/VaultProvider.tsx](packages/web-agent/src/providers/VaultProvider.tsx), [packages/web-agent/e2e/helpers/install-vault.ts](packages/web-agent/e2e/helpers/install-vault.ts) — FSA persistence + dev-seed pattern we re-derive.
- `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/src/` — ACP-shaped agent/session/session-store; stdio plumbing does not port.
- `/Users/amir36/Documents/workspace/src/github.com/vercel-labs/just-bash/src/browser.ts` + `src/fs/interface.ts` + `src/transform/` — the published library we import from npm; local clone is read-only reference.

## deferred.md seed content

Two sections:

1. **Permission bridge (from M2.3).** Classifier plugin, `session/request_permission` wiring, allow-always session-scoped store, settings reset UI. Rationale captured: M2 targets functional completeness of the tool loop; destructive-command gating layers on later without reshaping the tool call wire.
2. **Allow-always persistence.** Session-scoped memory of permission decisions — lands alongside the permission bridge when it re-enters.

Structure mirrors [ai-docs/web-agent/milestones/deferred.md](ai-docs/web-agent/milestones/deferred.md) (existing model) so readers recognise the shape.

## Steering updates

- [steering/02-architecture.md](ai-docs/web-acp/steering/02-architecture.md) § "ZenFS mount layout": `/vault` → `/mnt/<name>`; add multi-mount subsection; note system-prompt descriptor injection.
- Same file § "Permission flow": replace body with "Deferred to post-v1 — see [`milestones/deferred.md`](../milestones/deferred.md). The `bash` tool runs commands as-is in M2."
- [steering/04-principles.md](ai-docs/web-acp/steering/04-principles.md) § 7: add the data-test-state / no-timeout / no-`page.evaluate` rule as enumerated sub-points.

## Open question for the agent executing M2

Structured-clone vs. MessagePort for transferring an **array** of FSA handles (now that multi-mount is in M2.1) — resolve during phase-A planning. Recommendation carried from the brief: structured-clone each handle individually; the init payload carries `VolumeInit[]`.

## Out of scope for this brief revision

- Actually implementing any of M2 (that's the executing agent's job, driven by the revised brief).
- Editing historical prompts (`001-explore.md`, `002-m1-sessions.md`). Their "do not edit" language referred to shipped milestones and stays as historical record.