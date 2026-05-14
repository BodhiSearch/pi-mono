# M6 Extensions Review — Consolidated Index

**Commit reviewed:** `067bed6a` — `web-acp: M6 phase 0 — extensions plan + research memo`  
**Review date:** 2026-05-07  
**Scope:** 122 files, 9,485 insertions — vault-sourced extension runtime across
`packages/web-acp-agent/` and `packages/web-acp/`

## Review files

| File                                                       | Layer                                        | Findings                    |
| ---------------------------------------------------------- | -------------------------------------------- | --------------------------- |
| [m6-01-types-and-registry.md](m6-01-types-and-registry.md) | Extension types, registry, prefs             | 14 findings: 0C 2H 4M 3L 5N |
| [m6-02-runtime-and-api.md](m6-02-runtime-and-api.md)       | Runner, API, loader, event-bus, ExtensionsFs | 12 findings: 0C 2H 3M 7N    |
| [m6-03-install-flow.md](m6-03-install-flow.md)             | npm install, ext-methods, schemas            | 9 findings: 0C 2H 3M 4N     |
| [m6-04-engine-integration.md](m6-04-engine-integration.md) | Prompt driver, session runtime, bridge       | 9 findings: 0C 1H 3M 5N     |
| [m6-05-host-layer.md](m6-05-host-layer.md)                 | agent-worker, hooks, components, Dexie       | 7 findings: 0C 0H 1M 5L 1N  |
| [m6-06-e2e-and-compliance.md](m6-06-e2e-and-compliance.md) | E2E, wire/ACP compliance, public barrel      | 10 findings: 1C 0H 3M 3L 3N |

---

## Blocker summary (Critical + High)

### BLOCKER — Public barrel missing ~35 extension type exports
**Severity: Critical** | Files: `packages/web-acp-agent/src/index.ts`  
Found by: m6-01, m6-06

The spec at `ai-docs/web-acp/specs/web-acp-agent/index.md` explicitly lists all event/handler/config types as required public surface. The production barrel currently exports only a handful: `ExtensionAPI`, `ExtensionFactory`, `ExtensionInfo`, `ExtensionCapabilities`, `ExtensionEvent`, `ExtensionEventHandler`, `ExtensionDisposable`. Missing (non-exhaustive):

`SessionStartEvent`, `SessionStartHandler`, `BeforeAgentStartEvent`, `BeforeAgentStartEventResult`, `BeforeAgentStartHandler`, `InputEvent`, `InputEventResult`, `InputEventSource`, `InputHandler`, `InputResultContinue`, `InputResultHandled`, `InputResultTransform`, `ToolCallEvent`, `ToolCallEventResult`, `ToolCallHandler`, `ToolResultEvent`, `ToolResultEventResult`, `ToolResultHandler`, `BeforeProviderRequestEvent`, `BeforeProviderRequestHandler`, `AfterProviderResponseEvent`, `AfterProviderResponseHandler`, `ExtensionCommandDefinition`, `ExtensionCommandInfo`, `ExtensionTool`, `ExtensionTypeBuilder`, `ExtensionSessionView`, `ExtensionVolumesView`, `ExtensionEventsView`, `ExtensionEventsHandler`, `ProviderConfig`, `ProviderModelConfig`, `ProviderOAuthConfig`, `ProviderOAuthCredentials`, `ProviderOAuthLoginCallbacks`, `ProviderStreamSimple`

Hosts consuming `@bodhiapp/web-acp-agent` cannot type their extension callbacks without reaching into internal paths. Mechanical barrel addition — must be fixed before M7.

---

### HIGH-1 — Path traversal via tarball `manifest.name` / `manifest.version`
**Severity: High** | File: `packages/web-acp-agent/src/agent/extensions/install.ts:126–145`  
Found by: m6-03

`localExtensionDirName` constructs the install directory from values read out of the tarball's `package.json` without any sanitization. A malicious registry response with `"name": "../evil"` writes outside `.pi/extensions/`. Fix: reject names/versions containing `/`, `\`, or `..` before constructing `installRoot`.

---

