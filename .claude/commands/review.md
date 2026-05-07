# /review

Perform a thorough code review of recent commits, validating architecture,
ACP compliance, test coverage, spec drift, and comment hygiene. Produces
per-layer review files and a consolidated index.

## Usage

```
/review                          # Review HEAD (most recent squashed commit — the default workflow)
/review HEAD~3..HEAD             # Review last 3 commits
/review <sha>                    # Review a specific commit
/review --staged                 # Review currently staged files
/review --output-dir <path>      # Custom output dir (default: ai-docs/web-acp/reviews/<ref>)
```

## Inputs

```yaml
required: none (defaults to HEAD)
optional:
  - ref: git ref, SHA, or range (default: HEAD)
  - --staged: use git diff --cached instead of a ref
  - --output-dir: override the default output directory
```

## Instructions

### Step 0: Determine scope

Parse `$ARGUMENTS`:
- No arguments → `git diff HEAD~1..HEAD --name-only`
- `--staged` → `git diff --cached --name-only`
- Explicit ref/SHA → `git diff <ref>~1..<ref> --name-only`
- Range (`HEAD~3..HEAD`) → `git diff <range> --name-only`
- `--output-dir <path>` → use that path instead of default

If the file list is empty, stop and tell the user.

Output dir: `ai-docs/web-acp/reviews/<ref>/` where `<ref>` is the short
SHA for a single commit, the range string for ranges, or `staged` for
`--staged`. Override with `--output-dir`.

### Step 1: Classify files into layers

```
agent          packages/web-acp-agent/src/**   (excludes *.test.ts, test-utils/)
agent-tests    packages/web-acp-agent/src/**/*.test.ts
               packages/web-acp-agent/src/test-utils/**
agent-examples packages/web-acp-agent/examples/**
web-acp        packages/web-acp/src/**
web-acp-e2e    packages/web-acp/e2e/**
ws-acp-client  packages/ws-acp-client/src/**
ws-acp-e2e     packages/ws-acp-client/e2e/**
tutorial-cli   packages/tutorial-cli-client/src/**
tutorial-e2e   packages/tutorial-cli-client/e2e/**
acp-ui         acp-ui/src/**
docs           ai-docs/web-acp/**
specs          ai-docs/web-acp/specs/**
```

**Frozen packages** — if any diff file matches `packages/cli-acp-client/**`
or `packages/web-agent/**`, record a Critical finding: "Modification to
frozen package" in a `frozen.md` report, then skip those files from all
other reviews.

Skip layers with zero changed files.

### Step 2: Load context

For every affected layer, load these files before writing any findings:

**Always load (all layers):**
- `CLAUDE.md` (repo root)
- `AGENTS.md`
- `ai-docs/web-acp/web-acp-vs-standard-acp/m2.md` and any other files
  in that folder — **the divergence register**. Read this before flagging
  any ACP compliance issue. The following divergences are documented and
  accepted; do NOT flag them:
  - Agent-owned FS (no `fs/read_text_file` / `fs/write_text_file` in
    the bash tool path; `clientCapabilities: {}`).
  - `_bodhi/*`-namespaced extension methods (principle 15 — not a
    divergence, an additive extension).
  - System-prompt volume advertisement instead of ACP capability.
  - Permission bridge deferred.

**Per layer:**

