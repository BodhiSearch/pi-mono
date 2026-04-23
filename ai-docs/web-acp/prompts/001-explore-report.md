# 001-explore — completion report

Report for the exploration turn driven by
[`ai-docs/web-acp/prompts/001-explore.md`](001-explore.md). Scope
revised live via `AskUserQuestion` — see "Questions asked" below.
No runtime code under `packages/web-acp/src/` or `packages/web-acp/e2e/`.

## What now lives where

### Moved (git mv, history preserved)

- `ai-docs/00-vision.md`    → `ai-docs/web-agent/00-vision.md`
- `ai-docs/01-goals.md`     → `ai-docs/web-agent/01-goals.md`
- `ai-docs/02-architecture.md` → `ai-docs/web-agent/02-architecture.md`
- `ai-docs/04-principles.md` → `ai-docs/web-agent/04-principles.md`
- `ai-docs/milestones/`     → `ai-docs/web-agent/milestones/` (whole folder, 16 files)

### Created

- `ai-docs/web-agent/README.md` — frozen-archive marker for the
  web-agent material.
- `ai-docs/web-acp/steering/00-vision.md` — web-acp north star.
- `ai-docs/web-acp/steering/01-goals.md` — capability checklist
  with ACP surfaces and test seams.
- `ai-docs/web-acp/steering/02-architecture.md` — layer cake,
  transport-swappability, ZenFS ↔ ACP `fs/*` mapping.
- `ai-docs/web-acp/steering/04-principles.md` — 14 principles; new
  ones are principle 2 (ACP is the wire protocol), 3 (transport
  swappable), 6 (ACP extensibility before sub-protocols), 13
  (extensions are late).
- `ai-docs/web-acp/milestones/index.md` — status board +
  load-when hooks.
- `ai-docs/web-acp/milestones/m0-foundation.md` — M0.a + M0.b.
- `ai-docs/web-acp/milestones/m1-sessions.md`
- `ai-docs/web-acp/milestones/m2-tools.md`
- `ai-docs/web-acp/milestones/m3-session-tree.md`
- `ai-docs/web-acp/milestones/m4-compaction.md`
- `ai-docs/web-acp/milestones/m5-resources.md`
- `ai-docs/web-acp/milestones/m6-extensions.md`
- `ai-docs/web-acp/milestones/m7-polish-and-extract.md`
- `ai-docs/web-acp/prompts/001-explore-report.md` — this file.

### Edited

- `CLAUDE.md` (repo root) — rewritten so a fresh session lands in
  web-acp. Steering-docs list points at `ai-docs/web-acp/steering/`;
  dev-commands block for `packages/web-acp/` added; reference-projects
  list gained entries for `agentclientprotocol/agent-client-protocol`
  and `svkozak/pi-acp` with their cloned absolute paths.

### Left in place (not moved)

These live under `ai-docs/` at their original paths because either
they're append-only, still in flight, or scoped folders unlikely to
conflict with web-acp work:

- `ai-docs/decisions/` — append-only decisions log; new web-acp
  entries append here prefixed `web-acp:`.
- `ai-docs/specs/` — web-agent technical specs; referenced from
  both web-agent archive and web-acp steering as crib sheets.
- `ai-docs/plans/` — web-agent plans; disposable but still
  historical.
- `ai-docs/extension-guide/`, `extension-impl/`, `extension-spike/`
  — web-agent extension work; referenced by M6 preview.
- Loose files: `PENDING.md`, `compact.md`, `resume.md`,
  `prompt-extension*.md`.

If any of these interferes with web-acp work, file a follow-up;
do not shuffle them quietly.

## Decisions made (not pre-answered)

- **Move scope.** Only the 4 top-level steering docs + the
  `milestones/` folder moved under `ai-docs/web-agent/`.
  `decisions/`, `specs/`, `plans/`, `extension-*/`, and loose
  status files stayed in place. Rollback: `git mv` back.
- **No context research files.** The 001-explore prompt asked for
  five context files (00-journey, 01-mixing, 02-acp-primer,
  03-pi-acp, 04-constraints) totalling 1500–2500 lines. Replaced by
  direct references to the cloned repos at their absolute paths —
  `agent-client-protocol/schema/schema.json`, `docs/protocol/`,
  `pi-acp/src/acp/*`. This is the user's explicit direction ("just
  the steering docs, refer to cloned repo for acp, and pi-acp
  adapter, instead of ingesting and summarizing in this repo").
- **Transport interface shape deferred.** Steering and principles
  commit to swappability as a requirement but do **not** pre-commit
  to the interface shape (`send/onMessage/close` vs duplex
  async-iterator). The M0.b plan settles it.
- **Milestone previews drafted this turn.** Eight preview files
  (index + M0–M7). Each ≤150 lines; non-committal; no plan-level
  detail.
- **File numbering.** Steering docs use `00/01/02/04` to mirror
  web-agent's convention and muscle memory; `03` remains reserved.