### HIGH-2 — SSRF via unrestricted `registryUrl`
**Severity: High** | File: `packages/web-acp-agent/src/acp/engine/ext-methods/schemas.ts:29–33`, `install.ts:101–111`  
Found by: m6-03

`z.string().url()` accepts `http://`, `file://`, and RFC-1918 addresses. A crafted `/extension add` command can hit `http://169.254.169.254/`. The tarball URL from the registry metadata response is also fetched without scheme or host validation. Fix: add `.refine(u => u.startsWith('https://'))` to the Zod schema; validate tarball URL before fetching.

---

### HIGH-3 — Command conflict resolution: spec says suffix, code does last-write-wins
**Severity: High** | Files: `packages/web-acp-agent/src/agent/extensions/registry.ts:369`, `ai-docs/web-acp/specs/web-acp-agent/extensions.md` Conflict resolution section  
Found by: m6-01, m6-02

The spec says: two extensions registering `/foo` → first gets `/foo`, second gets `/foo-2`. The code does last-write-wins with a `console.warn`, and `registry.test.ts:408` asserts that behavior (test written to match the code, not the spec). Requires a deliberate decision: fix the implementation to use suffixes OR update the spec and document the rationale for last-write-wins. Cannot be left inconsistent going into M7 (commands are a primary M7 concern).

---

### HIGH-4 — `forceToolCall` missing `isDev` gate in enforcement
**Severity: High** | File: `packages/web-acp-agent/src/acp/engine/prompt-driver.ts:234`  
Found by: m6-04

The spec (`ai-docs/web-acp/specs/web-acp-agent/index.md` "DEV-only feature gates") states the agent must throw JSON-RPC `-32004` when a non-DEV host tries to enable `forceToolCall`. Neither `prompt-driver.ts` nor `handleSetSessionConfigOption` enforces this. A persisted `forceToolCall: true` in a production session will force every LLM call into tool-call mode silently.

---

### HIGH-5 — Event bus infinite loop: no in-flight guard
**Severity: High** | File: `packages/web-acp-agent/src/agent/extensions/event-bus.ts`  
Found by: m6-02

A handler that calls `pi.events.emit(sameChannel, ...)` synchronously recurses until stack overflow. Add a per-channel `inflight` set that skips re-entrant emission with a `console.warn`.

---

## Medium findings (by file)

### Types & Registry (m6-01)
- **M1** — `ToolCallEvent.input` has `readonly` TypeScript qualifier but the spec allows in-place mutation. Remove `readonly` or update the spec.
- **M2** — `session_shutdown` event is in the union and spec lifecycle table but `dispatchSessionShutdown` is never called anywhere. Handlers subscribing to it silently never fire.
- **M3** — `discoverExtensions` and `LoadedExtensionModule` exported from `agent/extensions/index.ts` should be `test-utils` only — not listed in the spec's public surface.
- **M4** — `#activeSessionId` shared mutable state across all `dispatch*` methods. Add a DEV-mode assertion that dispatches never nest.

### Runtime & API (m6-02)
- **M5** — `ExtensionsFs` has no path-sandbox boundary. `pi.fs.readFile('/sessions/...')` succeeds today because `createZenfsExtensionsFs` applies no prefix guard. Add the guard or update spec to document the fully-trusted model.
- **M6** — `beforeProviderRequest`/`afterProviderResponse` hooks silently skip when session cancels mid-stream. Needs a code comment to prevent future "fix" that re-activates them after cancel.

### Install Flow (m6-03)
- **M7** — No partial-install cleanup: a `writeFile` failure after `mkdir` leaves an orphaned incomplete extension directory. At minimum, attempt cleanup on failure.
- **M8** — No concurrency guard on reload. Two concurrent ACP calls can produce torn registry state. Add a reload-chain serialization promise.
- **M9** — `install.test.ts` missing: network/registry failure, reinstall over existing directory, scoped-package round-trip, malformed `package.json`, entry-absent-from-tarball.

