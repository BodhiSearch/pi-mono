# web-agent steering docs + root CLAUDE.md

## Context

Phase 0 (workspace integration + Vite-warning fix) and Phase 1 (RPC-shaped agent scaffold under `packages/web-agent/src/web-agent/`) are landed and committed (`06d02b81`). The existing `ai-docs/decisions.md` at repo root captures four locked Phase 0/1 decisions.

Future sessions and contributors need to step in without re-discovering the project's north star. We want durable steering docs — vision, goals, architecture, phase roadmap, principles — that survive plan churn, plus a root `CLAUDE.md` that references them and carries the handful of principles that must shape every session's default behaviour.

Scope of the effort:
- web-agent = our primary project (building a browser-native coding-agent-style harness with RPC, ZenFS for its own storage via IndexedDB, Chrome File System Access API for user-mounted folders, extensions-driven customisation, and eventual publish as a reusable library for any web app).
- `ai-docs/` at repo root = the steering file set, **numbered-prefix** filenames for ordered reading.
- Existing `ai-docs/decisions.md` will be renamed to `ai-docs/05-decisions.md` to join the numbered set; it remains append-only.
- `CLAUDE.md` at repo root = the entry point — brief, references the steering docs, inlines only the handful of rules that must never be forgotten.

## User-locked decisions (Q&A)

| # | Decision | Choice |
|---|---|---|
| 1 | Root `CLAUDE.md` positioning of other pi-* packages | **web-agent-centric**; others treated as upstream we consume and occasionally patch, never extend. |
| 2 | Steering doc filenames | **Numbered prefixes** (`00-`, `01-`, …). Existing `decisions.md` renamed to `05-decisions.md` for consistency. |

## Files to create

### `ai-docs/00-vision.md`
North star. ~150 lines.
- **Problem**: web apps that want agentic capabilities over local user files need to rebuild the harness each time (session, compaction, streaming, tool-calling, extensions). No drop-in library exists.
- **Solution**: `web-agent` — a publishable, browser-native agent harness that any web app can embed to gain coding-agent-class capabilities over a ZenFS-backed filesystem, with extensions as the customisation surface.
- **Who it's for**: (a) this monorepo's BodhiApp integrations today, (b) any third-party web app that wants agentic workflows tomorrow.
- **What "done" looks like**: a separately-versioned `@bodhiapp/web-agent` package whose consumers wire it into their React tree, pick a folder, and get an agent.

### `ai-docs/01-goals.md`
Concrete capability checklist mirroring `coding-agent` feature set. ~200 lines.
- Session management: persist messages, fork from any entry, switch sessions, list sessions.
- Compaction: automatic context compaction with extension hooks.
- Turn control: steer, follow-up, abort, queue modes.
- Model switching: cycle model, set model, per-session thinking level.
- Extensions: downloadable, persisted in a dedicated ZenFS mount, sandboxed execution, hook surface covering `before/after tool call`, `turn start/end`, custom tools, custom commands, custom model providers.
- Skills: implemented *as* extensions — validates the extension surface is expressive enough.
- FS tools: read, write, edit, ls, glob, grep over the user-mounted vault.
- Storage: IndexedDB-backed mounts for session/chat/extension data. *No OPFS* (concurrent-tab corruption).
- Packaged as a standalone npm library with clean `peerDependencies` on React + pi-ai + pi-agent-core.

### `ai-docs/02-architecture.md`
Key architectural constraints and patterns. ~250 lines.
- **RPC-first boundary**: all UI ↔ agent traffic crosses a `Transport` that must be structured-clone-safe, so the agent can eventually live in a Web Worker without API churn.
- **ZenFS mounts**:
  - `/vault` — Chrome File System Access API (user's chosen folder), WebAccess backend.
  - `/extensions` — IndexedDB backend, persists downloaded extensions.
  - `/sessions` — IndexedDB backend, persists chat sessions.
- **Why IndexedDB over OPFS** (decision D3-ish, worth its own deep explanation): OPFS handles do not coordinate across tabs; concurrent writes from multiple open tabs can corrupt state. IndexedDB transactions serialise naturally.
- **Extension sandboxing**: each extension loaded in its own Web Worker; all capabilities go through a capability-gated RPC back to the host.
- **Testing seam**: `useDevSeedBoot()` gated by `import.meta.env.DEV` — Playwright injects `window.__zenfsSeed` via `addInitScript` so tests use an InMemory mount without the user-gesture-gated `showDirectoryPicker`.
- **Reference sources**: `packages/coding-agent` (architectural shape), `bodhiapps/zenfs-browser` (ZenFS mount + dev seed pattern). We *copy* patterns — we do NOT add a web-agent dependency on coding-agent.
- **Target shape at extraction (Phase 6)**: the entire `src/web-agent/` tree becomes a publishable package with minimal peer deps.

### `ai-docs/03-phase-plan.md`
Living roadmap. Updated as phases land. ~150 lines.

| Phase | Goal | Status | Commit | Tests added |
|---|---|---|---|---|
| 0 | Workspace integration + Vite-warning fix | ✅ done | `06d02b81` | (existing `chat.spec.ts` still green) |
| 1 | RPC-shaped scaffold under `src/web-agent/` + host-side useAgent rewire | ✅ done | `06d02b81` | 4 new vitest tests in `rpc.test.ts` |
| 2 | ZenFS `/vault` mount + FSA picker + dev-seed seam | planned | — | 1 new Playwright spec |
| 3 | FS tools (read/write/edit/ls/glob/grep) wired to the agent | planned | — | 1 new Playwright spec |
| 4 | Move `AgentSession` + tools into a Web Worker; swap Transport | planned | — | no new tests; existing must pass |
| 5 | Extensions system + skills-as-extensions + `/extensions` mount | planned | — | 1 new Playwright spec |
| 6 | Extract `src/web-agent/` into its own publishable package | planned | — | — |

Also documents:
- Gate at each phase: `npm run check` at root, web-agent unit + e2e green, no new `any`, no `// @ts-ignore`.
- Per-phase re-planning: full plan lives in `.cursor/plans/*.md`; phase-plan.md only carries the index + outcomes.

### `ai-docs/04-principles.md`
Working principles. ~100 lines.
- **TDD, black-box e2e**. Playwright spec files exercise the product through the UI; no `page.evaluate` / `page.exposeFunction` tricks that bypass the UI's own paths. Dev-mode seeds are explicitly allowed (they feed state in before render; they don't reach into runtime internals).
- **Few high-value e2e tests, many `test.step` assertions per test**. E2E is expensive — minimise count, maximise coverage inside each spec.
- **Unit tests earn their keep**. Test the RPC envelope, tool operations over ZenFS, extension lifecycle. Skip tests for trivial glue.
- **No dependency on `packages/coding-agent`**. We copy patterns (schemas, hook shapes, RPC dialect) and trim them to browser-safe equivalents. Otherwise extraction in Phase 6 becomes impossible.
- **Keep `src/web-agent/` self-contained**. Imports only flow from outside (the app) into `src/web-agent/`, never the other way. Any external dep the agent needs is a constructor argument, not a side-imported singleton.
- **Plans live in `.cursor/plans/`** — one per deliverable, disposable. Steering lives in `ai-docs/` — durable, evolving. Decisions live in `ai-docs/decisions.md` — append-only.
- **Ask when ambiguous**. Don't silently widen scope, don't silently skip tests, don't silently change file layout.

