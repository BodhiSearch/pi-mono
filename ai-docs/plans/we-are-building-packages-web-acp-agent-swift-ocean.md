# Plan — per-package CLAUDE.md + `/review` slash command

## Context

We are building **`@bodhiapp/web-acp-agent`** as a future-publishable
ACP-native agent runtime, with several active host runtimes
(`web-acp` browser, `ws-acp-client` WebSocket backend, `tutorial-cli-client`
TTY) and an ACP-compliant frontend (`acp-ui`). AI coding assistants churn
out large feature batches (e.g. HEAD commit `067bed6a` — M6 phase 0–14
extensions, ~9.5k LOC, 122 files). We squash, then review ad-hoc.

Two problems make those reviews slow and inconsistent today:

1. **Context is lost between sessions.** Reviewer agents have no
   per-package CLAUDE.md to anchor on; they re-derive the architecture
   each time and miss our **conscious ACP divergences** (agent-owned FS,
   `_bodhi/*` namespacing, etc.) — repeatedly flagging them as bugs.
2. **No reusable review pipeline.** BodhiApp has `/review` for its Rust
   crates; we have nothing comparable for this TS monorepo.

This plan adds:

- Five package-level `CLAUDE.md` files (web-acp-agent, web-acp,
  tutorial-cli-client, ws-acp-client, acp-ui) + an `ai-docs/web-acp/CLAUDE.md`
  orientation.
- A small repo-root CLAUDE.md update marking `cli-acp-client` frozen and
  pointing at the new `/review` command.
- A `.claude/commands/review.md` slash command modelled on BodhiApp's
  but adapted to TS layer boundaries, ACP compliance posture, and the
  user's review workflow (squashed feature commits → per-package
  findings → human triage → fix plan).

The user's review priorities, in order:

1. **Clean architecture** (most important — complexity escalates fast).
2. **Test coverage** (regression-proof + new-feature coverage).
3. **Holistic look** at the change (cross-package consistency, public
   API drift, spec drift).
