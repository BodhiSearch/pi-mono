# web-agent cleanup + extractability review

## Context

Before opening the next milestone (M6 or beyond), audit `packages/web-agent/src/web-agent/` against the Phase 6 extraction goal (`@bodhiapp/web-agent`): dead code, test gaps, configurability, and hidden coupling to the host app. Three Explore passes — architecture/dead-code, extractability, coverage/configurability — returned consistent findings: the tree is already 90 % clean; most outstanding items are small, mechanical, and worth landing as a single cleanup commit before feature work resumes.

The goal of this plan is to turn those findings into concrete edits, drop the few things that are actually dead, plug the configurability and coverage gaps that matter, and document what is intentionally deferred.

## Findings (what the Explore passes confirmed)

1. **Outbound imports are already clean.** No `@/…` path imports, no `packages/coding-agent`, no `packages/tui`. Principle #3 holds.
2. **Inbound sub-path imports (minor API creep).**
   - `packages/web-agent/src/providers/VaultProvider.tsx:38` imports from `@/web-agent/fs/zenfs-provider`.
   - `packages/web-agent/src/providers/WebAgentProvider.tsx:15` imports from `@/web-agent/worker/boot`.
   Both symbols are already re-exported by `src/web-agent/index.ts`; consumers can switch to the barrel.
3. **`package.json` mixes library + app deps.** `@milkdown/*`, `@bodhiapp/bodhi-js-react`, `@modelcontextprotocol/sdk`, `@radix-ui/*`, `lucide-react`, `sonner`, `next-themes`, `radix-ui`, `class-variance-authority`, `clsx`, `tailwind-merge` are declared as `dependencies` but never imported by `src/web-agent/**`. Blocks Phase 6 because the `@bodhiapp/web-agent` package would drag the host app's UI chain behind it.
4. **Dead / untouched scaffolding.**
   - `src/web-agent/core/extensions/{types,registry}.ts` is an M8 stub. `ExtensionRegistry` is exported from `index.ts` but never instantiated anywhere in the repo. Types are forward-compat; registry impl is placeholder-only.
   - `src/web-agent/core/tools/truncation.ts` exports `formatSize` and `TruncationResult`; only `truncateHead` is consumed (by `read.ts`).
   - `SessionManager.flush()` (`src/web-agent/core/session/session-manager.ts:420`) is a documented legacy no-op.
5. **Test coverage gaps (ranked by risk).**
   - `src/web-agent/fs/zenfs-operations.ts` — no direct unit test. Wraps every vault tool's filesystem side. Exercised e2e but no isolated regression surface.
   - `src/web-agent/fs/zenfs-provider.ts` — no direct unit test. Mount/unmount idempotency + in-flight guard matter; asserted only indirectly via the vault-fs e2e.
   - `src/web-agent/core/tools/ls.ts` — the only vault tool without a `.test.ts`.
   - `src/web-agent/core/agent-session.ts` — only covered transitively through `rpc.test.ts`.
6. **Configurability — hardcoded values that the library should accept as options.**
   - `VAULT_MOUNT = '/vault'` (`fs/zenfs-provider.ts:22`) — compile-time constant, re-imported by `worker-host.ts`, `path-utils.ts`, every vault tool via `createVaultTools()`.
   - `DEFAULT_CWD = '/vault'` in `core/session/session-manager.ts:44` — duplicated, same story.
   - `DEFAULT_DB_NAME = 'web-agent'` (`core/session/dexie-store.ts`) — the constructor already accepts a name, but `agent-worker.ts:58` calls `new DexieSessionStore()` without wiring it through boot.
   - `SENTINEL_API_KEY` placeholder (`worker/agent-worker.ts:26`). `AgentSession`'s `getApiKey` already covers real auth; the sentinel masks the fact that we have no real key path and should be removed.
7. **RPC command union is closed** (`src/web-agent/rpc/rpc-types.ts:19`). Intentional today; extensions (M8) will need an `ext_command` envelope. Not a blocker now — just wanted on record.
8. **React/Vite practice** — no regressions found. Module singletons in `worker/boot.ts` and `fs/zenfs-provider.ts` are StrictMode-safe via in-flight promise guards.

## Proposed fix — one commit, grouped by blast radius

Structure the work as small phases inside one commit. Each phase has its own gate (`npm run check` + `npm test` + `npm run test:e2e` at the end).

### Phase 1 — Drop dead exports (no behaviour change)

