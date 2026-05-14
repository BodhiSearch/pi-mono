# Code Review — M6 Extensions: Types, Registry, and Core Data Model

**Commit reviewed:** `067bed6a` (web-acp: M6 phase 0 — extensions plan + research memo; phases 1–14 squashed into that tag)
**Reviewer:** Claude Sonnet 4.6
**Date:** 2026-05-07
**Files reviewed:**
- `packages/web-acp-agent/src/agent/extensions/types.ts`
- `packages/web-acp-agent/src/agent/extensions/registry.ts`
- `packages/web-acp-agent/src/agent/extensions/registry.test.ts`
- `packages/web-acp-agent/src/agent/extensions/index.ts`
- `packages/web-acp-agent/src/agent/internal/extensions-prefs.ts`
- `packages/web-acp-agent/src/agent/internal/extensions-prefs.test.ts`
- `packages/web-acp-agent/src/agent/well-known-volume-tags.ts`
- Supporting reads: `runner.ts`, `api.ts`, `loader.ts`, `event-bus.ts`, `src/index.ts`, `api/start-agent.ts`, `agent/stream-fn.ts`

---

## Summary of Findings

| Severity | Count |
| -------- | ----- |
| Critical | 0     |
| High     | 2     |
| Medium   | 4     |
| Low      | 3     |
| Nit      | 5     |

---

## Findings

---

### F1 — High: Public barrel omits ~28 extension types that the spec mandates

**File:** `packages/web-acp-agent/src/index.ts`
**Spec ref:** `ai-docs/web-acp/specs/web-acp-agent/index.md` § "Extensions" (lines ~96–115)

The spec's public-surface inventory explicitly lists these types as part of the extensions public surface. None of them appear in `src/index.ts`; they are only accessible via the sub-barrel `agent/extensions/index.ts`, which is an internal path that production hosts are not supposed to import from (per `CLAUDE.md` § "Public surface").

Missing from `src/index.ts`:
```
AfterProviderResponseEvent, AfterProviderResponseHandler,
BeforeAgentStartEvent, BeforeAgentStartEventResult, BeforeAgentStartHandler,
BeforeProviderRequestEvent, BeforeProviderRequestHandler,
ExtensionCommandDefinition, ExtensionCommandInfo,
ExtensionEventsHandler, ExtensionEventsView,
ExtensionSessionView, ExtensionVolumesView,
InputEvent, InputEventResult, InputEventSource, InputHandler,
InputResultContinue, InputResultHandled, InputResultTransform,
ProviderConfig, ProviderModelConfig,
ProviderOAuthConfig, ProviderOAuthCredentials, ProviderOAuthLoginCallbacks,
ProviderStreamSimple,
SessionStartEvent, SessionStartHandler,
ToolCallEvent, ToolCallEventResult, ToolCallHandler,
ToolResultEvent, ToolResultEventResult, ToolResultHandler,
```

A host implementing `SessionStartHandler` today must import from the internal sub-barrel path `@bodhiapp/web-acp-agent/agent/extensions`, which violates the extraction contract.

**Suggestion:** Add all the above to `src/index.ts` by re-exporting from `./agent/extensions`:
```ts
export type {
  AfterProviderResponseEvent,
  AfterProviderResponseHandler,
  // ... (full list as in agent/extensions/index.ts)
} from './agent/extensions';
```
This is a mechanical one-block addition.

---

### F2 — High: Spec says Commands use load-order suffix; implementation uses last-write-wins

**File:** `packages/web-acp-agent/src/agent/extensions/registry.ts` (lines 367–370)
**Spec ref:** `ai-docs/web-acp/specs/web-acp-agent/extensions.md` § "Conflict resolution" (lines 157–159)

The spec states:

> **Commands** (`pi.registerCommand`): load-order suffix. Two extensions registering `/foo` → first gets `/foo`, second gets `/foo-2`, third gets `/foo-3`. Picker advertises both.

The implementation does the opposite — last-write-wins with a `console.warn`:

```ts
// registry.ts line 369
`[extensions] command '/${name}' from '${extensionName}' replaces prior owner '${existing.ownerExtension}' (last-write-wins)`
```

This is a functional spec divergence, not a nit. The suffix strategy preserves both extensions' commands in the picker; last-write-wins silently drops the first extension's command from the picker without user recourse. The test at registry.test.ts:408 tests and asserts last-write-wins behavior, which confirms the test was written to match the implementation rather than the spec.