4. **Comment hygiene** (only WHY-comments stay).
5. **Actionable findings** (what's wrong + how to fix; **never** "what's
   right").

---

## Target deliverables

### 1. `.claude/commands/review.md` — the slash command

Adapts BodhiApp's `/review` to this repo. Key differences from upstream:

- **Scope default:** `HEAD` (the most recent squashed feature commit),
  not staged files. The user's workflow squashes before review.
- **Layer mapping:** packages-based instead of crates-based.
- **ACP compliance is a first-class checklist item.** Reviewers must
  read [`ai-docs/web-acp/web-acp-vs-standard-acp/`](../web-acp/web-acp-vs-standard-acp/)
  before flagging FS-ownership, `_bodhi/*` namespacing, or
  `clientCapabilities` divergences.
- **Spec/code drift is a first-class layer.** Per the change-procedure
  rule in `specs/web-acp-agent/index.md`, every code change must update
  the matching spec file in the same commit; reviewer flags missing
  updates.
- **Output dir:** `ai-docs/web-acp/reviews/<ref>/` (per user choice).
- **Tone:** findings only — no "things done well" sections.

### 2. Per-package CLAUDE.md files

Each is short (50–120 lines) and follows the same shape:

```
# <package> — agent guide

## Mission           # one-line + one paragraph: what this package is and isn't
## Hard constraints  # 4–8 bullets: the rules that, if broken, are bugs
## Public surface    # entry points + public API location
## Where to look     # spec pointer + key folders + reference impls
## Dev commands      # check / test / e2e / dev (host-specific)
## Footguns          # past surprises, not recipes
## When NOT to add code here  # neighbour packages + frozen archives
```

The five packages get bespoke content per their constraints (browser-only
vs node-only vs transport-agnostic). The `ai-docs/web-acp/CLAUDE.md`
orients on the doc tree itself (steering vs specs vs plans vs milestones
vs prompts vs reviews).

### 3. Root CLAUDE.md edit

Two-line update:

- Mark `packages/cli-acp-client/` **frozen** alongside `packages/web-agent/`
  in the existing "frozen reference" prose. No per-package CLAUDE.md
  there per user decision.
- Reference the new `/review` slash command under "Dev commands".

---

## Files to create

| Path | Purpose | Approx LOC |
|---|---|---|
| `.claude/commands/review.md` | The `/review` command | ~250 |
| `packages/web-acp-agent/CLAUDE.md` | Agent runtime guide | ~120 |
| `packages/web-acp/CLAUDE.md` | Browser host guide | ~100 |
| `packages/ws-acp-client/CLAUDE.md` | WebSocket backend guide | ~80 |
| `packages/tutorial-cli-client/CLAUDE.md` | CLI tutorial guide | ~70 |
| `acp-ui/CLAUDE.md` | Vue ACP-client frontend guide | ~70 |
| `ai-docs/web-acp/CLAUDE.md` | Doc-tree orientation | ~60 |

## Files to edit

| Path | Edit |
|---|---|
| `CLAUDE.md` (repo root) | Add `cli-acp-client` to frozen list; add `/review` to dev-commands section. |

---

## Detailed shape of `.claude/commands/review.md`

### Header

- Usage forms: `/review` (= `HEAD`), `/review HEAD~3..HEAD`, `/review <sha>`,
  `/review --staged`, `/review --output-dir <path>`.
- Inputs section mirroring BodhiApp.

### Step 0 — Determine scope

- Default ref: **`HEAD`** (override: `--staged` or explicit ref/range).
- Run `git diff <range> --name-only` to get the file list.
- If empty, stop and tell the user.

### Step 1 — Classify into layers

```
agent          packages/web-acp-agent/src/**
agent-tests    packages/web-acp-agent/src/**.test.ts + test-utils/**
agent-examples packages/web-acp-agent/examples/**
web-acp        packages/web-acp/src/**
web-acp-e2e    packages/web-acp/e2e/**
ws-acp-client  packages/ws-acp-client/src/**
ws-acp-e2e     packages/ws-acp-client/e2e/**
tutorial-cli   packages/tutorial-cli-client/src/**
tutorial-e2e   packages/tutorial-cli-client/e2e/**
acp-ui         acp-ui/src/**
docs           ai-docs/web-acp/**
```

`packages/cli-acp-client/` and `packages/web-agent/` are **frozen** —
flag any modifications there as a finding ("touching a frozen package")
rather than running a full review.

Skip layers with zero changed files.

### Step 2 — Load context per affected layer

Per layer, load:

- Repo root `CLAUDE.md`
- The package's `CLAUDE.md`
- For `agent`: `ai-docs/web-acp/specs/web-acp-agent/index.md` + the
  topic file matching the changed area (e.g. extensions touched →
  `extensions.md`).
- For `web-acp`: `ai-docs/web-acp/specs/web-acp-client/index.md` + matching topic.
- For `ws-acp-client` / `tutorial-cli` / `acp-ui`: package CLAUDE.md only
  (no per-package living spec yet — note this explicitly so reviewer
  doesn't hallucinate one).
- For `docs`: `ai-docs/web-acp/steering/00-vision.md` +
  `02-architecture.md` + `04-principles.md` + `web-acp-vs-standard-acp/`.
- **Always**: `ai-docs/web-acp/web-acp-vs-standard-acp/` — the
  divergence register. Reviewers must check known-divergence list
  before flagging an ACP compliance issue.

### Step 3 — Launch one review agent per affected layer (parallel)

Use the `Explore` subagent type (read-only). Each agent gets a layer-
specific checklist embedded in its prompt and writes findings to
`ai-docs/web-acp/reviews/<ref>/<layer>.md`.

### Step 4 — Layer-specific checklists

#### `agent` (web-acp-agent/src/)

Architecture:
- [ ] No browser-only deps (`@zenfs/dom`, `idb-keyval`, `dexie`, `MessagePort`,
  `Worker`, `FileSystemDirectoryHandle`, `navigator.storage`, `window.*`).
- [ ] No node-only deps (`fs`, `child_process`, `path`, `node:*`).
- [ ] No React anywhere.
- [ ] No imports from `packages/web-acp/`, `packages/ws-acp-client/`,
  `packages/tutorial-cli-client/`, `packages/web-agent/`,
  `packages/coding-agent/`. Agent is upstream-only.
- [ ] Wire surface: any new ACP request/notification is registered in
  `wire/index.ts` constants and matches the schema (or is `_bodhi/*`-prefixed
  with rationale per `steering/04-principles.md` § 15).
- [ ] Per-handler files under `acp/handlers/` (one method per file or
  one tightly-scoped group).
- [ ] Engine layer separation: `acp/engine/` contains lifecycle/runtime;
  no leakage from `agent/` runtime concerns into the wire shim.
- [ ] Storage interfaces (`SessionStore`, `PreferenceStore`,
  `VolumeRegistry`) stay host-pluggable — no Dexie / SQLite / FSA
  dependencies inside the package.
- [ ] Public barrel `src/index.ts` updated for new public symbols, and
  the matching entry in `specs/web-acp-agent/index.md` § "Public surface"
  reflects the addition.
- [ ] Test-only surface (`AcpAgentAdapter`, etc.) stays in
  `test-utils/index.ts`, not the production barrel.

ACP compliance:
- [ ] New methods either (a) match a stable ACP method by exact shape, or
  (b) ride `_bodhi/*` namespace with reasoning and a row in
  `specs/web-acp-agent/extensions.md` or `commands.md`.
- [ ] `_meta._bodhi/*` keys on standard ACP responses follow the prefix
  rule.
- [ ] No bespoke RPC channel introduced. If the change introduces one,
  block.

Tests:
- [ ] Vitest: unit test per new pure function / module added.
  Round-trip tests for any new wire shape.
- [ ] No `any`, no `@ts-ignore`, no skipped tests without a decision
  entry.
- [ ] Test fixtures live in `test-utils/` if reused across files.

Comments:
- [ ] No `// added for X` / `// used by Y` / `// fix #N` comments —
  belongs in commit message.
- [ ] No multi-paragraph docstrings on internal helpers.
- [ ] Comments explain WHY (constraint, invariant, surprise) — never
  WHAT.

Spec drift (if `agent` files changed):
- [ ] Matching topic file under `specs/web-acp-agent/` updated in same
  commit. If not, flag.
- [ ] If new module/folder added, an entry exists in `index.md`
  navigation table.
- [ ] If module deleted, the topic file is removed.

#### `agent-examples`

- [ ] Each new extension has a `README.md` (origin / what it
  demonstrates / when to delete).
- [ ] Single-file `index.js` (no build step in examples).
- [ ] Doesn't reach into agent internals — uses only the public
  `pi.*` extension API surface.
- [ ] Naming consistent with `extensions.md` example inventory.

#### `web-acp`

Architecture:
- [ ] No imports from `packages/web-acp-agent/src/internal paths` —
  only public barrel `@bodhiapp/web-acp-agent` and `/test-utils` (test
  files only).
- [ ] No imports from `packages/web-agent/`, `packages/coding-agent/`,
  `packages/cli-acp-client/`, `packages/ws-acp-client/`,
  `packages/tutorial-cli-client/`.
- [ ] Storage adapters stay in `runtime/storage-dexie/` — no Dexie
  imports in `acp/`, `hooks/`, `components/`.
- [ ] Transport boundary: framing imports nothing from `Worker` /
  `MessagePort` outside `runtime/transport/`.
- [ ] Hooks: StrictMode-safe (singletons module-scoped, idempotent
  effects). No second worker spawned on double-mount.

Tests:
- [ ] Playwright: new feature has at least one `test.step` in the
  matching spec.
- [ ] No `page.waitForTimeout` in new specs — wait on `data-test-state`
  attributes per `steering/04-principles.md` § 7.
- [ ] No `page.evaluate` reaching into ZenFS / transport / runtime
  internals.
- [ ] Components carrying state expose `data-testid` and
  `data-test-state`.
- [ ] Vitest unit tests for pure modules (reducers, selectors,
  composers).

Spec drift:
- [ ] Matching topic file under `specs/web-acp-client/` updated in same
  commit.

#### `ws-acp-client`

Architecture:
- [ ] No imports from `packages/web-acp/`, `packages/tutorial-cli-client/`.
- [ ] Doesn't pull browser-only deps (`@zenfs/dom`, `idb-keyval`,
  `dexie`, etc.).
- [ ] WebSocket transport boundary: framing imports nothing from
  business logic.
- [ ] SQLite/Drizzle storage adapter is the only DB-aware code; agent
  runtime is unaware.
- [ ] Auth/credential handling: tokens never logged or persisted to
  disk plaintext without an explicit decision.

Tests:
- [ ] New backend behaviour has a vitest unit + a Playwright e2e step.
- [ ] E2E uses real BodhiApp via global-setup (no mocks for the LLM
  round-trip).

#### `tutorial-cli-client`

Architecture:
- [ ] Embeds the agent in-process via `@bodhiapp/web-acp-agent`'s
  public barrel — no internal-path imports.
- [ ] No browser-only deps.
- [ ] Tutorial code stays readable — clarity over cleverness, since
  this package serves as the "how do I host the agent in Node" reference.

Tests:
- [ ] Playwright e2e covers new commands and the OAuth flow if touched.

#### `acp-ui`

Architecture:
- [ ] **Speaks generic ACP** — no `_bodhi/*` knowledge unless explicitly
  scoped to a Bodhi-specific feature; if introduced, document the
  divergence.
- [ ] Vue/Pinia state separated from transport.
- [ ] Doesn't assume agent identity (any ACP-compliant agent should
  work behind it).

