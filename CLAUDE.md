# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project focus

Active initiative: **web-agent** at `packages/web-agent/` — a browser-native coding-agent harness, destined for extraction as `@bodhiapp/web-agent`.

Other `pi-*` packages (`ai`, `agent`, `coding-agent`, `mom`, `tui`, `web-ui`, `pods`) are upstream libraries we consume and occasionally patch. Do not extend them unless explicitly asked.

## Hard constraint

**`packages/web-agent/` must not depend on `packages/coding-agent`.** No imports, no workspace entry, nothing. web-agent is heavily influenced by coding-agent — we study its session shape, RPC schema, extension hooks, and tool "operations" pattern, and we port those patterns for the browser runtime. But coding-agent pulls node-only deps (`fs`, `child_process`, jiti, `pi-tui`) that break browser bundling and would block the Phase 6 extraction into `@bodhiapp/web-agent`. Copy the source, trim the node bits, accept the short-term duplication. `grep -r "pi-coding-agent\|packages/coding-agent" packages/web-agent/src/` must return zero.

## Steering docs (load on demand)

- @ai-docs/00-vision.md — vision
- @ai-docs/01-goals.md — capability checklist
- @ai-docs/02-architecture.md — RPC + ZenFS + FSA + extension sandboxing
- @ai-docs/milestones/index.md — status board with progressive-disclosure hooks
- @ai-docs/04-principles.md — working rules (read when a design choice is on the line)
- @ai-docs/decisions/index.md — append-only decisions log

Per-deliverable plans at `ai-docs/plans/*.md` are disposable; the files above are durable.

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