| Layer            | Extra context to load                                                                                                                                                                  |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`          | `packages/web-acp-agent/CLAUDE.md` + `ai-docs/web-acp/specs/web-acp-agent/index.md` + any topic file (e.g. `extensions.md`, `volumes.md`, `commands.md`) that covers the changed area. |
| `agent-tests`    | Same as `agent`.                                                                                                                                                                       |
| `agent-examples` | `packages/web-acp-agent/CLAUDE.md` + `ai-docs/web-acp/specs/web-acp-agent/extensions.md` § example inventory.                                                                          |
| `web-acp`        | `packages/web-acp/CLAUDE.md` + `ai-docs/web-acp/specs/web-acp-client/index.md` + matching topic file.                                                                                  |
| `web-acp-e2e`    | `packages/web-acp/CLAUDE.md` + `ai-docs/web-acp/steering/04-principles.md` § 7–8.                                                                                                      |
| `ws-acp-client`  | `packages/ws-acp-client/CLAUDE.md`. No living spec yet — note this in the report header.                                                                                               |
| `ws-acp-e2e`     | `packages/ws-acp-client/CLAUDE.md`.                                                                                                                                                    |
| `tutorial-cli`   | `packages/tutorial-cli-client/CLAUDE.md`.                                                                                                                                              |
| `tutorial-e2e`   | `packages/tutorial-cli-client/CLAUDE.md`.                                                                                                                                              |
| `acp-ui`         | `acp-ui/CLAUDE.md`.                                                                                                                                                                    |
| `docs`           | `ai-docs/web-acp/CLAUDE.md` + `ai-docs/web-acp/steering/00-vision.md` + `02-architecture.md` + `04-principles.md`.                                                                     |

### Step 3: Launch one review agent per affected layer (parallel)

Use `Explore` subagent type (read-only). Each agent:
1. Reads the diff for its layer files.
2. Reads the full content of each changed file.
3. Checks its layer-specific checklist (Step 4).
4. Writes findings to `<output_dir>/<layer>.md`.

If a layer has zero findings, write a single-line clean report.
**No "things done well" prose — findings only.**

### Step 4: Layer-specific checklists

#### Layer: `agent`

**Architecture**
- [ ] No browser-only deps: `@zenfs/dom`, `idb-keyval`, `dexie`,
  `MessagePort`, `Worker`, `FileSystemDirectoryHandle`,
  `navigator.storage`, `window.*`.
- [ ] No node-only deps: `fs`, `child_process`, `path`, `node:fs`,
  `node:path`, `node:*`.
- [ ] No React imports.
- [ ] No imports from sibling packages: `packages/web-acp`,
  `packages/ws-acp-client`, `packages/tutorial-cli-client`,
  `packages/web-agent`, `packages/coding-agent`. Agent is upstream-only.
- [ ] Wire surface: any new ACP method or notification is registered in
  `wire/index.ts` as a named constant (never inline strings at call sites).
  New methods either (a) match a stable ACP schema method, or (b) ride
  `_bodhi/*` namespace with an entry in the relevant spec file.
- [ ] Engine / wire shim separation: `acp/handlers/` owns the wire
  surface; `acp/engine/` owns session lifecycle. No `session-runtime.ts`
  or `prompt-driver.ts` logic leaking into a handler file, and vice versa.
- [ ] Storage interfaces (`SessionStore`, `PreferenceStore`,
  `VolumeRegistry`) stay host-pluggable — no Dexie / SQLite / FSA
  concrete types inside `packages/web-acp-agent/src/`.
- [ ] New public symbols appear in `src/index.ts` AND the matching
  `specs/web-acp-agent/index.md` § "Public surface" entry.
- [ ] New test-only symbols appear in `src/test-utils/index.ts` (never
  in the production barrel).

**ACP compliance**
- [ ] New `_bodhi/*` method: registered constant in `wire/index.ts`,
  Zod schema in `acp/engine/ext-methods/schemas.ts`,
  handler in its own `ext-methods/<name>.ts` file, row in the
  `specs/web-acp-agent/extensions.md` or `commands.md` table.
- [ ] No bespoke side-channel introduced outside the documented
  volume-control rawPostMessage (for FSA handle transfer, which is
  explicitly documented as a host-level exception).
- [ ] `_meta._bodhi/*` keys on standard ACP responses follow the
  `_bodhi/` prefix rule.

**Tests**
- [ ] Every new exported pure function or module has at least one vitest unit test.
- [ ] New wire shapes have a round-trip test.
- [ ] No `any`, no `@ts-ignore`, no `test.skip` without a comment
  pointing to a decision entry.
- [ ] Reusable test fixtures live in `test-utils/` not copy-pasted per file.

**Comments**
- [ ] No `// added for X` / `// used by Y` / `// fix for #N` comments.
- [ ] No multi-line docstring blocks on internal helpers.
- [ ] All retained comments explain WHY (constraint, invariant, or
  non-obvious workaround) — never WHAT.

**Spec drift**
- [ ] Matching topic file under `ai-docs/web-acp/specs/web-acp-agent/`
  updated in the same commit when agent source changes.
- [ ] If a new module or subfolder was added, `index.md` navigation
  table has a new row.
- [ ] If a module was deleted, its topic file is removed.

#### Layer: `agent-examples`

- [ ] Each example has a `README.md` (origin / what it demonstrates /
  phase reference).
- [ ] Single-file `index.js` — no build step.
- [ ] Uses only the public `pi.*` extension API (no internal imports).
- [ ] Named consistently with the example inventory in
  `specs/web-acp-agent/extensions.md`.

#### Layer: `web-acp`

**Architecture**
- [ ] Imports from `@bodhiapp/web-acp-agent` go through the public
  barrel — no `../../web-acp-agent/src/internal/path` imports.
- [ ] `@bodhiapp/web-acp-agent/test-utils` imports only inside test files.
- [ ] No imports from `packages/web-agent`, `packages/coding-agent`,
  `packages/cli-acp-client`, `packages/ws-acp-client`,
  `packages/tutorial-cli-client`.
- [ ] Storage adapters stay in `runtime/storage-dexie/` — no Dexie
  imports in `acp/`, `hooks/`, or `components/`.
- [ ] Transport boundary: nothing in `acp/` or `hooks/` imports from
  `Worker` or `MessagePort` directly — those live in
  `runtime/transport/`.
- [ ] StrictMode-safe: singletons are module-scoped (`ensureRuntime`
  pattern), effects are idempotent.

**Tests**
- [ ] New feature has at least one Playwright `test.step` in the
  matching e2e spec.
- [ ] No `page.waitForTimeout` — wait on `data-test-state` attributes.
- [ ] No `page.evaluate` reaching into ZenFS internals, transport, or
  ACP client.
- [ ] Stateful components expose `data-testid` and `data-test-state`.
- [ ] Pure modules (reducers, composers, helpers) have vitest units.

**Spec drift**
- [ ] Matching topic file under `ai-docs/web-acp/specs/web-acp-client/`
  updated in the same commit when host source changes.

#### Layer: `web-acp-e2e`

- [ ] No `page.waitForTimeout`.
- [ ] No `page.evaluate` reaching into internals.
- [ ] Uses `test.step` for logical grouping.
- [ ] Filesystem state primed only via `page.addInitScript` +
  `window.__zenfsSeed` (the `useDevSeedBoot` seam) — no other
  channel.
- [ ] DEV-only feature flags (`forceToolCall`) used to drive
  deterministic LLM behaviour — not `page.evaluate`.

#### Layer: `ws-acp-client`

- [ ] No imports from `packages/web-acp` or
  `packages/tutorial-cli-client`.
- [ ] No browser-only deps (`@zenfs/dom`, `idb-keyval`, `dexie`).
- [ ] WebSocket transport framing has no business logic; business logic
  has no transport primitives.
- [ ] SQLite/Drizzle are the only DB-aware code paths; agent runtime
  has no knowledge of them.
- [ ] Tokens never appear in logs. Credentials never persisted
  plaintext without an explicit decision entry.
- [ ] New behaviour covered by a vitest unit OR Playwright e2e step.

#### Layer: `tutorial-cli`

- [ ] Embeds the agent via the public barrel only (`@bodhiapp/web-acp-agent`).
- [ ] No browser-only deps.
- [ ] Code is tutorial-grade readable — no cleverness, no unexplained
  magic. If you'd need the spec to understand a line, simplify the line.
- [ ] New commands/flows covered by Playwright e2e.

#### Layer: `acp-ui`

- [ ] Speaks generic ACP — no `_bodhi/*` knowledge unless the feature
  is explicitly Bodhi-specific and documented.
- [ ] Vue/Pinia store logic separated from WebSocket transport.
- [ ] No assumption about a specific agent identity.
- [ ] Touched stores/composables have unit tests.

#### Layer: `docs`

- [ ] No document contradicts `steering/00-vision.md`,
  `steering/02-architecture.md`, or `steering/04-principles.md`.
- [ ] Any new conscious ACP divergence has an entry in
  `web-acp-vs-standard-acp/`.
- [ ] Plans (`plans/*.md`) match the implementation in the same commit —
  no "planned" items that are actually already landed, no landed items
  missing from the plan.
- [ ] Milestone status board updated when a milestone closes or shifts.
- [ ] No dangling references to deleted files, symbols, or method names.

#### Layer: `specs`

- [ ] any fundamental changes to web-acp-agent, should have ai-docs/web-acp/specs/web-acp-agent/ folder
  updated accordingly
- [ ] any fundamental changes to web-acp, should have ai-docs/web-acp/specs/web-acp/ folder updated accordingly

#### Cross-cutting (always run, after per-layer agents)

Run a single cross-cutting agent after all per-layer agents complete.
It reads all per-layer reports and checks:

- [ ] If `agent` and a host package both changed: new symbols exported
  by the agent are importable via the public barrel in the host's changed
  files.
- [ ] New wire method registered in `agent/wire/index.ts` AND at least
  one host in the same commit references it (or a decision entry explains
  the deferral).
- [ ] Any new conscious ACP divergence is reflected in
  `web-acp-vs-standard-acp/`.
- [ ] No layer's e2e suite has new `.skip` or `test.skip` calls without
  a decision entry justifying the skip.
- [ ] If `agent` added public symbols, `specs/web-acp-agent/index.md`
  was updated in the same commit.

### Step 5: Generate index file

Write `<output_dir>/index.md`:

```markdown
# Review — <ref>: <commit subject line>

## Scope
- **Ref**: <ref>
- **Date**: <YYYY-MM-DD>
- **Files changed**: N
- **Layers affected**: <comma-separated layer names>

## Summary
- Total findings: N
- Critical: N | Important: N | Nice-to-have: N

## Critical (blocks merge)
| #   | Layer | File | Location | Issue | Fix | Report |
| --- | ----- | ---- | -------- | ----- | --- | ------ |

## Important (should fix before next squash)
| #   | Layer | File | Location | Issue | Fix | Report |
| --- | ----- | ---- | -------- | ----- | --- | ------ |

## Nice-to-have (future)
| #   | Layer | File | Location | Issue | Fix | Report |
| --- | ----- | ---- | -------- | ----- | --- | ------ |

## Spec / code drift
| #   | Code change | Spec file to update | Status | Report |
| --- | ----------- | ------------------- | ------ | ------ |

## Test coverage gaps
| #   | Layer | New behaviour missing a test | Priority | Report |
| --- | ----- | ---------------------------- | -------- | ------ |

## Suggested fix order
1. `agent` findings → verify: `cd packages/web-acp-agent && npm run check && npm test`
2. `web-acp` findings → verify: `cd packages/web-acp && npm run check && npm test`
3. `ws-acp-client` findings → verify: `cd packages/ws-acp-client && npm run check`
4. `tutorial-cli` findings → verify: `cd packages/tutorial-cli-client && npm run check`
5. `acp-ui` findings → verify: `cd acp-ui && npm run build`
6. Spec updates (no command — review by eye against changed source)
7. E2E (run per-host once all code fixes are in):
   - web-acp: `cd packages/web-acp && npm run test:e2e`
   - ws-acp-client: `cd packages/ws-acp-client && npm run test:e2e`
   - tutorial-cli: `cd packages/tutorial-cli-client && npm run test:e2e`

## Reports
- <per-layer report paths>
```

### Step 6: Per-finding shape in layer reports

```markdown
# <Layer> Review

## Files Reviewed
- `path/to/file.ts` (N lines) — one-line purpose

## Findings

### Finding N: <Title>
- **Priority**: Critical | Important | Nice-to-have
- **File**: `path/to/file.ts`
- **Location**: `functionName` / `ClassName.method` / `module-level export`
- **Issue**: What's wrong (1–3 sentences; specific).
- **Recommendation**: What to do (specific — exact symbol to rename,
  exact import to remove, exact test assertion to add, exact type to
  narrow).
- **Rationale**: Why it matters (which constraint / principle /
  past incident).

## Summary
- Findings: N (Critical: N, Important: N, Nice-to-have: N)
```

If a layer has no findings:

```markdown
# <Layer> Review — Clean

N files reviewed. No findings.
```

### Step 7: Rules the review agent must follow

- **Read only.** Never modify source or docs.
- **Read the divergence register first.** The following divergences are
  documented and accepted; do NOT flag them:
  - Agent-owned FS (`clientCapabilities: {}`, bash tool bypasses `fs/*`).
  - System-prompt volume descriptors (not an ACP capability).
  - `_bodhi/*` namespaced extension methods (principle 15 — additive, not divergent).
  - Permission bridge deferred (tracked in milestones/deferred.md).
- **Don't flag formatter-handled style.** `npm run check` (ESLint /
  Prettier / tsc) enforces it — don't duplicate those catches.
- **Don't flag pre-existing issues.** Only code added or modified in
  this diff.
- **Don't flag missing tests for unchanged behaviour.** Only new
  behaviour.
- **Use symbol names in Location, not line numbers.** Line numbers go
  stale; symbol names don't.
- **No "things done well" prose.** Findings only. If clean, say so
  in one line and stop.
- **Findings must be actionable.** If there is nothing specific to
  change, don't write the finding.

### Step 8: Present summary to user

After all files are written, show the user:
- Layer reports generated (paths).
- Total findings (Critical / Important / Nice-to-have).
- Critical findings inline (one-line each), if any.
- Path to index.md.