Tests:
- [ ] Unit tests for stores / composables touched.

#### `docs`

- [ ] No contradictions with `steering/00-vision.md`,
  `steering/02-architecture.md`, or `steering/04-principles.md`.
- [ ] If a divergence is introduced, an entry exists in
  `web-acp-vs-standard-acp/`.
- [ ] Plans match the actual implementation in the matching commit
  (no drift).
- [ ] Milestone status board updated when a milestone closes.
- [ ] Reference to a removed file or symbol does not survive the
  commit.

#### Cross-cutting (always run after per-layer agents)

- [ ] If `agent` and a host changed: types align (host imports
  resolve against the new agent surface).
- [ ] New wire method registered in `agent` AND advertised by at least
  one host in the commit (or has a decision entry deferring host
  adoption).
- [ ] `web-acp-vs-standard-acp/` updated for any new conscious
  divergence.
- [ ] No layer's e2e suite was disabled or `.skip`ed without a
  decision entry.

### Step 5 — Generate index

Write `ai-docs/web-acp/reviews/<ref>/index.md`:

```
# Review — <ref> (<short message>)

## Scope
- Ref: <ref>
- Date: <date>
- Files: N across L layers
- Layers: <list>

## Summary
- Total findings: N
- Critical: N | Important: N | Nice-to-have: N

## Critical (blocks merge)
| # | Layer | File | Location | Issue | Fix | Report |

## Important (should fix)
| # | Layer | File | Location | Issue | Fix | Report |

## Nice-to-have (future)
| # | Layer | File | Location | Issue | Fix | Report |

## Spec / code drift
| # | Code change | Spec to update | Status | Report |

## Test coverage gaps
| # | Layer | New behaviour | Test missing | Report |

## Suggested fix order
1. agent fixes (run: `cd packages/web-acp-agent && npm run check && npm test`)
2. host fixes (run host-specific check + test + e2e where applicable)
3. spec updates (no command — review by eye)
4. cross-cutting

## Reports
- <list of per-layer report paths>
```

