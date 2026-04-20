# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## Project focus

This fork of `pi-mono` is driven by one active initiative: **web-agent** — a browser-native coding-agent harness at `packages/web-agent/`, intended for eventual extraction into a standalone publishable library (`@bodhiapp/web-agent`).

The other `pi-*` packages (`ai`, `agent`, `coding-agent`, `mom`, `tui`, `web-ui`, `pods`) are **upstream libraries we consume and occasionally patch.** We do not extend them. Cross-cutting fixes like Phase 0's `/* @vite-ignore */` hints in `packages/ai` are fine; adding new features to those packages is out of scope unless explicitly requested.

## Steering docs — read in order

- **Vision**: @ai-docs/00-vision.md — what we're building and why
- **Goals**: @ai-docs/01-goals.md — capability checklist (with test seams)
- **Architecture**: @ai-docs/02-architecture.md — RPC + ZenFS + FSA shape, extension sandboxing
- **Milestones**: @ai-docs/milestones/index.md — status board + progressive-disclosure hooks to per-milestone files under `ai-docs/milestones/`
- **Principles**: @ai-docs/04-principles.md — how we work
- **Decisions log**: @ai-docs/05-decisions.md — append-only architectural decisions

Per-deliverable implementation plans live at `ai-docs/plans/*.md`. They are disposable and change with every session — the six files above are durable.

## Core values for every session

1. **web-agent has no dependency on `packages/coding-agent`.** Copy patterns, don't import. Phase 6 extraction depends on this invariant. Details: @ai-docs/04-principles.md #1.
2. **Storage is IndexedDB, not OPFS.** OPFS has concurrent-tab corruption issues we are not accepting. Details: @ai-docs/04-principles.md #2.
3. **`src/web-agent/` imports inward only.** No `@/…` or cross-package imports reaching in; external deps enter as constructor arguments. Details: @ai-docs/04-principles.md #3.
4. **Black-box e2e, minimal count, rich `test.step` per test.** No `page.evaluate` tricks that bypass the UI's own paths. Dev-mode seed seams (`useDevSeedBoot` + `page.addInitScript`) are the allowed priming mechanism. Details: @ai-docs/04-principles.md #4 and #5.
5. **Ask before widening scope.** If something needs doing outside the active plan's in-scope list, ask rather than quietly do. Details: @ai-docs/04-principles.md #8.

## Dev commands

At **repo root**:

```bash
npm install                 # install all workspaces (regenerates lockfile)
npm run build               # build all packages in dependency order
npm run check               # biome + tsgo + browser-smoke + web-ui + web-agent
npm test                    # vitest across workspaces --if-present
```

At **`packages/web-agent/`**:

```bash
npm run dev                 # vite dev server on :5173
npm run build               # tsc -b && vite build
npm test                    # vitest (unit)
npm run test:e2e            # Playwright, requires Bodhi server via global-setup
npm run check               # lint + typecheck (tsc -b — not tsc --noEmit, see M1 outcome notes in milestones.md)
```

At **`packages/ai/`** (occasional):

```bash
npx tsgo -p tsconfig.build.json
```

Do **not** run `npm run build` in `packages/ai` unless you specifically want to refresh `src/models.generated.ts` from live upstream APIs — that can break pre-existing `packages/ai/test/*.test.ts` when upstream removes a model. See memory `feedback_ai_build_model_regen`.

## Reference projects (read-only)

These are not dependencies; we study them to replicate proven patterns.

- **`bodhiapps/zenfs-browser`** — ZenFS mount lifecycle, FSA handle persistence + re-grant, and the Playwright dev-seed pattern we mirror for filesystem testing.
- **`packages/coding-agent`** — architectural reference for the agent harness (session shape, RPC schema, extension hook types, tool "operations" pattern). We copy patterns; we do not import.

## Where to write things

| Artefact | Location | Lifecycle |
|---|---|---|
| Durable steering (vision, goals, architecture, milestones, principles, decisions) | `ai-docs/*.md` | Durable; edit in place (decisions are append-only) |
| Architectural decisions log | `ai-docs/05-decisions.md` | Append-only |
| Per-deliverable implementation plans | `ai-docs/plans/*.md` | Disposable per session; gitignored is off (`!ai-docs/plans/` in `.gitignore`) so can be committed if useful |
| Auto-memory | `~/.claude/projects/-Users-amir36-…/memory/` | Cross-session, scoped to this repo |
| Code | `packages/web-agent/src/**` | Committed |

## Dead ends to avoid (short list)

- Do not add imports from `packages/coding-agent` into `packages/web-agent/src/web-agent/`. That tree must stay extractable.
- Do not reach for OPFS. See core value #2.
- Do not pass function references or class instances through the RPC transport. Structured-clone only. See @ai-docs/02-architecture.md "The Transport boundary."
- Do not silence `npm run check` failures with `// @ts-ignore`, `any`, or `test.skip`. See @ai-docs/04-principles.md #9.
- Do not assume `cd packages/web-agent && npm run typecheck` on the old `tsc --noEmit` script catches real errors — the project-references tsconfig makes it check zero files. Always `tsc -b` for the authoritative typecheck.
