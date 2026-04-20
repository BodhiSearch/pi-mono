# M8 Extensions — Implementation Plan

Source inputs:
- Research context: [m8-extensions-exploration.md](m8-extensions-exploration.md).
- Research findings, feasibility matrix, and decision: [m8-extensions-plan.md](m8-extensions-plan.md).

This document is the implementation-side counterpart to the research plan. It converts the decision captured on 2026-04-20 into concrete phased work, exit criteria per phase, and the testing posture for each.

---

## 0. Decision being implemented

- **Axis A (loading):** A4 — Dexie-backed extension bytes, rehydrated into a Blob URL, dynamically imported inside a dedicated per-extension Worker.
- **Axis B (lifecycle):** B4 — true hot-swap: load/unload extensions without page reload and without restarting the agent Worker. Mid-stream unloads defer to the next `agent_end`.
- **Committed extension genres for M8 v1 (each backed by one sample):**
  1. **Text mutation** via `tool_result` (uppercase-echo).
  2. **`registerTool` + vault FS** (vault-todos).
  3. **`registerTool` + `net:<origin>`** (fetch-url-tool).
  4. **Skills-as-extensions**: `before_agent_start` + scoped tool (greeting-skill).
- **Explicitly deferred out of M8 v1:**
  - `tool_call` block / gate semantics (path-guard) — punt to M8.1 once the supervisor + permission UI exist.
  - `registerProvider` — blocked on a `ModelRegistry` equivalent in web-agent.
  - `registerMessageRenderer` — remains in M9 scope.

Every phase below ends on the per-commit gate from the research plan §9 (`npm run check`, `npm test`, `npm run test:e2e`, `npm run build`; no new `any`/`@ts-ignore`/skipped tests in `src/`).

---

## 1. Phased work breakdown

### Phase 1 — API surface & types (no runtime code)

**Objective:** replace the stub `packages/web-agent/src/web-agent/core/extensions/types.ts` with the trimmed, browser-safe shape we validated in the spike (`scratch/m8/host/types.ts`).