### Step 6 — Per-finding shape (each layer report)

```markdown
# <Layer> Review

## Files Reviewed
- `path/file.ts` (N lines) — what it is

## Findings

### Finding N: <Title>
- **Priority**: Critical | Important | Nice-to-have
- **File**: `path/file.ts`
- **Location**: `functionName` / `ClassName.method` / module-level
- **Issue**: What's wrong (1–3 sentences).
- **Recommendation**: What to do (specific — exact rename, exact import
  to remove, exact test to add).
- **Rationale**: Why it matters (constraint / principle / past incident).

## Summary
- Findings: N (Critical: N, Important: N, Nice-to-have: N)
```

### Step 7 — Important rules embedded in the command

- **Review only.** Never modify source.
- **Don't flag conscious ACP divergences.** Read
  `ai-docs/web-acp/web-acp-vs-standard-acp/` first.
- **Don't flag formatter-handled style** (Biome/Prettier/ESLint) — `npm
  run check` enforces it.
- **Don't flag pre-existing issues** the diff didn't touch.
- **Don't flag missing tests for unchanged code.** Only new behaviour.
- **Use method/symbol names in `Location`**, not line numbers.
- **No "things done well" prose.** Findings only. If a layer has none,
  one-line clean-report.

---

## Detailed shape of each per-package CLAUDE.md

The repo-root `CLAUDE.md` already carries vision, ACP-only rule,
transport-swap rule, IndexedDB-not-OPFS rule, and high-level dev
commands. Per-package files **don't repeat** that — they layer on
package-specific constraints.

### `packages/web-acp-agent/CLAUDE.md`

Sections (drafted content described — not full text):

1. **Mission.** Transport-agnostic ACP agent runtime. Future-publishable
   as `@bodhiapp/web-acp-agent`. Hosted by `web-acp` (browser),
   `ws-acp-client` (WebSocket), `tutorial-cli-client` (TTY).
2. **Hard constraints.** No browser-only deps; no node-only deps; no
   React; ACP is the wire; structured-clone safe; no imports from any
   sibling package; storage interfaces stay host-pluggable.
3. **Public surface.** `src/index.ts` is the only barrel. Test-only
   surface at `src/test-utils/index.ts`. Anything else is internal.
4. **Where to look.** `ai-docs/web-acp/specs/web-acp-agent/` is the
   living spec — read the matching topic file before changing code.
5. **Dev commands.** `npm run check`, `npm test`. (No e2e at this layer
   — exercised via host packages.)
6. **Footguns.** ACP SDK pinned at 0.21.0 — `unstable_*` methods may
   reshape; check the SDK before reaching for one. Data-URL extension
   loader (not blob URL) — portability across browser/worker/Node.
   `_bodhi/*` namespace required for extension methods (principle 15).
7. **When NOT to add code here.** UI rendering, transport bytes,
   FS-backend implementations, host auth flows. Those belong in the
   matching host package.

### `packages/web-acp/CLAUDE.md`

1. **Mission.** Browser host. Vite + React + Web Worker bundle.
   Reference application for `web-acp-agent`. Will be the M11
   library-extraction target.
2. **Hard constraints.** Doesn't import from `web-agent`,
   `coding-agent`, `cli-acp-client`, `ws-acp-client`,
   `tutorial-cli-client`. Storage = IndexedDB (not OPFS). One worker
   per tab. Test seams = `data-testid` + `data-test-state` (no
   `waitForTimeout`).
3. **Public surface.** None yet — reference app, not a published
   library. Future `@bodhiapp/bodhi-web-acp` package extracted from
   `acp/` + `runtime/` + `agent/agent-worker.ts`.
4. **Where to look.** `ai-docs/web-acp/specs/web-acp-client/` (per-topic
   files for transport, hooks, storage-dexie, volumes, mcp, etc.).
5. **Dev commands.** `npm run dev`, `npm test`, `npm run test:e2e`,
   `npm run check`. **Run `test:e2e` at end of feature, not after each
   edit.**
6. **Footguns.** StrictMode double-mount (singletons must be
   module-scoped). FSA handles aren't JSON-serialisable (volume control
   sidechannel uses raw `postMessage`, not ACP). Real-LLM e2e (`.env.test`
   credentials).
7. **When NOT to add code here.** Agent runtime logic, ACP wire types,
   per-session lifecycle. Those belong in `web-acp-agent`.

### `packages/ws-acp-client/CLAUDE.md`

1. **Mission.** WebSocket backend host. Embeds `web-acp-agent`,
   exposes it over `ws://` so `acp-ui` (Vue Tauri/web frontend) can
   connect.
2. **Hard constraints.** No browser-only deps. Storage =
   SQLite/Drizzle (server-side; node-native is fine). Token handling
   never logs secrets. Doesn't import from sibling host packages.
3. **Public surface.** CLI binary `ws-acp-client`; `src/index.ts`
   re-exports for tests. Not yet a published library.
4. **Where to look.** No living spec yet — package CLAUDE.md is the
   reference. Add a `specs/ws-acp-client/` folder when surfaces grow.
5. **Dev commands.** `npm run dev`, `npm run test:e2e`, `npm run check`.
6. **Footguns.** WebSocket transport must frame ACP JSON-RPC 2.0 the
   same way other transports do — no bespoke envelope.
7. **When NOT to add code here.** UI work, agent-runtime logic, ACP
   wire types.

### `packages/tutorial-cli-client/CLAUDE.md`

1. **Mission.** Hands-on tutorial CLI. Demonstrates how to embed
   `web-acp-agent` in a Node TTY host. Replaces the now-frozen
   `cli-acp-client/` pattern.
2. **Hard constraints.** Embeds the agent in-process. Public-barrel
   imports only. No browser-only deps. Code stays readable —
   tutorial-grade clarity.
3. **Public surface.** Bin entry `cli.ts`. `src/index.ts` re-exports
   for tests.
4. **Where to look.** `ai-docs/cli-acp-client/guide/` (carry-over docs
   pre-rename — TODO once tutorial-cli-client gets its own doc folder).
5. **Dev commands.** `npm run dev`, `npm run test:e2e`, `npm run check`.
6. **Footguns.** Same auth flow as web-acp's e2e (real BodhiApp via
   `@bodhiapp/app-bindings`). Settings persist plaintext to `$cwd/.tutorial-cli-client/`.
7. **When NOT to add code here.** Browser/UI work, agent-runtime logic.

### `acp-ui/CLAUDE.md`

1. **Mission.** Vue 3 + Pinia + Tauri (and web build) generic ACP
   client UI. Connects to a `ws-acp-client` backend. Frontend partner
   for the WS host. Forked upstream and modified for our quirks.
2. **Hard constraints.** Speaks **generic ACP** — no `_bodhi/*`
   business logic unless explicitly scoped (and documented). UI
   separated from transport via Pinia stores.
3. **Public surface.** Tauri/web app — not a library.
4. **Where to look.** `agent-client-protocol/docs/protocol/` for
   protocol concepts. Local `README.md` for upstream/fork notes.
5. **Dev commands.** `npm run dev`, `npm run build`, plus Tauri
   commands as needed. (Test surface to be added — note that today
   there is no test command.)
6. **Footguns.** ACP SDK version may differ from `web-acp-agent`'s
   pin (currently `^0.13.1` here, `0.21.0` in the agent). Bumping in
   lockstep is a separate decision.
7. **When NOT to add code here.** Agent-runtime logic, server work.

### `ai-docs/web-acp/CLAUDE.md`

1. **Mission.** Doc tree orientation. Where to write what.
2. **Tree.** `steering/` (durable, edit-in-place) — vision, goals,
   architecture, principles. `specs/` (living, source-of-truth contracts
   per package) — must be edited alongside source per the change-procedure
   rule. `milestones/` (status board + per-milestone files). `plans/`
   (per-milestone implementation plans, written before the work).
   `prompts/` (per-phase AI-assistant briefings, archived after the
   phase). `reviews/` (the new `/review` output). `web-acp-vs-standard-acp/`
   (divergence register).
3. **Rules.** Steering durable, decisions append-only. Specs MUST be
   updated in the same commit as the matching code. Milestones not
   completed are previews, not commitments.
4. **When NOT to write here.** Per-session scratch (lives in plans/),
   running commentary (lives in commit messages or PR descriptions).

---

## Verification

End-to-end test of the deliverable (after files land):

1. `git -C /Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono show --stat HEAD` confirms HEAD is the M6
   extensions commit.
2. Run `/review` with no args (defaults to `HEAD`).
3. Inspect `ai-docs/web-acp/reviews/HEAD/index.md` and per-layer
   reports.
4. Spot-check that the reports:
   - Do **not** flag agent-owned FS, `_bodhi/*` namespacing,
     `clientCapabilities: {}`, or other documented divergences.
   - **Do** flag any new `any`, `@ts-ignore`, `waitForTimeout`,
     `page.evaluate`-into-internals, missing test for new public symbol,
     or missing spec update.
   - Provide actionable recommendations (specific file + symbol +
     change), not vague critiques.
5. Re-run `/review HEAD~1..HEAD` and confirm range parsing works.
6. Re-run `/review --staged` after staging a small change and confirm
   the staged path works.

Per-package CLAUDE.md sanity check:

- `cat packages/web-acp-agent/CLAUDE.md` — file exists, sections
  present.
- For each new CLAUDE.md, the "Where to look" pointers are valid
  (paths exist).

---

## Out of scope

- Deleting `packages/cli-acp-client/` — user wants to keep it as
  reference for now; just marking frozen.
- Authoring living specs for `ws-acp-client`, `tutorial-cli-client`,
  `acp-ui` — those are package-CLAUDE-only for now; specs land when the
  surface stabilises.
- Bumping `acp-ui`'s ACP SDK to match `web-acp-agent`'s — separate
  decision.
- Wiring the `/review` command into CI — manual invocation only for
  now.
- Generating any review report for HEAD as part of this plan — that's
  the verification step, not a deliverable.