**Suggestion:** Either (a) implement the suffix strategy in `#createCommandRegistrar` — when a name collision occurs with a different owner, append `-2`, `-3`, etc. until unique, record both in capabilities, and warn; or (b) update the spec to document the last-write-wins decision with a rationale. If (b), also update the test assertion message from `'last-write-wins'` to reflect the chosen policy name consistently. Given the spec was deliberately designed to preserve both extensions' commands in the picker, option (a) is the intended behavior.

---

### F3 — Medium: `ToolCallEvent.input` is typed `readonly` but the spec permits in-place mutation

**File:** `packages/web-acp-agent/src/agent/extensions/types.ts` (lines 102–104)
**Spec ref:** `ai-docs/web-acp/specs/web-acp-agent/extensions.md` § lifecycle event inventory, `tool_call` row

```ts
export interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly sessionId: string;
  readonly toolName: string;
  /** Validated tool arguments. Handlers may mutate this object in place to rewrite the call. */
  readonly input: Record<string, unknown>;
}
```

The `readonly` modifier on `input` prevents TypeScript from complaining when the value is reassigned (`event.input = ...`), but it does NOT prevent mutation of the object's properties (`event.input.script = 'safe'` compiles fine). So the JSDoc comment "may mutate this object in place" is technically correct at runtime, but the type declaration sends a confusing signal that contradicts it. TypeScript readers will assume `readonly input` means "do not modify this".

The spec at extensions.md line 499 says: "Mutating `event.input` in place (e.g. rewriting a path argument) is allowed". The type declaration conflicts with this documented intent.

**Suggestion:** Either remove `readonly` from `input` to signal mutability is allowed (matching the spec), or change the spec and comment to say mutation is not supported (and enforce it by doing `Object.freeze(event.input)` at the dispatch call site in `runner.ts`). Given the spec explicitly calls this out as a feature, removing `readonly` from `input` while keeping it on the other fields is the cleaner fix:

```ts
export interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly sessionId: string;
  readonly toolName: string;
  /**
   * Validated tool arguments. Handlers may mutate properties of this
   * object in place to rewrite the call before execution.
   */
  input: Record<string, unknown>;
}
```

---

### F4 — Medium: `session_shutdown` event is declared but never dispatched; spec marks it planned but the lifecycle table implies it should fire

**File:** `packages/web-acp-agent/src/agent/extensions/types.ts` (line 35)
**Spec ref:** `ai-docs/web-acp/specs/web-acp-agent/extensions.md` § lifecycle event inventory, `session_shutdown` row

`session_shutdown` is in the `ExtensionEvent` union (line 35) and in the spec's lifecycle table as "(planned)" — but no call to `dispatchSessionShutdown` exists anywhere in the codebase (`grep -r "dispatchSessionShutdown" packages/web-acp-agent/src` returns nothing). Extensions subscribing to `'session_shutdown'` via `pi.on('session_shutdown', ...)` will record the subscription but the handler will never fire.

This is documented as "(planned)" in the spec, so the intent is understood. The problem is that extensions registering this event have no indication their handler is dead code. An extension like `session-counter` that tries to flush state on shutdown will silently do nothing.

**Suggestion:** Two options:
1. Add a `dispatchSessionShutdown` call in `AcpSessionRuntime.tearDownSession()` or equivalent cleanup path (preferred — closes the gap).
2. Remove `'session_shutdown'` from `ExtensionEvent` and add it back when the dispatch is implemented. Update the spec to "(not yet reserved — lands with M8 or M9 compaction hooks)".

Option 1 is better if the teardown path is stable. Option 2 prevents silent no-op subscriptions.

---

### F5 — Medium: `discoverExtensions` and `LoadedExtensionModule` are exported from `agent/extensions/index.ts` but should be internal

**File:** `packages/web-acp-agent/src/agent/extensions/index.ts` (line 18)

```ts
export { discoverExtensions, type LoadedExtensionModule } from './loader';
```

`discoverExtensions` is a loader-level internal; `LoadedExtensionModule` is the raw pre-factory shape. Hosts never need to call `discoverExtensions` directly — they call `ExtensionRegistry.loadAll(...)`. Exposing this from the sub-barrel means it leaks into reachable API surface even if it's not in the top-level barrel.

The spec's public surface in `ai-docs/web-acp/specs/web-acp-agent/index.md` does not list `discoverExtensions` or `LoadedExtensionModule` under the "Boot" or "Extensions" groups. They appear only in the test-utils table comment at the bottom of index.md.