### Engine Integration (m6-04)
- **M10** — Extension commands bypass the `input` event. `tryHandleExtensionCommand` fires before `dispatchInput`. Correct behavior, but needs a comment documenting the exclusion.
- **M11** — Extension commands not deduped against vault template names in `available_commands_update`. Picker shows duplicates if an extension and a vault template share a name. Apply same `seenNames` dedup to `extensionCommands`.

### Host Layer (m6-05)
- **M12** — `useExtensions` race: in-flight `listExtensions()` Promise resolves after a notification has already updated state, overwriting the newer state with a stale snapshot. Track a sequence number.

### E2E & Compliance (m6-06)
- **M13** — `test.step` phase labels are out of numerical order in `extensions.spec.ts:173–291`. Phases 10, 8, 9 execute after phase 12 steps.
- **M14** — Redundant `stat()` call in `mock-npm-registry.ts:91–105` — `Dirent.isFile()` from `readdir({ withFileTypes: true })` is already authoritative.
- **M15** — Three missing edge-case unit tests in `builtins.test.ts` for `/extension`: no-op idempotency when already enabled, no-op when already disabled, missing-argument usage output.

---

## Low / Nit highlights

- `extensions.md` line 662 references wrong file path for `well-known-volume-tags.ts` (should be `agent/well-known-volume-tags.ts`)
- `acp/index.ts` re-exports `BodhiExtensionsReloadRequest/Response` but `AcpClient` has no `reloadExtensions()` method — dead re-exports
- `agent-worker.ts` `boot()` call has no `.catch` — transport/handshake failures silently hang the UI
- `data-test-state={String(entries.length)}` misuses the state attribute for a count — use `data-test-count`
- `BODHI_FEATURE_CONFIG_CATEGORY = '_bodhi/feature'` (singular) inconsistent with option IDs `'_bodhi/features/...'` (plural) — confirm not used as a prefix match
- `hello-passive` example has no-op handler with no explanatory comment
- `event-bus-ping/pong` example is one change away from an infinite loop — needs a warning comment

---

## Architecture checklist

| Constraint                                                             | Status                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------ |
| No browser-only runtime deps in `web-acp-agent`                        | ✅ Pass                                           |
| No node-only deps in `web-acp-agent`                                   | ✅ Pass                                           |
| Factory-function-only module identity (no class instances as identity) | ✅ Pass                                           |
| `extensions:disabled` key in PreferenceStore with `__global__` scope   | ✅ Pass                                           |
| `_bodhi/extensions/*` namespace for all wire methods                   | ✅ Pass                                           |
| Wire constants declared in `wire/index.ts` (not inlined)               | ✅ Pass                                           |
| No imports from `web-agent` or `coding-agent`                          | ✅ Pass                                           |
| One-worker-per-tab invariant preserved                                 | ✅ Pass                                           |
| E2E — zero `waitForTimeout`                                            | ✅ Pass                                           |
| E2E — zero `page.evaluate` into internals                              | ✅ Pass (one `evaluateAll` on test-seam DOM attr) |
| Dexie schema backward-compatible                                       | ✅ Pass                                           |

---

## Recommended fix order

1. **Immediately (before M7 starts):**
   - BLOCKER: Add missing ~35 extension type exports to `src/index.ts`
   - HIGH-3: Resolve command conflict-resolution spec vs. code inconsistency (requires decision)
   - HIGH-1 + HIGH-2: Security fixes in `install.ts` (path traversal + SSRF)
   - HIGH-4: Add `isDev` enforcement for `forceToolCall`
   - HIGH-5: Add in-flight guard to event bus

2. **Soon (M7 or standalone polish commit):**
   - M2: Wire up `dispatchSessionShutdown` or remove from spec
   - M3: Move `discoverExtensions`/`LoadedExtensionModule` to `test-utils`
   - M7+M8: Install cleanup on failure + reload concurrency guard
   - M9: Expand `install.test.ts` coverage
   - M12: Fix `useExtensions` fetch/notification race

3. **Nit sweep (before M11 polish):**
   - Fix spec file path reference
   - Remove dead re-exports from `acp/index.ts`
   - Add `.catch` to `agent-worker.ts` `boot()`
   - Fix `data-test-state` misuse on extension count
   - Fix `test.step` ordering in `extensions.spec.ts`
