# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project focus

Active initiative: **web-agent** at `packages/web-agent/` — a browser-native coding-agent harness. The worker-side runtime lives at `packages/web-agent/src/worker-agent/` and is the extraction target for the forthcoming `@bodhiapp/bodhi-web-agent` library; the enclosing `packages/web-agent/` folder is the reference app that consumes it.

Other `pi-*` packages (`ai`, `agent`, `coding-agent`, `mom`, `tui`, `web-ui`, `pods`) are upstream libraries we consume and occasionally patch. Do not extend them unless explicitly asked.

## Hard constraint

**`packages/web-agent/` must not depend on `packages/coding-agent`.** No imports, no workspace entry, nothing. web-agent is heavily influenced by coding-agent — we study its session shape, RPC schema, extension hooks, and tool "operations" pattern, and we port those patterns for the browser runtime. But coding-agent pulls node-only deps (`fs`, `child_process`, jiti, `pi-tui`) that break browser bundling and would block the Phase 6 extraction into `@bodhiapp/bodhi-web-agent`. Copy the source, trim the node bits, accept the short-term duplication. `grep -r "pi-coding-agent\|packages/coding-agent" packages/web-agent/src/worker-agent/` must return zero.

## Steering docs (load on demand)

- @ai-docs/00-vision.md — vision
- @ai-docs/01-goals.md — capability checklist
- @ai-docs/02-architecture.md — RPC + ZenFS + FSA + extension sandboxing
- @ai-docs/milestones/index.md — status board with progressive-disclosure hooks
- @ai-docs/04-principles.md — working rules (read when a design choice is on the line)
- @ai-docs/decisions/index.md — append-only decisions log
- @ai-docs/specs/README.md — top-level navigation across all module specs
- @ai-docs/specs/worker-agent/index.md — specs for `packages/web-agent/src/worker-agent/` (the extractable agent library)
- @ai-docs/specs/worker-bodhi/index.md — specs for `packages/web-agent/src/worker-bodhi/` (the concrete Bodhi auth provider)

Per-deliverable plans at `ai-docs/plans/*.md` are disposable; the files above are durable.

## Functional specs

`ai-docs/specs/` holds the living specs for the extractable worker-agent library and its concrete implementations. Each module has its own folder with an `index.md` entry point; topic files inside each folder combine the functional (what / why) and technical (how / where) views since splitting them leads to duplication and drift.

Conventions:

- Each module folder has `index.md` (overview, navigation, change procedure) and one file per topic / submodule.
- Technical content references files by **repo-relative paths** and symbols by **method / field name**, never line numbers.
- Specs are living documents. Changes to the code and changes to the matching spec ship together.

**Rule:** any plan that changes files under `packages/web-agent/src/worker-agent/` or `packages/web-agent/src/worker-bodhi/` MUST include an explicit task to update the matching topic file(s) before the plan is considered complete. The spec update is part of the change, not a follow-up. When the functional / technical surface is unchanged (pure internal refactor), state that explicitly in the plan rather than skipping the check.

Currently tracked:

| Folder | Spec |
| --- | --- |
| `packages/web-agent/src/worker-agent/` | `ai-docs/specs/worker-agent/` (see its `index.md` for the topic map) |
| `packages/web-agent/src/worker-bodhi/` | `ai-docs/specs/worker-bodhi/` (see its `index.md` for the topic map) |

## Dev commands

Repo root:

```bash
npm install                 # install all workspaces
npm run build               # build packages in dependency order
npm run check               # biome + tsgo + browser-smoke + web-ui + web-agent
npm test                    # vitest across workspaces --if-present
```

`packages/web-agent/`:

```bash
npm run dev                 # vite dev server on :5173
npm run build               # tsc -b && vite build
npm test                    # vitest (unit)
npm run test:e2e            # Playwright — requires Bodhi server via global-setup
npm run check               # lint + typecheck (uses tsc -b)
```

## Footguns

- **Authoritative typecheck is `tsc -b`, not `tsc --noEmit`.** The project-references tsconfig in `packages/web-agent/` makes `--noEmit` check zero files.
- **Do not run `npm run build` in `packages/ai`** unless you want to regenerate `src/models.generated.ts` from live upstream APIs — it can break existing tests when upstream removes a model. Use `npx tsgo -p tsconfig.build.json` for a TS-only rebuild.

## Reference projects (read-only, not dependencies)

- **`bodhiapps/zenfs-browser`** — ZenFS mount lifecycle, FSA handle persistence, dev-seed testing pattern.
- **`packages/coding-agent`** — architectural reference for session shape, RPC schema, extension hooks, tool "operations" pattern. Copy patterns, **do not import** (it pulls node-only deps that break browser bundling and block Phase 6 extraction).