**Suggestion:** Move `discoverExtensions` and `LoadedExtensionModule` out of `agent/extensions/index.ts` and into `test-utils/index.ts` (where the spec says they belong). If there is a host-level use case that genuinely needs `discoverExtensions`, document it in the spec first.

---

### F6 — Medium: `#activeSessionId` is shared state mutated across all dispatch paths; concurrent async dispatches from two sessions could corrupt it

**File:** `packages/web-acp-agent/src/agent/extensions/registry.ts` (lines 118, 504–568)

Every `dispatch*` method follows this pattern:
```ts
this.#activeSessionId = event.sessionId;
try {
  return await this.#runner.dispatch*(event);
} finally {
  this.#activeSessionId = null;
}
```

JavaScript is single-threaded; but `await` suspends execution, allowing other microtasks to run. If two `dispatch*` calls are stacked (e.g., `dispatchBeforeAgentStart` from session A is in flight, and a provider-hook `dispatchBeforeProviderRequest` from the same session fires while an extension's `before_agent_start` handler is awaiting), the second dispatch overwrites `#activeSessionId` with session B (or the same sessionId, harmlessly), and when the first dispatch's `finally` runs, it nulls it out while the second dispatch is still live.

In practice today this risk is low because the agent enforces one-inflight-per-session and the `before_provider_request` hooks are triggered from a different code path (via `getProviderHooks` in `start-agent.ts`), which reads `activeSession.current` (a separate ref) rather than going through the registry's dispatch methods. The registry's `dispatchBeforeProviderRequest` sets `#activeSessionId` from the event, so it is consistent within that call. But the pattern is fragile if a future caller nests dispatches.

**Suggestion:** Document the single-dispatch-at-a-time assumption explicitly in a comment on the `#activeSessionId` field, and add an assertion (DEV-only) that verifies `#activeSessionId` is null before overwriting it in each `dispatch*` method:

```ts
async dispatchSessionStart(event: SessionStartEvent): Promise<void> {
  if (this.#activeSessionId !== null) {
    console.warn('[extensions] dispatchSessionStart called while a dispatch is already active');
  }
  this.#activeSessionId = event.sessionId;
  ...
```

This surfaces the edge case at runtime rather than leaving it as a silent corruption.

---

### F7 — Low: Spec path reference for `well-known-volume-tags.ts` is wrong

**File:** `ai-docs/web-acp/specs/web-acp-agent/extensions.md` (line 662)

The spec says:

> Well-known constants (`AGENT_WD`, `CWD`, `DATA`) ship at
> `packages/web-acp-agent/src/agent/extensions/well-known-volume-tags.ts`

The actual location is:
```
packages/web-acp-agent/src/agent/well-known-volume-tags.ts
```

The file is at `agent/`, not `agent/extensions/`. Hosts and future contributors reading the spec will look in the wrong place.

**Suggestion:** Update `extensions.md` line 662 to reference the correct path: `packages/web-acp-agent/src/agent/well-known-volume-tags.ts`.

---

### F8 — Low: `cleanupOwnedRegistrations` silently does nothing when a tool was later claimed by another extension and then the first extension's `Disposable.dispose()` fires

**File:** `packages/web-acp-agent/src/agent/extensions/registry.ts` (lines 216–235)

When extension `aaa` registers tool `shared`, and then extension `zzz` registers the same tool (last-write-wins, displacing `aaa`), the registry correctly updates `#toolCapabilities` for `aaa` and `zzz`. However, `cleanupOwnedRegistrations` for `aaa`'s dispose path checks `if (reg.ownerExtension === mod.name)` before deleting — meaning it will NOT delete `shared` from `#tools` because `zzz` is now the owner. This is correct and intentional.

The issue is: the `Disposable` returned by `pi.registerTool` in `api.ts` (line 99–103) unconditionally calls `tools.unregister(extensionName, tool.name)`, which only unregisters if the ownerExtension matches. So calling `dispose()` on the `Disposable` returned from `aaa`'s `registerTool` after `zzz` claimed it is a silent no-op. This is correct behavior but there is no test for it, and an extension developer might expect their `Disposable` to always clean up something.

**Suggestion:** Add a test that verifies this boundary: call `registerTool('shared')` from `aaa`, then `registerTool('shared')` from `zzz` (displacing `aaa`), then call `dispose()` on `aaa`'s returned `Disposable`, and assert that `zzz`'s tool is still listed. Document the behavior in the `ToolRegistrar.unregister` JSDoc in `api.ts`.

---

### F9 — Low: No test for `getKnownNames` when cross-mount name collision occurs (first-wins)

**File:** `packages/web-acp-agent/src/agent/extensions/registry.test.ts` (lines 78–95)

The test `first-wins on cross-volume name collision` correctly verifies that `list()` returns only one extension (from mount `a`). But it does not assert `getKnownNames()`. The spec and implementation for `#knownNames` are populated from `discoverExtensions`' return value, which itself applies first-wins — meaning the skipped duplicate from mount `b` is NOT added to `#knownNames`. This is a subtle behavioral difference from the reload case (where disabled extensions ARE in `#knownNames` because `knownNames.add` runs before the disabled check at line 167).

A user might expect that an extension visible on disk but skipped due to a cross-mount name collision still appears in the "known" list (so `/extension list` shows it as a conflict). Currently it does not.

**Suggestion:** Add an assertion to the existing cross-mount collision test:
```ts
expect(registry.getKnownNames()).toEqual(['dup']); // only one, from mount-a
```
And document in `registry.ts` or the spec that `getKnownNames` reflects only discovered-and-loaded names, not filesystem-present names. If the intended behavior is that cross-mount skips should still surface in `knownNames`, fix the loader or the registry accordingly.

---

### N1 — Nit: `GenericExtensionEventHandler` and `ExtensionEventHandler` are the same type but both are exported

**File:** `packages/web-acp-agent/src/agent/extensions/types.ts` (lines 84, 348)
**File:** `packages/web-acp-agent/src/agent/extensions/index.ts` (lines 34, 43)

```ts
// types.ts
export type GenericExtensionEventHandler = (event: unknown) => unknown | Promise<unknown>;
// ...
export type ExtensionEventHandler = GenericExtensionEventHandler;
```

Both names are exported. `GenericExtensionEventHandler` is the definition; `ExtensionEventHandler` is an alias. Only `ExtensionEventHandler` appears in the public barrel (`src/index.ts`). `GenericExtensionEventHandler` is also exported from `agent/extensions/index.ts` (line 43) without appearing in `src/index.ts`. This creates two names for the same type that can cause `instanceof`/assignment confusion in large host codebases.

**Suggestion:** Keep only `ExtensionEventHandler` (the one in the public barrel) and make `GenericExtensionEventHandler` internal (`// internal use` comment, not exported from `index.ts`). Or remove the alias entirely: use `GenericExtensionEventHandler` everywhere including the public barrel.

---

### N2 — Nit: `fakeFs` in `registry.test.ts` has a fragile dual `isFile`/`isDirectory` classification

**File:** `packages/web-acp-agent/src/agent/extensions/registry.test.ts` (lines 5–55)

The `fakeFs` helper is 55 lines of non-trivial logic building directories from path keys. It correctly handles the common cases but has an edge case: a path key that is both in `tree` as a file AND appears as an intermediate dir for a deeper path would result in `isFile: true, isDirectory: true` simultaneously. For example:

```ts
fakeFs({
  '/mnt/a/foo': 'content',
  '/mnt/a/foo/bar': 'content',
})
```

Here `foo` ends up in both `fileChildren` and `dirChildren`. The loader checks `e.isDirectory` first (`.filter(e => e.isDirectory)`) so it would treat `foo` as a directory and miss the fact it's also a file.

This is an unlikely collision in practice (you can't have a path that's simultaneously a file and a directory), but the implementation does not guard against it. More practically, the double-tracking means the `readdir` result returns one entry for `foo` with both `isFile: true` and `isDirectory: true`, which is surprising.

**Suggestion:** In `fakeFs`, if a name is in both `fileChildren` and `dirChildren`, prefer `isDirectory` (since a path with children is logically a directory) and log a warning. Or restructure to use a single classification decision per name.

---

### N3 — Nit: `as const` on `WELL_KNOWN_VOLUME_TAGS` missing a `DATA` tag use in extensions spec

**File:** `packages/web-acp-agent/src/agent/well-known-volume-tags.ts`

The `DATA` tag is declared but never used in the current agent codebase (`grep -r "WELL_KNOWN_VOLUME_TAGS.DATA" packages/web-acp-agent/src` returns nothing). The spec mentions it as "Read-only user data (skill manifests, prompt-template libraries)" and says it is for M7. This is acceptable forward declaration, but there is no usage stub or comment connecting `DATA` to its planned consumer (M7 skills).

**Suggestion:** Add a comment on the `DATA` field: `// Reserved for M7 skill-manifest discovery; not yet consumed by the agent.` This documents its intentionality and helps future reviewers distinguish it from dead code.

---

### N4 — Nit: `#toolCapabilities` naming is misleading — it tracks all capabilities, not just tools

**File:** `packages/web-acp-agent/src/agent/extensions/registry.ts` (line 109)

```ts
readonly #toolCapabilities = new Map<string, ExtensionCapabilities>();
```

`ExtensionCapabilities` has `events`, `tools`, `commands`, and `providers` arrays. The map is used to track all capability types for every extension, not just tools. The name `#toolCapabilities` implies it only holds tool registrations.

**Suggestion:** Rename to `#capabilities`:
```ts
readonly #capabilities = new Map<string, ExtensionCapabilities>();
```
Update all 5 references accordingly.

---

### N5 — Nit: `createExtensionAPI` in `api.ts` ends with `as ExtensionAPI` cast

**File:** `packages/web-acp-agent/src/agent/extensions/api.ts` (line 126)

```ts
  } as ExtensionAPI;
```

The cast exists because the object literal does not satisfy `ExtensionAPI` without it — specifically the `on(event: ExtensionEvent, ...)` overloads. The overloads on `ExtensionAPI` include a catch-all `on(event: ExtensionEvent, handler: GenericExtensionEventHandler)` as the last overload (types.ts line 335), but the implementation object only has a single function `on(event, handler)` that does not explicitly type the overloads.

**Suggestion:** Either (a) make the implementation match the overloads by declaring the function explicitly:
```ts
on: function(event: ExtensionEvent, handler: ExtensionEventHandler): Disposable {
  ...
}
```
or (b) keep the cast but add a comment explaining why it is needed:
```ts
// The `on` method's overload signatures in ExtensionAPI require the cast;
// the runtime implementation accepts any ExtensionEvent + handler pair.
} as ExtensionAPI;
```
Option (b) is acceptable since the cast is sound (the runtime correctly handles every overload). The comment prevents future readers from removing what looks like a style-only cast.

---

## Architecture Constraints Verification

| Constraint                                           | Status                                                                                                               |
| ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| No browser-only deps in types/registry               | PASS — no `@zenfs/dom`, `dexie`, `idb-keyval`, `MessagePort`, `Worker` in any reviewed file                          |
| Extension module identity is factory-function-only   | PASS — `ExtensionFactory` is the sole entry point; extensions receive `pi: ExtensionAPI` only                        |
| Disabled list stored under `extensions:disabled` key | PASS — `EXTENSIONS_DISABLED_KEY = 'extensions:disabled'` in `extensions-prefs.ts`, scoped to `'__global__'` sentinel |
| No imports from `web-agent` or `coding-agent`        | PASS                                                                                                                 |
| No React                                             | PASS                                                                                                                 |

---

## Overall Assessment

The M6 extension runtime is a well-structured, thoughtfully implemented system. The core design decisions — factory-arg-only module identity, data-URL dynamic import for cross-environment portability, per-extension error isolation, event bus with sequential-await semantics, and a pluggable `SessionBridge` — are solid and match the spec's intent.

The test suite is strong. Dispatch chaining (input transform chain, before_agent_start systemPrompt chain, before_provider_request chain, tool_result patch chain), error isolation, last-write-wins conflict resolution, reload lifecycle, and the event bus are all covered with executable extension code running through the actual loader. This gives high confidence in the dispatch logic.

The two High findings need resolution before this code serves as the stable foundation for M7+:

1. **F1** (missing public barrel exports) breaks the library extraction contract — a host using only `@bodhiapp/web-acp-agent` cannot access the event/handler types it needs to implement extension callbacks. This is a mechanical fix.

2. **F2** (commands conflict resolution spec divergence) is a design decision that should be deliberate. If last-write-wins is the chosen behavior, the spec needs an update with rationale. If suffix-deduplication is the intended behavior, the implementation needs updating.

The Medium findings are quality-of-life issues that do not break existing behavior but will surface as surprises for extension authors (`session_shutdown` never firing, `ToolCallEvent.input` readonly signal vs mutation intent). The Low findings are edge cases and missing test coverage that could produce silent incorrect behavior in uncommon scenarios.

No ACP wire protocol violations were found. No browser-only dependencies were introduced. The `PreferenceStore` piggyback for the global disabled list (using a sentinel `__global__` session id) is a pragmatic choice with clear rationale; the constants and helpers are well-tested and documented.
