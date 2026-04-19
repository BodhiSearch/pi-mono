# Milestones — web-agent porting roadmap

Consolidated roadmap for porting `packages/coding-agent`'s feature set into `packages/web-agent/` under our browser/RPC/ZenFS constraints. Living document — updated as each milestone lands.

**Structure.** The status board below is the canonical one-line-per-milestone index. Each planned milestone has a short preview describing scope, coding-agent reference sources, key adaptations, and the test seam that gates completion. The preview is the *input* to writing a detailed per-milestone implementation plan at `ai-docs/plans/<milestone>.md`; the preview is not itself the plan.

**Process.** One milestone at a time: draft the per-milestone plan → implement → gate-check → commit → move to next. The [milestone gate](#milestone-gate) lists the checks every commit must pass.

## Status board

| #   | Milestone                                                                   | Status  | Commit     | Test seam added                                              |
| --- | --------------------------------------------------------------------------- | ------- | ---------- | ------------------------------------------------------------ |
| M0  | Workspace integration + Vite-warning fix                                    | ✅ done  | `06d02b81` | — (existing `chat.spec.ts` stayed green)                     |
| M1  | RPC-shaped agent scaffold + `useAgent` rewire                               | ✅ done  | `06d02b81` | 4 vitest round-trip tests in `src/web-agent/rpc/rpc.test.ts` |
| M2  | Vault mount: `/vault` via ZenFS + Chrome FSA picker + dev-seed testing seam | ✅ done  | `3f2f34b4`   | +1 Playwright spec (`vault-fs.spec.ts` M2)                   |
| M3  | Filesystem tools (read, write, edit, ls, glob, grep) wired to the agent     | ✅ done  | `3f2f34b4`   | +1 Playwright spec (`vault-fs.spec.ts` M3), 45 tool vitests  |
| M4  | Worker transport: `AgentSession` runs in a Web Worker                       | planned | —          | existing tests stay green                                    |
| M5  | Session persistence: `/sessions` IndexedDB mount, save / load / list        | planned | —          | +1 Playwright spec                                           |
| M6  | Session tree: fork from entry, switch sessions, branch navigation           | planned | —          | extend M5 spec or +1 new spec                                |
| M7  | Compaction: auto + manual, hook surface, result persistence                 | planned | —          | vitest + Playwright step                                     |
| M8  | Extensions + skills: loader, sandbox, hook surface, skills-as-extensions    | planned | —          | +1 Playwright spec, extension lifecycle vitest               |
| M9  | Resources: slash commands, prompt templates, themes through extensions      | planned | —          | vitest                                                       |
| M10 | Polish: HTML export, diagnostics, logging, debug traces                     | planned | —          | vitest                                                       |
| M11 | Library extraction: `@bodhiapp/web-agent` publishable package               | planned | —          | existing tests stay green under consumer wiring              |

**Deferred (post-v1):** shell / bash execution, multi-tab collaboration, RAG / embeddings, voice / audio. See [Deferred](#deferred-to-post-v1).

---

## Milestone previews

### M2 — Vault mount (ZenFS + FSA picker + dev-seed seam)

**Why first (among planned).** Every downstream milestone that touches files needs the mount. No fs capability in the product means no meaningful tools, no sessions, no extensions storage. The dev-seed seam is also a prerequisite for testing all future fs-dependent work without the user-gesture-gated picker.

**Scope preview.**
- Add `@zenfs/core`, `@zenfs/dom`, `idb-keyval` as `packages/web-agent` deps.
- `src/web-agent/fs/zenfs-provider.ts` — pure `mountVault(handle)` / `unmountVault()`, no React.
- `src/hooks/useDirectoryHandle.ts` — pick folder, persist handle in IndexedDB, re-grant permission on reload.
- `src/hooks/useDevSeedBoot.ts` — dev-mode-only seam reading `window.__zenfsSeed`, mounting InMemory ZenFS before React renders. Tree-shakes in production.
- `e2e/helpers/install-vault.ts` — Node-side helper walking `e2e/data/<name>/` and injecting via `page.addInitScript`.
- Minimal UI: folder-picker button + vault-status indicator.

**Coding-agent references.** No direct equivalent — node uses real fs. Architectural reference is `bodhiapps/zenfs-browser`.

**Gate.** Playwright spec seeds a 3-file vault, assertions confirm the file tree UI surfaces them.

### M3 — Filesystem tools

**Scope preview.**
- Port tool schemas from `packages/coding-agent/src/core/tools/{read,write,edit,ls,glob,grep}.ts`. Keep the "operations" dependency-injection pattern.
- Swap node-fs operations for ZenFS `fs.promises` operations. Both produce the same `AgentToolResult`.
- Register the six tools on `AgentSession` by default; host app passes the session's tools to `session.setTools(...)` on mount.
- Honor the coding-agent file-mutation-queue pattern from `packages/coding-agent/src/core/tools/file-mutation-queue.ts` to prevent write-races across concurrent tool calls.

**Coding-agent references.** `packages/coding-agent/src/core/tools/{read,write,edit,ls,glob,grep,file-mutation-queue}.ts`.

**Gate.** Playwright spec seeds vault with `hello.txt`, prompts the agent to read and transform, asserts the derived file's content. Tool-level vitest for each operation adapter against an InMemory ZenFS.

### M4 — Worker transport

**Why now.** Locks in structured-clone discipline before we add more state (sessions, compaction, extensions). Moving to a Worker later becomes a bigger rewrite the longer we wait.

**Scope preview.**
- Spawn an agent Worker from the app; instantiate `AgentSession` + RPC server inside.
- Implement `createWorkerTransportPair()` backed by a `Worker` + `MessagePort`, same `Transport` interface as `createInProcessTransportPair()`.
- Decide mount location for ZenFS handles: main thread + proxy vs. Worker-side mount. Benchmark + verify FSA handle transferability, record decision in `05-decisions.md`.
- Proxy-tool pattern: tools carrying closures become host-side stubs that RPC back to the main thread.

**Coding-agent references.** `packages/coding-agent/src/modes/rpc/rpc-mode.ts` for the stdio transport pattern — we mirror the dispatcher shape; the transport itself is ours.

**Gate.** All previously green tests stay green. No new functional tests — this is purely an architectural shift.

### M5 — Session persistence (`/sessions` mount)

**Scope preview.**
- ZenFS IndexedDB mount at `/sessions`.
- Layout: `/sessions/<id>/meta.json`, `/sessions/<id>/entries.jsonl` (append-only entry log).
- Entry types mirror coding-agent: user message, assistant message, tool call, tool result, model change, compaction entry, custom entry.
- RPC commands: `list_sessions`, `load_session`, `save_session`, `delete_session`, `set_session_name`.
- On app boot: auto-load most-recent session if present.

**Coding-agent references.** `packages/coding-agent/src/core/session-manager.ts` (file layout + entry types), `agent-session.ts` (persistence hooks on turn_end).

**Adaptations.** No file locks (IndexedDB transactions give us atomicity). No lockfile path. Concurrent-tab writes tolerated via IndexedDB serialisation.

**Gate.** Playwright spec: chat → reload page → session restored; list shows the session; rename, delete, re-chat.

### M6 — Session tree (fork, switch, branch navigation)

**Scope preview.**
- Fork: given an entry id, create a new session whose `parent` points to the source and whose `entries.jsonl` is a copy of the source's entries up to and including that id.
- Switch: load a different session in place. Abort any in-flight turn first.
- Branch summary entries: when forking mid-session, record a `BranchSummaryEntry` in both parent and child for traceability.
- RPC commands: `fork`, `switch_session`, `get_branches`.

**Coding-agent references.** `packages/coding-agent/src/core/session-manager.ts` (tree traversal, `BranchSummaryEntry`), `agent-session-runtime.ts` (switchSession, fork).

**Gate.** Playwright: start chat, fork mid-conversation, continue on fork, switch back to original, confirm both branches keep independent state.

### M7 — Compaction

**Scope preview.**
- Auto-compaction threshold: when context token estimate crosses a configurable percentage of the model's context window, compact.
- Manual compaction: explicit RPC command.
- Compaction uses the same model the session is on (so user doesn't pay to switch).
- Result persisted as a `CompactionEntry` in the session's `entries.jsonl`.
- Extension hook `session_before_compact` can block, replace, or mutate the compaction payload — depends on M8 landing first, *or* implemented as internal-only with the extension hook wired up when M8 lands.

**Coding-agent references.** `packages/coding-agent/src/core/compaction/compaction.ts`, `compaction/branch-summarization.ts`, `compaction/utils.ts`.

**Gate.** vitest asserting threshold triggers + entry persisted correctly. Playwright step confirming UI reflects compacted state (the chat view still renders coherently post-compaction).

### M8 — Extensions + skills

**Biggest milestone.** Intentionally grouped: extension hooks are the surface other milestones depend on (compaction hooks, custom tools, custom providers), so building them late means plumbing we didn't yet have when those landed.

**Scope preview.**
- `/extensions` ZenFS mount (IndexedDB backend).
- Extension manifest schema (TypeBox-based, matching how `pi-agent-core` tools already declare schemas).
- Loader: download manifest + bundle, persist to `/extensions/<name>/`, instantiate in a dedicated Web Worker, wire RPC-backed capability channel.
- Port the full extension event surface from `packages/coding-agent/src/core/extensions/types.ts`, trimmed to browser-safe pieces (drop terminal-UI concerns, drop `UserBashEvent`).
- Extension API: `on(event)`, `registerTool`, `registerCommand`, `registerProvider`, `sendMessage`, `sendUserMessage`.
- Manifest permissions: `fs:self`, `fs:vault` (requires user approval), `net:<origin>` allow-list.
- Skills-as-extensions: one reference skill shipped as an extension, validates surface expressiveness (matches goal K1–K4 in `01-goals.md`).

**Coding-agent references.** `packages/coding-agent/src/core/extensions/{types,runner,loader,wrapper}.ts` — copy types, wrapper runtime; *replace* the jiti-based loader with browser ES-module dynamic import inside a Worker.

**Adaptations.** No jiti, no filesystem-as-module-resolver. Extensions ship pre-compiled ESM. Each extension in its own Worker (isolation + termination). Host intermediates all capabilities — extensions have no direct DOM, fetch, or global access.

**Gate.** Playwright: install an `uppercase-echo` extension, prompt the agent, confirm the extension's `after_tool_call` hook fires and mutates the tool output. vitest covering extension lifecycle (install / load / reload / uninstall / permission denial).

### M9 — Resources (commands, prompts, themes)

**Scope preview.**
- Resource loader pattern: extensions can contribute slash commands, prompt templates, themes by declaring them in their manifest or calling `registerCommand`/`registerPromptTemplate`/`registerTheme` at load.
- Slash-command registry: builtin commands + extension-provided commands. `/command-name args...` from the chat input triggers the command handler.
- Prompt templates with frontmatter-style metadata (scope, variables, description) like coding-agent's but as ESM not YAML-in-filesystem.
- Theme registration optional for v1 (UI can ship with two built-in themes and defer custom themes).

**Coding-agent references.** `packages/coding-agent/src/core/{slash-commands,resource-loader,prompt-templates,skills}.ts`.

**Gate.** vitest covering: builtin `/help` works; extension-registered `/echo-extension` works; command with autocomplete suggestions.

### M10 — Polish (HTML export, diagnostics, logging)

**Scope preview.**
- HTML export: render a session to self-contained HTML (inline CSS, embedded images). Reuse coding-agent's `export-html/` logic (already mostly node-fs-free, just emits HTML).
- Diagnostics collection: pluggable event subscribers record timings, tool call latencies, model response sizes. Available via RPC command `get_diagnostics`.
- Debug log level: `RpcClient.setLogLevel('debug')` dumps the full event stream to console for easier triage.

**Coding-agent references.** `packages/coding-agent/src/core/export-html/*`, `diagnostics.ts`, `timings.ts`, `event-bus.ts`.

**Gate.** vitest for export HTML generation (smoke-level). Manual verification for diagnostics / logging.

### M11 — Library extraction

**Scope preview.**
- Move `packages/web-agent/src/web-agent/` into its own npm-publishable package (working name `@bodhiapp/web-agent`).
- Reshape current `packages/web-agent/` into a reference app consuming the extracted package.
- Add architectural lint rule enforcing the "imports inward only" invariant (principle #3).
- Peer deps: `react`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`.
- Existing Playwright specs run against the consumer wiring without modification — validates the public API is sufficient.

**Gate.** `npm run build` produces the package; `npm publish --dry-run` clean; all tests pass against the extracted form.

---

## Per-milestone outcome summaries

### M0 — Workspace integration + Vite-warning fix (done, `06d02b81`)

What landed:

- `packages/web-agent` aligned with monorepo (typescript `^5.9.2`, `@types/node ^22.10.5`, `@mariozechner/{pi-ai,pi-agent-core}` as `"*"` for workspace symlinks).
- Vite no longer emits warnings about `packages/ai`'s node-only lazy imports — `/* @vite-ignore */` hints added in the `pi-ai` source.
- Biome scoped out of `packages/web-agent`; root `tsgo --noEmit` skips it; root `build` and `check` invoke web-agent's own tooling.
- `ai-docs/` directory established at repo root with `decisions.md` (now `05-decisions.md`) capturing D1–D4.
- Package `typecheck` script fixed from the dead `tsc --noEmit` (empty `files` array in project-references tsconfig) to `tsc -b`.

### M1 — RPC-shaped scaffold (done, `06d02b81`)

What landed:

- `packages/web-agent/src/web-agent/` tree established.
- `core/agent-session.ts` — thin wrapper over `pi-agent-core`'s `Agent` with a plain-data surface.
- `core/extensions/{types,registry}.ts` — minimal stubs, M8 extends.
- `core/tools/index.ts` — empty stub, M3 populates.
- `rpc/transport.ts` — the `Transport` interface.
- `rpc/transports/in-process.ts` — MessageChannel-backed pair.
- `rpc/rpc-types.ts` — `RpcCommand` / `RpcResponse` / `RpcEventEnvelope` schema.
- `rpc/rpc-server.ts` — dispatcher + exported `AgentSessionHost` interface.
- `rpc/rpc-client.ts` — typed promise + event-subscription client.
- `rpc/rpc.test.ts` — 4 round-trip tests against a fake session.
- `index.ts` — barrel.
- `hooks/useAgent.ts` rewired through `RpcClient`; public hook shape preserved, components untouched.

Surprises worth remembering (also captured inline in code/commit):

- `RpcServer` is retained automatically via the transport's event-listener closure — no module-level variable needed.
- `Omit<Union, K>` is non-distributive and drops per-variant fields; use a `DistributiveOmit` helper.
- `tsc --noEmit` at a package with project-references tsconfig silently checks zero files — use `tsc -b`.

### M2 — Vault mount (done, this commit)

What landed:

- `@zenfs/core ~2.5.6`, `@zenfs/dom ~1.2.9`, `idb-keyval ^6.2.2` added as dependencies; `fake-indexeddb` added dev-side for vitest.
- `src/web-agent/fs/zenfs-provider.ts` — `mountVault(handle)`, `unmountVault()`, `isVaultMounted()`, `setMountedForSeed()`; pattern copied from `bodhiapps/zenfs-browser`.
- `src/web-agent/fs/path-utils.ts` — `resolveVaultPath()` + `VaultPathError`, with 12 unit tests covering relative/absolute/escape cases.
- `src/hooks/useDirectoryHandle.ts` — three-state (`empty`/`prompt`/`ready`) with idb-keyval persistence and `requestPermission` re-grant.
- `src/hooks/useDevSeedBoot.ts` — dev-only, reads `window.__zenfsSeed`, lazy-imports InMemory vault adapter. Tree-shakes in production.
- `src/fs/in-memory-vault.ts` — InMemory ZenFS adapter used exclusively by the dev-seed path. Module-level mount guard makes it idempotent (two React subtrees both call `useVaultMount` and we must not reconfigure the VFS mid-session).
- `src/hooks/useVaultMount.ts` — orchestrates seed-vs-handle; exposes `VaultMountStatus` + display name.
- `src/components/vault/VaultStatus.tsx` — `data-testid="vault-status"` badge + pick / re-grant / close buttons; wired into `<Header>`.
- `src/types/fsa.d.ts` — type augmentations for FSA permission methods (TypeScript's DOM lib still lacks them).
- `e2e/helpers/install-vault.ts` + `e2e/data/sample/*` + `e2e/tests/pages/VaultPage.ts` + `e2e/vault-fs.spec.ts` (M2 describe block) — Playwright seam proven end-to-end.

Surprises worth remembering:

- Two React subtrees both calling `useVaultMount` triggered a double-mount race that wiped agent writes mid-turn. Fixed with a module-level `mountPromise` guard in `in-memory-vault.ts`.
- `FileSystemDirectoryHandle.requestPermission` is not in TypeScript's DOM lib — ships a local `fsa.d.ts` augmentation.
- Jsdom has no `indexedDB`; `fake-indexeddb/auto` added to `src/test/setup.ts` so component tests that mount the full App (and therefore the vault hooks) do not throw on boot.

### M3 — Filesystem tools (done, this commit)

What landed:

- `src/web-agent/fs/zenfs-operations.ts` — per-tool operations adapters and a `createZenfsVaultOperations()` factory.
- `src/web-agent/core/tools/file-mutation-queue.ts` — per-path serialisation (pattern copied from coding-agent; `realpathSync` step dropped because ZenFS backends don't expose symlinks).
- `src/web-agent/core/tools/truncation.ts` — dual (lines + bytes) truncation helper.
- `src/web-agent/core/tools/{read,write,edit,ls,glob,grep}.ts` — schemas + `create*Tool({ operations, cwd })` factories. Schemas ported verbatim where possible; `grep` and `glob` re-implemented in pure JS (no ripgrep / fd subprocess available in browser) via minimatch + tree walk.
- `src/web-agent/core/tools/index.ts` — `createVaultTools(ops)` one-call factory returning `AgentTool[]`.
- `src/hooks/useVaultTools.ts` — returns the six tools when the vault is mounted, empty array otherwise.
- `src/components/chat/ChatDemo.tsx` — merges vault tools with MCP tools before passing to `useAgent`.
- `src/components/chat/ToolCallMessage.tsx` — added `data-testid="tool-call"` + `data-tool` + `data-teststate` for black-box assertions.
- `e2e/vault-fs.spec.ts` M3 describe block — full agent round-trip: seeded vault → prompt → agent calls `read` and `write` tools → derived file verified via the InMemory fs.
- Added `minimatch ^10.0.1` dependency for glob/grep pattern matching.

Surprises worth remembering:

- `TextDecoder` strips the BOM by default in UTF-8 mode, which broke `edit`'s BOM-preservation invariant. Pass `{ ignoreBOM: true }` to keep it in the decoded string.
- `AgentTool<Concrete>` is not a subtype of `AgentTool<TSchema>` in TS because `params: Static<TParams>` is a contravariant position that collapses under the broader `TSchema`. `createVaultTools` uses `as unknown as AgentTool[]` at the factory boundary; runtime safety is preserved because the agent loop validates arguments against `parameters` before dispatch.
- ESLint's `react-hooks/set-state-in-effect` rule flags synchronous `setState` inside effect bodies even for trivial cases. `useVaultMount` wraps all state transitions in awaited promise chains; don't short-circuit with a sync setState even when the rest of the effect is sync.

---

## Milestone gate

A milestone is only "done" when all of these are true:

1. `npm run check` at repo root is green (biome, tsgo, `check:browser-smoke`, `web-ui check`, `web-agent check`).
2. `cd packages/web-agent && npm test` green.
3. `cd packages/web-agent && npm run test:e2e` green (pre-existing `chat.spec.ts` plus any new spec the milestone adds).
4. `cd packages/web-agent && npm run build` green.
5. No new `any`, no new `// @ts-ignore`, no new `// @ts-nocheck`, no `TODO: revisit`-without-tracking-note.
6. A paragraph in this document's "Per-milestone outcome summaries" section describes what landed.

Skipping any item breaks the milestone contract. If a gate item cannot be met for a real reason, document it as a decision in `05-decisions.md` — don't silently bypass. See principle #9 in `04-principles.md`.

---

## Deferred to post-v1

**Shell / bash execution.** Browser has no process model. Post-v1 options:
- Extension that proxies to a user-run local helper (user opts in, runs a trusted binary locally).
- Web Worker-based JS evaluator bounded to `/vault` as a shell-adjacent tool.
- WebContainer-style in-browser Node runtime.

None of these block v1. An extension can add shell support when a user needs it.

**Multi-tab collaboration.** v1 is single-tab. IndexedDB-based storage tolerates concurrent tabs from a correctness standpoint (no corruption), but no explicit cross-tab sync is built.

**RAG / embeddings.** Can ship as an extension. Not core.

**Voice / audio modalities.** Outside the coding-agent shape. Out of scope.

---

## Coding-agent ↔ web-agent reference quick-index

| Area                     | Coding-agent source (read, don't import)                                                     | web-agent milestone                                       |
| ------------------------ | -------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Agent loop + session     | `packages/agent/src/agent.ts`, `packages/coding-agent/src/core/agent-session.ts`             | M1 (done)                                                 |
| Tool schemas             | `packages/coding-agent/src/core/tools/*.ts`                                                  | M3                                                        |
| Tool operations pattern  | Each tool's `create*Tool({ operations })` factory                                            | M3                                                        |
| File-mutation queue      | `packages/coding-agent/src/core/tools/file-mutation-queue.ts`                                | M3                                                        |
| RPC schema               | `packages/coding-agent/src/modes/rpc/rpc-types.ts`                                           | M1 (done), M5+ extend                                     |
| Session persistence      | `packages/coding-agent/src/core/session-manager.ts`                                          | M5                                                        |
| Session tree             | `packages/coding-agent/src/core/session-manager.ts`, `agent-session-runtime.ts`              | M6                                                        |
| Compaction               | `packages/coding-agent/src/core/compaction/*`                                                | M7                                                        |
| Extension types + runner | `packages/coding-agent/src/core/extensions/{types,runner,wrapper}.ts`                        | M8                                                        |
| Skills + resources       | `packages/coding-agent/src/core/{slash-commands,resource-loader,prompt-templates,skills}.ts` | M9                                                        |
| HTML export              | `packages/coding-agent/src/core/export-html/*`                                               | M10                                                       |
| Bash executor            | `packages/coding-agent/src/core/bash-executor.ts`, `tools/bash.ts`                           | deferred                                                  |
| TUI                      | `packages/coding-agent/src/modes/interactive/`                                               | not ported (React UI replaces)                            |
| Extension loader (jiti)  | `packages/coding-agent/src/core/extensions/loader.ts`                                        | replaced with browser ESM dynamic import in a Worker (M8) |