### `ai-docs/05-decisions.md`
**Renamed from `ai-docs/decisions.md`** via `git mv` to join the numbered set.
Content unchanged; still append-only.

## Root `CLAUDE.md` (new file)

~80 lines. Structure:

```markdown
# CLAUDE.md

Guidance for Claude Code sessions in this repository.

## Project focus

This fork of pi-mono is driven by one active initiative: **web-agent** — a
browser-native coding-agent harness eventually publishable as a standalone
library. Existing `pi-*` packages (ai, agent, coding-agent, …) are upstream
libraries we consume and occasionally patch; we do not extend them.

## Steering docs (read these first, in order)

- **Vision**: @ai-docs/00-vision.md — what we're building and why
- **Goals**: @ai-docs/01-goals.md — concrete capability checklist
- **Architecture**: @ai-docs/02-architecture.md — RPC + ZenFS + FSA shape, extension sandboxing
- **Phase plan**: @ai-docs/03-phase-plan.md — roadmap and current status
- **Principles**: @ai-docs/04-principles.md — how we work
- **Decisions log**: @ai-docs/05-decisions.md — append-only architectural decisions

Per-deliverable implementation plans live at `.cursor/plans/*.md` and are
disposable; the steering docs above are durable.

## Core values for every session

1. **web-agent has no dependency on packages/coding-agent.** Copy patterns,
   don't import. Phase 6 extraction depends on this invariant.
2. **Storage is IndexedDB, not OPFS.** OPFS has concurrent-tab corruption
   issues we are not accepting.
3. **Black-box e2e, minimal count, rich `test.step` per test.** No
   `page.evaluate` tricks. Dev-mode seed seams are OK.
4. **`src/web-agent/` only imports inward.** No app-specific imports reaching
   in; external deps enter as constructor arguments.
5. **Ask before widening scope.** Silent scope creep breaks the phased plan.

## Dev commands

[brief summary of `npm run dev`, `test`, `test:e2e`, `check`, with both root
and package-level invocations]

## Reference projects

- `bodhiapps/zenfs-browser` — ZenFS mount + dev-seed Playwright pattern we
  mirror for fs testing.
- `packages/coding-agent` — architectural reference for the agent harness.
```

## Out of scope for this plan

- Per-package CLAUDE.md files (e.g. `packages/web-agent/CLAUDE.md`). The root
  file covers web-agent fully at this stage; add a package-scoped file only
  when the scope diverges enough to warrant it.
- Updating existing `decisions.md` content (it's append-only by convention —
  only the filename changes, via `git mv`).

## Verification

- `ai-docs/` lists exactly: `00-vision.md`, `01-goals.md`, `02-architecture.md`, `03-phase-plan.md`, `04-principles.md`, `05-decisions.md`.
- `git log --follow ai-docs/05-decisions.md` still traces history back to the
  original `packages/web-agent/ai-docs/decisions.md` → `ai-docs/decisions.md` →
  `ai-docs/05-decisions.md` rename chain.
- `CLAUDE.md` at repo root renders @-references to all six steering docs.
- A fresh Claude session opened at the repo root can answer "what is the
  active project in this fork?" and "where do I find the phase roadmap?" by
  reading CLAUDE.md alone.
- No code changes; no test or build commands affected. `npm run check` at
  root still green (CLAUDE.md and ai-docs/*.md are not linted by biome per
  `biome.json` includes).