Tasks:
1. Move `scratch/m8/host/types.ts` into `packages/web-agent/src/web-agent/core/extensions/types.ts`, preserving the existing file's doc comments where applicable.
2. Narrow the `on(...)` overload set to the four events M8 actually handles: `tool_result`, `before_agent_start`, `session_start`, `session_shutdown`. Any other `AgentEvent['type']` stays generic (no-op handlers still compile, we just don't ship extension-side mutation semantics for them yet).
3. Keep `registerTool` on the ExtensionAPI. Leave a commented `// registerProvider / registerMessageRenderer deferred` anchor — do **not** ship either signature publicly in v1.
4. Add `ExtensionManifest` fields the later phases consume: `id`, `name`, `version`, `description?`, `permissions?: { net?: string[]; vault?: { read?: string[]; write?: string[] } }`.
5. Re-export the extension types from `packages/web-agent/src/web-agent/index.ts` (currently scaffolded as a TODO comment at lines 98–99).

Exit: `npm run check` green; no other code changes.

Test seams added in this phase: none (types-only).

---

### Phase 2 — Dexie-backed extension store (`ExtensionStore`)

**Objective:** durable storage for extension bytes + enabled-list, keyed by extension id, readable from both the main thread and the agent Worker.

Tasks:
1. New module `packages/web-agent/src/web-agent/core/extensions/store/extension-store.ts` with a Dexie schema:
   - `ExtensionBytesRow`: `{ id: string; source: 'remote' | 'upload' | 'builtin'; origin?: string; bytes: Uint8Array; manifest: ExtensionManifest; version: string; addedAt: number; }`.
   - `ExtensionEnabledRow`: `{ id: string; enabled: boolean; updatedAt: number; }`.
2. Surface:
   - `putExtensionBundle(entry)`
   - `getExtensionBundle(id)`
   - `listExtensions()`
   - `removeExtension(id)`
   - `setEnabled(id, enabled)`
   - `getEnabledIds()`
3. In-memory fallback (`MemoryExtensionStore`) mirroring the session-store pattern for vitest specs.
4. Vitest specs `extension-store.test.ts` covering round-trip, enabled-list toggles, and removal.

Exit: Dexie schema versioned; tests green.

---

### Phase 3 — Extension host Worker

**Objective:** dedicated per-extension Worker built from the spike code, production-shaped.

Tasks:
1. Promote `scratch/m8/host/host-worker.ts` to `packages/web-agent/src/web-agent/core/extensions/host/host-worker.ts`.
2. Rework the loader to support three modes (same-origin URL, Blob URL from bytes, and a local `builtin` reference for Phase 7 dev seeds). Always build the Blob from bytes the supervisor posts in, never touch Dexie directly from inside the host Worker.
3. Implement the `ExtensionAPI` surface per Phase 1 types:
   - `on`, `registerTool` — wired.
   - `ui.notify`, `ui.setWorkingMessage` — wired as postMessage up to supervisor.
   - `manifest` — injected from init payload.
4. Enforce a small in-Worker permission wrapper:
   - `fetch` is shadowed with a wrapper that checks the allow-list from `manifest.permissions.net` before letting the call through. No allow-list → no outbound calls.
   - Vault access goes through a tool-upcall to the agent Worker (see Phase 4), not direct ZenFS.
5. Vitest spec `host-worker.test.ts` exercising init + event dispatch using an in-process `MessageChannel` (the same transport pattern M4 uses for the agent Worker tests).

Exit: the sample `uppercase-echo.mjs` bundle works end-to-end through the in-process transport in a unit test.

---

### Phase 4 — Extension supervisor inside the agent Worker

**Objective:** the runtime that owns the set of loaded extensions, dispatches events, and keeps `AgentSession.setTools` in sync with the live extension tool set.

Tasks:
1. Promote `scratch/m8/host/supervisor.ts` to `packages/web-agent/src/web-agent/core/extensions/supervisor.ts`.
2. Wire the supervisor into `WorkerAgentHost`:
   - Instantiate on worker boot.
   - Subscribe to `AgentSession` events; forward `before_agent_start`, `tool_result`, `session_start`, `session_shutdown` through `supervisor.dispatchEvent`.
   - When the supervisor's `onToolsChanged` fires, merge with vault + MCP tools and call `AgentSession.setTools` — respecting the existing in-flight-stream guard (defer until `agent_end`).
3. Provider / renderer hooks: wire the supervisor's `onProviderRegistered` and `onUiNotify` callbacks to no-ops in v1 with a `TODO(M8.1)` anchor so M9 can hook them later without touching the supervisor.
4. Tool invocation from the agent reaches the extension: supervisor-minted proxy `AgentTool` (already in the spike) posts `tool_invoke` into the host Worker, awaits `tool_invoke_reply`, and returns the result as `ToolResult`.
5. Vitest `supervisor.test.ts`: two stub extensions (one mutation handler, one tool registration) wired through an in-process transport, exercising both success and worker-crash paths.

Exit: agent Worker's effective tool list equals `[...vaultTools, ...mcpTools, ...supervisor.aggregatedTools()]` on every refresh. Worker crash of a single extension does not take down the agent Worker.

---

### Phase 5 — Main-thread install / list / toggle API + RPC

**Objective:** the main thread can install a bundle, list installed extensions, and toggle enabled without page reload.

Tasks:
1. Extend RPC types in `packages/web-agent/src/web-agent/rpc/rpc-types.ts`:
   - `installExtension({ id, bytes, manifest, source, origin? })` → `InstalledExtension`.
   - `uninstallExtension(id)`.
   - `listExtensions()`.
   - `setExtensionEnabled(id, enabled)`.
   - Unsolicited events: `extension_loaded`, `extension_unloaded`, `extension_error`, `extension_notify`.
2. In `WorkerAgentHost`:
   - On install → write to `ExtensionStore`, if enabled also call `supervisor.load({ id, bundleText })`.
   - On enable/disable → call `supervisor.load` or `supervisor.unload`. Mid-stream disables queue until `agent_end` (reuse the existing write-chain / compaction deferral machinery; add a `pendingDisables: Set<string>` flushed on `agent_end`).
3. Main-thread client hook:
   - `useExtensions()` returning `{ list, install, uninstall, toggle, events }`.
   - Enabled-list state mirrored in a Zustand/Context store so the UI renders synchronously without re-reading Dexie.
4. Vitest specs covering RPC round-trip + the mid-stream deferral invariant.

Exit: Playwright spec `m8.extensions-lifecycle.spec.ts` toggles an extension twice in a row without reload and asserts the tool list changes observably.

---

### Phase 6 — Sample extensions (M8 v1 genres)

**Objective:** ship four sample extensions that match the committed genres. They live under `packages/web-agent/src/web-agent-extensions/**` — a sibling to `src/web-agent/` so Principle #3 (no `@/...` in `src/web-agent/`) is preserved — and build to ESM bundles consumed by the install flow.

Tasks per extension:
- Author the source in `packages/web-agent/src/web-agent-extensions/<name>/index.ts`.
- Add a `manifest.json` alongside it (name, version, description, permissions).
- Build step: add a `scripts/build-extensions.mjs` that runs `esbuild --format=esm --bundle` for each extension into `packages/web-agent/dist-extensions/<name>.mjs`. Hooked into `npm run build`.
- Dev seed: the reference app `App.tsx` reads `dist-extensions/` (in dev, served via `public/_m8/` symlink or a dev middleware) and installs them into `ExtensionStore` if not present. The list is dev-only — stock extensions will become manifest-driven in M8.1.

Sample set:
1. **uppercase-echo** — ported from spike.
2. **vault-todos** — extends the spike sample with a real tool-upcall path to the agent Worker's vault FS (`appendFile` + `read`).
3. **fetch-url-tool** — ported from spike with real `net:<origin>` enforcement in the host Worker.
4. **greeting-skill** — ported from spike; validates `before_agent_start` mutation of system prompt + scoped tool coexistence.

Exit: each sample has a Playwright spec driving the chat to trigger the relevant behavior.

---

### Phase 7 — Reference-app UI surface (`Extensions` drawer)

**Objective:** a minimal, testable UI to install, list, toggle, and uninstall extensions.

Tasks:
1. New `ExtensionsDrawer` component, triggered from the header, mounted alongside `SessionPicker`. Not a modal.
2. Interactions:
   - List installed extensions with name, version, description, and a toggle.
   - "Install from file" (drag-drop or file picker; reads bytes + manifest).
   - "Remove" button per row.
3. Streaming state indicator: if the agent is currently streaming, toggling an enabled extension shows a "will apply at end of turn" badge.
4. Uses the Phase 5 `useExtensions()` hook.
5. Test IDs + test states per the Playwright skill (`data-testid`, `data-test-state`).

Exit: Playwright spec walks install → enable → prompt → observe → disable → prompt → no-longer-observe.

---

### Phase 8 — Cleanup & docs

Tasks:
1. Delete or promote the temporary `packages/web-agent/public/m8-spike/` harness (the decision already logged is to **delete after the implementation plan is executed**; the spike served its purpose).
2. Keep `packages/web-agent/scratch/m8/` per the decision gate (`keep_scratch`). Add a README pointer from the scratch directory to this implementation plan to avoid future drift.
3. Author `packages/web-agent/docs/extensions.md` covering:
   - How to write a web-agent extension (factory signature, events, permissions).
   - How to install from a file vs ship as a bundled stock extension.
   - Mid-stream toggle behavior.
   - Known deferred items (path-guard / registerProvider / message renderer) with issue anchors.
4. Update `ai-docs/plans/03-tasks.md` M8 block to reference this plan and mark the delivered tasks.

Exit: per-commit gate green; docs published; research plan §8 deliverables all checked.

---

## 2. Test strategy per phase

| Phase | Unit (vitest) | E2E (Playwright) | Manual |
|---|---|---|---|
| 1 types | type-only compiles | — | — |
| 2 store | store.test.ts | — | — |
| 3 host-worker | host-worker.test.ts via in-process channel | — | — |
| 4 supervisor | supervisor.test.ts | — | — |
| 5 RPC | rpc round-trip tests | lifecycle spec | toggle during streaming |
| 6 samples | per-extension unit tests | per-extension e2e | — |
| 7 UI | component tests | drawer e2e | visual review |
| 8 cleanup | — | full regression | — |

Tagging convention: Playwright specs added in this milestone carry the `@m8` tag so they can be selected/excluded in CI.

---

## 3. Rollout posture

- **Feature flag:** the `ExtensionsDrawer` and `install` RPCs land behind `import.meta.env.DEV || flags.m8Extensions` during Phase 5–7, flipped on by default at Phase 8.
- **Backwards compatibility:** no changes to the public surface of `src/web-agent/` other than the types file and the new `extensions/*` subtree. `WorkerAgentHost` additions are internal.
- **Principle adherence:**
  - #1: `src/web-agent/**` imports no coding-agent code; types are ports, not imports.
  - #2: storage is Dexie; no OPFS.
  - #3: extensions live under `src/web-agent-extensions/**`, not `src/web-agent/`, so they retain freedom to import from `@/...` while the framework code does not.

---

## 4. Risks to watch during implementation

1. **Mid-stream reconciliation.** `AgentSession.setTools` already supports live update, but handler mutation (new `on('tool_result', …)` registrations) during an active turn is untested. Phase 4 must add a deferral invariant test.
2. **Worker-spawn-from-Worker support.** We rely on nested Workers inside the agent Worker. Confirmed to work in Chromium during E1–E7; add a capability probe at boot with a clear error message for Safari / older browsers if we ever support them.
3. **Blob-URL lifecycle.** Each `URL.createObjectURL` must be revoked when the extension unloads. Unit test that covers load→unload→load of the same id to catch leaks.
4. **Dexie migration.** The new `ExtensionBytesRow` + `ExtensionEnabledRow` tables land in a new schema version. Follow the existing migration pattern in `WebAgentDB`.
5. **Permissions UI.** v1 grants everything declared in the manifest at install time with a single confirm dialog. No per-call prompting. Document this clearly in `docs/extensions.md`; the richer permission UI lives in M8.1.

---

## 5. Follow-up milestone scope (M8.1+)

Tracked for completeness, **not** part of M8 v1:

- `tool_call` block / gate semantics + path-guard sample.
- `registerProvider` + `ModelRegistry` equivalent + ollama-provider sample.
- Per-call permission prompts and the richer install review UI.
- `registerMessageRenderer` + cross-Worker renderer transport (M9 proper).
- Extension update flow (install new version, preserve enabled state).
- Signature / SRI verification for installed bundles.
