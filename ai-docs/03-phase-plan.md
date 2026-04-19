# Phase plan — web-agent roadmap

Living document. Updated as each phase lands.

The per-phase **implementation plan** lives at `ai-docs/plans/*.md` — one file per phase, disposable. This document only keeps the index and the outcomes.

## Status board

| Phase | Goal | Status | Commit | Tests added |
|---|---|---|---|---|
| 0 | Workspace integration + Vite-warning fix | ✅ done | `06d02b81` | — (existing `chat.spec.ts` still green) |
| 1 | RPC-shaped agent scaffold under `src/web-agent/` + useAgent rewire | ✅ done | `06d02b81` | 4 vitest round-trip tests in `src/web-agent/rpc/rpc.test.ts` |
| 2 | ZenFS `/vault` mount + FSA picker + dev-seed testing seam | planned | — | +1 Playwright spec |
| 3 | FS tools (`read`, `write`, `edit`, `ls`, `glob`, `grep`) wired to the agent | planned | — | +1 Playwright spec, tool-level vitest |
| 4 | Move `AgentSession` + tool execution into a Web Worker; swap Transport | planned | — | existing tests must stay green |
| 5 | Extension system + skills-as-extensions + `/extensions` + `/sessions` mounts + session persistence, compaction, fork | planned | — | +1 Playwright spec, extension lifecycle vitest |
| 6 | Extract `src/web-agent/` → `@bodhiapp/web-agent` publishable package | planned | — | existing tests stay green under the extracted package |

## Per-phase outcome summaries

### Phase 0 — workspace integration + Vite-warning fix (done, `06d02b81`)

What landed:

- `packages/web-agent` aligned with monorepo (typescript `^5.9.2`, `@types/node ^22.10.5`, `@mariozechner/{pi-ai,pi-agent-core}` as `"*"` for workspace symlinks).
- Vite no longer emits warnings about `packages/ai`'s node-only lazy imports — `/* @vite-ignore */` hints added in the `pi-ai` source.
- Biome scoped out of `packages/web-agent`; root `tsgo --noEmit` skips it; root `build` and `check` invoke web-agent's own tooling.
- `ai-docs/` directory established at repo root with `decisions.md` (now renumbered to `05-decisions.md`) capturing D1–D4.
- Package `typecheck` script fixed from the dead `tsc --noEmit` (which checked zero files because `tsconfig.json` has empty `files`) to `tsc -b`.

### Phase 1 — RPC-shaped scaffold (done, `06d02b81`)

What landed:

- `packages/web-agent/src/web-agent/` tree established.
- `core/agent-session.ts` — thin wrapper over `pi-agent-core`'s `Agent` with a plain-data surface.
- `core/extensions/{types,registry}.ts` — minimal stubs, Phase 5 extends.
- `core/tools/index.ts` — empty stub, Phase 3 populates.
- `rpc/transport.ts` — the `Transport` interface.
- `rpc/transports/in-process.ts` — MessageChannel-backed pair.
- `rpc/rpc-types.ts` — `RpcCommand`/`RpcResponse`/`RpcEventEnvelope` schema.
- `rpc/rpc-server.ts` — dispatcher + exported `AgentSessionHost` interface.
- `rpc/rpc-client.ts` — typed promise + event-subscription client.
- `rpc/rpc.test.ts` — 4 round-trip tests against a fake session.
- `index.ts` — barrel.
- `hooks/useAgent.ts` rewired through `RpcClient`; public hook shape preserved so no component changed.

Surprises worth remembering (also captured inline in code/commit):

- `RpcServer` is retained automatically via the transport's event-listener closure — no module-level variable needed.
- `Omit<Union, K>` is non-distributive and drops per-variant fields; use a `DistributiveOmit` helper for RPC command payload types.
- `tsc --noEmit` at a package with only project references silently checks zero files — use `tsc -b`.

### Phase 2 — ZenFS `/vault` + FSA picker + dev-seed seam (planned)