- Remove the `ExtensionRegistry` re-export from `src/web-agent/index.ts`. Keep `core/extensions/types.ts` (types are cheap + M8 wants the shape). Delete `core/extensions/registry.ts` — re-introduce when M8 lands with real manifest loading.
- Remove the Extension-related type re-exports from `index.ts` that nothing external consumes (`Extension`, `ExtensionAPI`, `ExtensionContext`, `ExtensionEventHandler`, `ExtensionFactory`, `ExtensionManifest`). Keep them exported only from `core/extensions/types.ts` so M8 can pull them back into the public surface when ready.
- Delete unused exports in `core/tools/truncation.ts` (`formatSize`, `TruncationResult`). Narrow the module to just `truncateHead` + its internal types; or inline into `read.ts` if it's still the only consumer.
- Delete `SessionManager.flush()` (`core/session/session-manager.ts:420`) and drop the accompanying `SessionManager — flush (legacy no-op)` test. Grep first to confirm no surviving callers — `worker-host.ts` previously called it; the Dexie swap made it unreachable.

### Phase 2 — Fix import hygiene on the outer app side

- `src/providers/VaultProvider.tsx:38` → import `{ isVaultMounted, mountVaultPort, unmountVault }` from `@/web-agent`.
- `src/providers/WebAgentProvider.tsx:15` → import `{ disposeAgentWorker, getAgentWorker }` from `@/web-agent`.
- These are already re-exported; no change to `index.ts` needed. Principle #3 held only because these sub-paths stayed inside the package, but closing them now keeps the public API the only seam.

### Phase 3 — Configurability (VAULT_MOUNT + DB name)

Small, high-value. The mount path and DB name become the first two real "options" a library consumer would want to pass.

- Introduce `WorkerAgentHostOptions` (`src/web-agent/worker/worker-host.ts`):
  ```ts
  export interface WorkerAgentHostOptions {
    vaultMount?: string;   // default '/vault'
    sessionsDbName?: string; // default 'web-agent' — forwarded to DexieSessionStore
  }
  ```
  Store as private fields; use `this.vaultMount` everywhere `VAULT_MOUNT` is referenced inside the host.
- Thread `vaultMount` through `createVaultTools()` (already takes `cwd` — just wire the constructor-provided value) and through `createZenfsVaultOperations()` where applicable.
- `fs/zenfs-provider.ts` keeps `VAULT_MOUNT = '/vault'` as the **default**, re-exported; the host uses its option and falls back to the constant.
- `src/web-agent/core/session/session-manager.ts:44` — replace `DEFAULT_CWD` usage with a value passed in by callers (the host already passes `VAULT_MOUNT`; remove the fallback so missing cwd is caller error, not silently defaulted).
- `agent-worker.ts` reads no options today. Extend `init-protocol.ts`'s `AgentWorkerInit` envelope with an optional `options` field (`vaultMount`, `sessionsDbName`) and plumb through `getAgentWorker()` → `createWorkerTransportPair()` → the Worker boot → `new WorkerAgentHost(session, vfsPort, store, options)`.
- Remove `SENTINEL_API_KEY` from `agent-worker.ts`. `AgentSession` already accepts a `getApiKey` option; pass `() => ''` (or omit) and let the stream path rely on `Authorization` + `x-api-key` headers set in `makeStreamFn`.

### Phase 4 — Close the test gaps that matter

- **`fs/zenfs-operations.test.ts`** (new). Mount an `InMemory` backend at a test path, run each operation (read/write/edit/ls/glob/grep) against seeded files, assert the adapter contract. Keeps the six vault tools honest even when their factories change.
- **`core/tools/ls.test.ts`** (new). Parity with existing tool tests (`read.test.ts`, `glob.test.ts`, etc.) — seeded tree, hidden-file handling, recursive option.
- **`fs/zenfs-provider.test.ts`** (new). Minimal: assert `mountVaultPort` is idempotent across overlapping calls (in-flight promise guard), `unmountVault` no-ops when nothing is mounted, `isVaultMounted` reports correctly. Uses the `Port.create` path only indirectly — focus on the guard + the public lifecycle, not the ZenFS internals.
- **`core/agent-session.test.ts`** (new). Construction, `setTools` / `setStreamFn` / `setAuthToken` + `getAuthToken`, `restoreMessages` + `reset`. One test per entry point; driven by the already-used fake-stream pattern from `rpc.test.ts` if needed.

Out of scope for this pass: `worker/boot.ts` + `worker/agent-worker.ts` — they run real Worker code that jsdom can't fake cleanly. Covered end-to-end via Playwright; documented instead of unit-tested.

### Phase 5 — Doc + decisions

- Append a short section to `ai-docs/02-architecture.md` enumerating the library-grade deps (`pi-ai`, `pi-agent-core`, `@zenfs/*`, `dexie`, `dexie-react-hooks`, `minimatch`, `@sinclair/typebox`, `react` peer) vs. app-grade deps (everything else currently in `packages/web-agent/package.json` `dependencies`). No `package.json` moves this pass — the extraction commit in Phase 6/M11 re-classifies, but the audit has to exist first.
- Add a decision record to `ai-docs/05-decisions.md`:
  - **D16** — Hardcoded `VAULT_MOUNT` promoted to constructor option (Phase 3).
  - **D17** — Extension scaffolding de-exported; M8 re-introduces with real implementation.