- **Milestone count.** Eight milestones (M0 split into M0.a/M0.b;
  M7 flagged as potentially splittable into polish + extract).
  Web-agent had twelve (M0–M11); the collapse reflects features
  like "RPC scaffold" being folded into the ACP framing at M0.b,
  and "vault mount + tools" being split between M0.a and M2.
- **`AGENTS.md` untouched.** Existing rules (no `any`, no inline
  imports, `npm run check` gate, PR workflow) apply unchanged.

## Questions asked

1. **"How should I handle the existing web-agent steering docs?"**
   → Answer: move the current ones to `ai-docs/web-agent/` and
   create new steering docs in `ai-docs/web-acp/steering/`.
   (Selected option effectively: "dual-track" variant with the
   active tree under `ai-docs/web-acp/`.)
2. **"Which deliverable shape?"** → Answer: just the steering
   docs; reference the cloned ACP + pi-acp repos instead of
   ingesting/summarising.
3. **"Move scope + milestones?"** → Answer: move only the 4 top
   steering docs + `milestones/` folder; draft web-acp milestone
   previews.
4. **"Transport naming?"** → Answer: decide later (M0.b plan).

## Open questions deferred

Flagged here for the next prompt (likely `002-m0a.md`):

- **ACP library choice.** Depend on the reference TS impl (under
  `agent-client-protocol/src/`), vendor a subset into
  `packages/web-acp/src/acp/`, or hand-roll. Recommendation +
  sign-off at M0.a plan time.
- **Schema stability.** Anchor on `schema.json` only, or track
  `schema.unstable.json` (where tool-call annotations etc. may
  live). Settle at M0.a, revisit per-milestone.
- **Permission policy defaults.** Auto-allow read, prompt on
  write, per-tool, configurable. Settle before M0.a has any
  destructive-tool UI (may slip to M2 since M0.a has no tools).
- **Transport interface shape.** Settled at M0.b plan.
- **Extractable library name.** `@bodhiapp/bodhi-web-acp` is a
  placeholder. Settled at M7.
- **M0 test seed location.** Whether to reuse
  `packages/web-agent/e2e/data/sample-*/` or stand up a minimal
  web-acp-specific vault. Recommend reuse until web-agent-specific
  file names bleed through; settle at M0.a plan.

## M0.a, concretely — for go/no-go

The next prompt would implement this. Bullet-level scope so a
go/no-go decision is possible before the plan file is drafted:

- **Wire ZenFS + FSA into `packages/web-acp/`.** Port the mount
  lifecycle pattern from `bodhiapps/zenfs-browser` and web-agent's
  `packages/web-agent/src/worker-agent/fs/zenfs-provider.ts`
  (reference only — no copy). Vault handle persisted via
  `idb-keyval`; `requestPermission` re-grant on every load.
- **Vault UI.** Directory-picker button in the reference app; a
  VaultStatus indicator showing mounted path; a dev-seed boot hook
  (`useDevSeedBoot`) gated by `import.meta.env.DEV` for Playwright.
- **Inline agent.** `@mariozechner/pi-agent-core` Agent loop
  running on the main thread; `@mariozechner/pi-ai` provider
  adapter for whichever model the e2e uses. **No ACP framing
  yet** — this is deliberate and called out as the M0.a shortcut.
- **Reference chat UI.** Existing `create-bodhi-js` scaffold
  extended with an input + transcript view. Uses the shadcn
  components already present; no new UI deps.
- **`.env.test` wiring.** Copy `packages/web-agent/e2e/.env.test`
  (or its `.example` equivalent — verify which is committed) into
  `packages/web-acp/e2e/`. Document in `e2e/README` that real-LLM
  e2e needs the file present.
- **First real-LLM e2e.** One spec, one prompt, DOM-witness
  assertion on the streamed output. `test.step` per concern
  (mount, prompt, stream, done).
- **Gate.** `npm run check` clean (lint + typecheck).
  `npm run test:e2e` green in CI with `.env.test` credentials.
  `npm run check` at repo root extended to include web-acp.

Everything ACP-shaped — `initialize`, `session/new`, `session/prompt`,
the transport boundary, the Worker — deliberately lands at **M0.b**,
not M0.a. M0.a's job is to prove the non-ACP plumbing works;
M0.b's job is to introduce ACP against a known-good baseline.

## Exit criteria for 001-explore

- [x] All files under "Deliverables" exist and are internally
      consistent.
- [x] `CLAUDE.md` reflects the pivot; a fresh session reading it
      lands in web-acp, not web-agent.
- [x] `ai-docs/web-acp/milestones/index.md` links to every
      milestone file and shows a status board.
- [x] Completion report (this file) is written and answers "what's
      M0.a, concretely?".
- [x] No runtime code was added under `packages/web-acp/src/` or
      `packages/web-acp/e2e/`.
- [x] All to-do list items complete.
- [x] `AskUserQuestion` interactions summarised.