Scope preview (full plan will live at `ai-docs/plans/phase-2-*.md` when drafted):

- Add `@zenfs/core`, `@zenfs/dom`, `idb-keyval` as `packages/web-agent` dependencies.
- `src/web-agent/fs/zenfs-provider.ts` — `mountVault(handle)` / `unmountVault()`, no React.
- `src/hooks/useDirectoryHandle.ts` — pick folder, persist handle in IndexedDB, re-grant permission on reload.
- `src/hooks/useDevSeedBoot.ts` — dev-mode-only seam; reads `window.__zenfsSeed`, mounts InMemory before React renders. Tree-shakes in prod.
- `e2e/helpers/install-vault.ts` — Node-side helper that walks `e2e/data/<name>/` and injects via `page.addInitScript`.
- Minimal UI: folder-picker button + vault-status indicator in header.
- +1 Playwright spec — seeds a 3-file vault, asserts the sidebar shows the files.

### Phase 3 — FS tools (planned)

- Port tool schemas from `packages/coding-agent/src/core/tools/{read,write,edit,ls,glob,grep}.ts` into `packages/web-agent/src/web-agent/core/tools/`, reusing the "operations" pattern but swapping node-fs ops for ZenFS ops.
- Register tools on `AgentSession` by default.
- +1 Playwright spec — seed a vault with `hello.txt`, ask the agent to read it and write a derived file, assert file contents in the (still InMemory) seeded FS.
- Tool-level vitest for each operation adapter.

### Phase 4 — Web Worker transport (planned)

- Move `AgentSession` + tool execution into a Worker spawned from the app.
- Swap `createInProcessTransportPair()` for a `createWorkerTransportPair()` backed by a Worker + MessagePort.
- Decide mount location for ZenFS handles — main thread + proxy vs. Worker-side mount (see `02-architecture.md` open questions).
- No new tests; existing Playwright + vitest must stay green.

### Phase 5 — extensions, sessions, compaction, fork (planned)

Biggest phase. Intentionally grouped: extensions provide the hook surface that compaction/fork customisation *uses*, so building them together avoids rework.

- `/extensions` and `/sessions` ZenFS mounts (IndexedDB backends).
- Extension loader: download manifest + bundle, persist to `/extensions/<name>/`, instantiate in a Worker, wire RPC-backed capability channel.
- Port the full extension event surface from `coding-agent/src/core/extensions/types.ts`, trimmed to browser-safe pieces.
- Session persistence: write JSONL to `/sessions/<id>/messages.jsonl`.
- Compaction with extension hooks.
- Fork: create new session with inherited history up to an entry id.
- Skill-as-extension example: a single skill ships as an extension, validating the extension surface is expressive enough.
- +1 Playwright spec — install a "uppercase-echo" extension, prompt the agent, verify the extension hook fires and mutates a tool output.

### Phase 6 — library extraction (planned)

- Move `packages/web-agent/src/web-agent/` into its own npm-publishable package (working name `@bodhiapp/web-agent`).
- Reshape `packages/web-agent/` into a reference app consuming the extracted package.
- Add architectural lint rule enforcing the "imports inward only" invariant.
- Existing tests must continue to pass against the consumer wiring without modification.

## Phase gate (every phase)

A phase is only "done" when all of these are true:

1. `npm run check` at repo root is green (biome, tsgo, `check:browser-smoke`, `web-ui check`, `web-agent check`).
2. `cd packages/web-agent && npm test` green.
3. `cd packages/web-agent && npm run test:e2e` green (the pre-existing `chat.spec.ts` plus any new spec the phase adds).
4. `cd packages/web-agent && npm run build` green.
5. No new `any`, no new `// @ts-ignore`, no new `// @ts-nocheck`, no `TODO: revisit`-without-tracking-note.
6. A paragraph in this document's "Per-phase outcome summaries" section describes what landed.

Skipping any of these breaks the phased contract. If a gate cannot be met for a real reason, document it as a decision in `05-decisions.md` — don't silently bypass.
