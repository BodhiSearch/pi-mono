# 04 — Gap Analysis

**Purpose.** Honest list of what the spike does not do, does incorrectly, or does at a cost the feature does not warrant. Organised so the next iteration knows what to rebuild, what to keep, and what to delete.

Cross-reference: [`02-spike-implementation.md`](02-spike-implementation.md) describes what exists; this report describes what *doesn't work right or at all*.

---

## 1. Bugs and correctness issues

### 1.1 Dynamic loading does not work reliably without a page reload

**Symptom.** After installing + enabling an extension through the UI in `npm run dev`, the extension frequently does **not** take effect on subsequent prompts until the page is reloaded. A full reload reliably picks the extension up because `bootExtensions()` runs on agent-Worker startup and reads IndexedDB fresh.

**Suspected causes (not confirmed — no fix attempted per the spike's scope).**

- **Vite dev server + nested Workers.** The agent Worker spawns a nested Worker via `new Worker(new URL('../core/extensions/host/host-worker.ts', import.meta.url), { type: 'module' })`. Vite's dev transform for Workers does not always resolve the inner URL correctly when the caller is itself a Worker. In production builds (`npm run build`) the module graph is known and this works. In dev, the first spawn after a hot reload sometimes returns a Worker whose `onerror` fires silently.
- **No observability on spawn failure.** `host-worker.ts` has an `init` handshake, but if the nested Worker fails to start, the supervisor's `load()` hangs on its `ready` promise until a timeout we do not enforce. No error surfaces to the UI; the extension simply never applies.
- **Race in `refreshTools`.** `setTools` is called mid-boot. If the session already has a tool list, and the extension registers after `setTools` has been called for that turn, the agent prompt uses the previous list. This bites if the user enables an extension and prompts immediately — the prompt captures the pre-enable tool list.
- **Second-tab consistency.** Toggling in one tab writes to IndexedDB, but the other tab's agent Worker does not observe the change. `BroadcastChannel` is not wired.

**Impact.** The core value prop of the spike (true hot-swap, lifecycle iv in [`01-feasibility.md`](01-feasibility.md)) is not robustly delivered. At minimum the docs overclaim; realistically, the runtime needs a reload after install more often than the milestone text implies.

**Severity.** High. This is the single feature the research axis was chosen for.

### 1.2 `extension_loaded` event fires on install, not on load

`WorkerAgentHost.installExtension` emits `{type: 'extension_loaded', extensionId}` immediately after `store.putBundle`. This is before the extension is enabled, before the supervisor has spawned its Worker, and before any handlers are registered. A UI that trusts this event believes the extension is live when it isn't.

The correct signal is emitted separately by the supervisor's own "ready" handshake — but the UI layer subscribes to the misnamed event. Renaming / re-wiring is a small change, but it was missed.

### 1.3 `applyExtensionEnabled(true)` on an already-loaded extension silently no-ops

`supervisor.load(id, ...)` checks if the id is already loaded and returns early. That's fine for idempotency, but the UI's "re-enable" path goes through the same code and produces no observable effect. If the user wants to "bump" an extension (e.g. after a silent failure in 1.1), the UX offers no mechanism.

### 1.4 Mid-stream uninstall is not deferred

`pendingExtensionChanges` queues enable/disable toggles, but `uninstallExtension` writes directly to the store and calls `supervisor.unload(id)`. If uninstall fires mid-stream, the extension's handlers disappear while the turn is running; tool results in flight may be partially processed. Low-probability issue, but a correctness gap.

### 1.5 `tool_result` chain wraps *extension-registered* tools too — wait, it doesn't, and that's also a gap

Base tools (vault + MCP) go through `wrapToolWithExtensionChain`. Extension-registered tools bypass it explicitly to avoid recursion (extension A's tool producing output extension A transforms). This is the right call in spirit, but the actual rule is "any extension's tools bypass the chain", which means extension B cannot mutate extension A's tool output even if the user would want it to. No tests cover this interaction; the behaviour is accidental.

### 1.6 `registerTool` collision detection is missing

Two extensions can both register a tool named `get_magic_word`. The aggregator takes the last one to register. No warning, no fallback, no namespace. An extension author can trivially break another extension.

### 1.7 Bundle size and handler count are unbounded

`installExtension` accepts any `bytes.length`. A 50MB `bundleText` is stored in IndexedDB and then `Blob`-URL'd into a Worker. Likewise an extension can register thousands of event handlers. No guardrails.

---

## 2. Permission model gaps (declared but not enforced)

The `ExtensionManifest.permissions` field accepts three kinds, only one of which actually does anything:

| Permission | Status in spike |
|---|---|
| `net:<origin>` allow-list | ✅ enforced via `self.fetch` shadow |
| `fs:vault` | ❌ declared, no code path consumes it. Extensions cannot actually access the vault. |
| `fs:self` (extension-scoped storage) | ❌ not implemented. No per-extension storage exists. |
| Tool invocation authority (call which tools?) | ❌ not modelled at all. Extensions' tools can shell out through `api` as freely as they want. |
| Call budgets / rate limits | ❌ not implemented. |
| Time budgets (kill a handler that runs > N ms) | ❌ not implemented; `Promise.race` with a timeout would fix it. |

As a result, the spike's security story is:

- **Strong.** Worker isolation, no DOM, no accidental global access.
- **Weak.** Once inside, the extension's authority is "whatever the Worker can do" — which is everything except fetch-to-unapproved-origins. Read-anywhere behaviours are not gated. Compute budgets are infinite.

Untrusted code is therefore **not safe to run** under the spike. Trusted / first-party code is fine.

---

## 3. UX gaps

### 3.1 No error surfacing for load failures

When a bundle fails to import (syntax error, bad factory signature, handler throw-at-load), the supervisor emits `extension_error`. The UI stores it in `errors[id]` and displays… nothing specific. The `ExtensionsPopover` has a badge, but the badge says "enabled count", not "error count". A user with a broken extension sees the toggle flip on and no visible effect and has no path to the error message.

### 3.2 No reload hint

When dynamic loading fails silently (§1.1), there is no UI affordance that says "reload the page to apply". The error never surfaces, so the user concludes extensions don't work.

### 3.3 No per-extension "view source" / "view manifest"

Users cannot inspect what they've installed. No dialog shows the declared permissions. For user-authored code this is a critical omission; for built-ins it's a nice-to-have.

### 3.4 Enable/disable toggle is not optimistic

The toggle waits for the RPC round-trip before visually flipping. Subjectively this reads as "is the app hung?". An optimistic flip with a rollback on error would be noticeably snappier.

### 3.5 No settings page, only a popover

Extensions are toggled from a popover attached to the chat input. This is fine for a demo; for the real product, extensions belong in settings alongside MCP servers and model configuration.

---

## 4. Over-engineering that should be removed if we keep this design

### 4.1 Per-extension Worker is overkill for first-party samples

The three built-in samples (`echo-prefix`, `magic-word-tool`, `shout-results`) are 40 lines each of trusted code. Running each in its own Worker spends ~1.5 MB of memory and a few RPCs per event dispatch for no isolation benefit. One "trusted built-ins" inline execution path + one "sandboxed user code" Worker path would be less code than the current unified pipeline.

### 4.2 Dexie usage is shallow

We use Dexie to read/write two small tables and never exercise its query builder or migrations at scale. Raw IndexedDB via `idb-keyval` would be 20 lines. Dexie is kept for consistency with session storage, but the dependency budget could go the other way.

### 4.3 `ExtensionStore` abstraction has one real implementation

`MemoryExtensionStore` is a test double; `DexieExtensionStore` is production. The interface exists solely for tests. Replacing the test with a fake Dexie (fake-indexeddb, already a dev dep) would eliminate the whole abstraction.

### 4.4 Bundle-as-string is an authoring nightmare

The sample bundles store their ESM source as a multi-line template literal inside a TypeScript file. Authoring means writing JavaScript-inside-TypeScript-inside-TypeScript. No type-check, no syntax highlighting of the payload, no autocomplete. For first-party samples this is absurd. They should be regular TS modules compiled normally.

For user-authored code the string makes sense, but the sample harness pretends these are the same kind of thing when they aren't.

### 4.5 Two kinds of decision log

The spike appended D20 / D21 to the legacy `ai-docs/05-decisions.md` and (correctly) to `ai-docs/decisions/m8-extensions.md`. Principle 7 says the per-milestone folder is canonical. `05-decisions.md` shouldn't have been touched. Clean-up belongs in the next iteration.

---

## 5. Missing features the spike silently descoped

Listed in the original M8 scope preview but never built:

- **Vault access from inside extensions.** `fs:vault` permission exists; no API surfaces a vault handle to the extension.
- **`registerProvider`.** Declared as deferred to M8.1; no hook points exist.
- **`registerMessageRenderer`.** Declared as deferred; no hook points.
- **`tool_call` block/gate semantics** (path-guard sample). Deferred.
- **`registerCommand`** (slash commands). Not wired; M9 territory.
- **Skills-as-extensions**. The `before_agent_start` path is there; what's missing is a skill-loading convention that treats markdown files as part of an extension's surface.
- **Per-call permission prompts.** Declared deferred.
- **SRI / bundle signing.** Never considered in the spike.

---

## 6. Test coverage gaps

Things that pass in vitest but not e2e, or have no test at all:

- No test exercises the "mid-stream toggle → pending → agent_end → applied" full loop with a real streaming turn.
- No test asserts the `self.fetch` guard actually rejects. The guard is installed; its effect is unproven against runtime evidence.
- No test covers two extensions interacting (one registers a tool, another mutates its output).
- No test covers cross-tab consistency — unit tests mock a single Dexie instance.
- No test covers the `extension_loaded` / `extension_error` event timing; the UI listens for events that are only tangentially documented.

---

## 7. Documentation gaps

- `packages/web-agent/docs/extensions.md` describes the authoring contract for the spike's API. It doesn't describe:
  - how to debug an extension that silently fails to load;
  - the dev-vs-prod loading difference (§1.1);
  - the exact mid-stream deferral semantics from the user's perspective;
  - how permissions are enforced vs. merely declared (§2 above);
  - any of the intent / trust distinctions from [`01-feasibility.md`](01-feasibility.md).

Any user following that doc to write a real extension will run into gaps §1 and §2 before they finish their second one.

---

## 8. What's genuinely good about the spike (keep)

To balance: some pieces earn their keep and should influence the next iteration.

- **`pendingExtensionChanges` + `agent_end` flush.** Clean pattern, matches compaction.
- **Extension-scoped system-prompt restoration in `prompt()`'s `finally` block.** Correct. Stateless from the LLM's perspective.
- **`data-testid` discipline in `ExtensionsPopover`.** The page object and spec read well.
- **Sample extensions chosen for deterministic assertion (`[EXT:ECHO]`, `MAGIC_RABBIT_42`).** Unambiguously testable. Keep this discipline.
- **Supervisor as the one boundary between "agent Worker state" and "extension runtime state".** Correct choice regardless of how extensions are actually executed.

---

## 9. Summary — rebuild / keep / delete

| Component | Verdict |
|---|---|
| Per-extension nested Worker | **Delete** for v1, revisit only for user-authored code |
| `ExtensionSupervisor` | **Keep concept, simplify implementation** |
| `ExtensionStore` (Dexie) | **Reduce to one IDB row** |
| `ExtensionStore` interface + memory impl | **Delete**; test via fake-indexeddb |
| `host-worker.ts`, `bridge.ts` | **Delete** for v1 |
| `extension_*` RPC commands + events | **Reduce to 2 commands, 1 event** |
| `useExtensions`, `ExtensionsPopover` | **Keep, trim scope** |
| `pendingExtensionChanges` pattern | **Keep** |
| `before_agent_start` + `tool_result` interception in `WorkerAgentHost` | **Keep** |
| Sample extensions as bundled strings | **Rewrite as normal TS modules** |
| `docs/extensions.md` | **Rewrite against the new design** |
| `D20` decision | **Supersede** with a new decision entry referencing the unbiased approach |
| `D21` decision | **Keep**; pattern is generally correct |