- Update `ai-docs/milestones.md` with a "Post-M5 cleanup" entry (not a new milestone; a documented cleanup) so the next session has the context without re-reading this plan.

## Out-of-scope (intentionally)

- **RPC command union extensibility.** Feature-bound to M8; plan the design there, not here.
- **Worker/boot unit tests.** Real Worker semantics + bundler-assisted URL construction don't mock cleanly; existing Playwright coverage is sufficient proof.
- **Actual Phase 6 extraction** (split `src/web-agent/` into `@bodhiapp/web-agent` + reference app). That's M11's job. This plan only removes the last cross-boundary import and documents the dep split so M11 is mechanical.
- **`SessionPicker` + `useAgent` live-read refactors.** Already landed with the Dexie swap; no follow-up needed.

## Critical files to modify

- `packages/web-agent/src/web-agent/index.ts` — narrow public API (drop `ExtensionRegistry` + type re-exports that M8 will re-add).
- `packages/web-agent/src/web-agent/core/extensions/registry.ts` — delete.
- `packages/web-agent/src/web-agent/core/tools/truncation.ts` — narrow or inline into `read.ts`.
- `packages/web-agent/src/web-agent/core/session/session-manager.ts` — drop `flush()` + `DEFAULT_CWD`.
- `packages/web-agent/src/web-agent/worker/worker-host.ts` — add `WorkerAgentHostOptions`, use `this.vaultMount` everywhere `VAULT_MOUNT` is referenced.
- `packages/web-agent/src/web-agent/worker/agent-worker.ts` — drop `SENTINEL_API_KEY`; consume options from the init envelope; forward `sessionsDbName` to `DexieSessionStore`.
- `packages/web-agent/src/web-agent/worker/init-protocol.ts` — widen `AgentWorkerInit` with `options`.
- `packages/web-agent/src/web-agent/worker/boot.ts` — accept + forward options (`getAgentWorker(devSeed?, options?)`).
- `packages/web-agent/src/web-agent/rpc/transports/worker.ts` — pass `options` into the init envelope.
- `packages/web-agent/src/web-agent/fs/zenfs-operations.ts` — accept a `mount` argument where the current code references `VAULT_MOUNT` transitively.
- `packages/web-agent/src/providers/VaultProvider.tsx` — barrel imports.
- `packages/web-agent/src/providers/WebAgentProvider.tsx` — barrel imports.
- `packages/web-agent/src/web-agent/fs/zenfs-operations.test.ts` — **new**.
- `packages/web-agent/src/web-agent/core/tools/ls.test.ts` — **new**.
- `packages/web-agent/src/web-agent/fs/zenfs-provider.test.ts` — **new**.
- `packages/web-agent/src/web-agent/core/agent-session.test.ts` — **new**.
- `ai-docs/02-architecture.md`, `ai-docs/05-decisions.md`, `ai-docs/milestones.md` — post-script + D16 + D17.

## Reused patterns / existing utilities to keep in mind

- Constructor-injection pattern already established for `WorkerAgentHost` and `DexieSessionStore`. The options struct in Phase 3 mirrors that style — no new idiom.
- `MemorySessionStore` tests (`memory-store.test.ts`) are the template for `zenfs-operations.test.ts`: seed an in-memory backend, exercise each op, assert contract. Reuse the `InMemory` backend pattern already proven in `worker-host.ts:154` (dev-seed path).
- `AGENT_WORKER_INIT_TYPE` + `isAgentWorkerInit` guard (`worker/init-protocol.ts`) is where the new `options` field lands; same validation pattern.

## Verification

1. `cd packages/web-agent && npm run check` — biome + tsc must pass, no new `any`/`ts-ignore`.
2. `cd packages/web-agent && npm test` — existing 133 tests + roughly 20–30 new ones from Phase 4. Target: all green.
3. `cd packages/web-agent && npm run test:e2e` — 4 specs must stay green; in particular `session-persistence.spec.ts` exercises the plumbed-through `sessionsDbName` indirectly.
4. `cd packages/web-agent && npm run build` — build clean; bundle sizes unchanged (±1 %).
5. **Repo-level `npm run check` at root** — validates the browser-smoke + web-ui side stay green (they don't import from web-agent, but the check shape is the milestone gate).
6. **Manual smoke via Claude in Chrome** — boot dev server, load `localhost:5173`, send a prompt, reload, confirm session restores. Optional but cheap confirmation that the options plumbing didn't regress the happy path.

## Rollback

Each phase is its own diff on top of `5cd569c0`. Phase 1 (dead exports) is trivially revertible. Phase 3 (options plumbing) is the largest blast radius; if a consumer breaks, reintroduce the default value as a module constant instead of an option. Phase 4 (new tests) is additive; never a rollback concern.
