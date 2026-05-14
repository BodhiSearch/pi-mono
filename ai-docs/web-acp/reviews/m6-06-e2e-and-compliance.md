# Code Review: M6 Extensions — E2E Tests, Wire/ACP Compliance, Public Barrel, Examples

**Commit:** `067bed6a` (M6 phase 0 → phase 14)
**Reviewer scope:** `extensions.spec.ts`, `mock-npm-registry.ts`, `ExtensionsPanelComponent.ts`,
`VolumesPanelComponent.ts`, `install-extensions.ts`, `install-volumes.ts`, `fixtures.ts`,
`tools-and-volumes.spec.ts`, `wire/index.ts`, `src/index.ts` (public barrel),
`storage/session-store.ts`, `builtins.test.ts`, `examples/extensions/*/index.js`
**Date:** 2026-05-07

---

## Summary

The M6 extensions e2e suite is the most thorough Playwright spec in the codebase. All 14
example extensions are seeded, every phase-level callback is exercised end-to-end with real LLM
traffic, and the test architecture is correct (no `waitForTimeout`, no `page.evaluate` into
internals). The wire constants, page objects, and session-store changes are clean.

The main actionable findings are:

1. **Critical** — Public barrel (`src/index.ts`) is missing 30+ extension type exports that the
   spec's public-surface inventory (`ai-docs/web-acp/specs/web-acp-agent/index.md`) lists as
   required. Third-party hosts can't build typed code against the extension API.
2. **Medium** — `extensions.spec.ts` has out-of-order `test.step` labels (phase 10 and phase 8
   steps run after phase 12) causing confusing Playwright report output.
3. **Medium** — `mock-npm-registry.ts` has a redundant `stat()` call after a `withFileTypes`
   `readdir` that already guarantees entry type.
4. **Medium** — Builtins unit test is missing three edge-case scenarios for `/extension on`/`off`
   idempotency (already-enabled, already-disabled, `off` with no name argument).
5. **Low** — `sessions.listIds()` in `SessionPickerComponent` uses `evaluateAll` with a DOM
   attribute read — this is an acceptable narrow case for structured-clone-safe data extraction
   but should be noted as an exception.
6. **Nit** — Several gaps in example coverage and documentation.

---

## Finding 1 — Public barrel missing 30+ extension event/API types (Critical)

**File:** `packages/web-acp-agent/src/index.ts`

**Issue:** The `extensions/index.ts` barrel exports 40+ types that are part of the documented
public surface (`ai-docs/web-acp/specs/web-acp-agent/index.md` §"Extensions" lists all of them).
The production barrel at `src/index.ts` re-exports only a subset. The following types are
missing from the public barrel but are required by host authors who implement their own
extension factories or process extension events:

```
AfterProviderResponseEvent      AfterProviderResponseHandler
BeforeAgentStartEvent           BeforeAgentStartEventResult
BeforeAgentStartHandler         BeforeProviderRequestEvent
BeforeProviderRequestHandler    ExtensionCommandDefinition
ExtensionCommandInfo            ExtensionEventsHandler
ExtensionEventsView             ExtensionSessionView
ExtensionTool                   ExtensionTypeBuilder
ExtensionVolumesView            GenericExtensionEventHandler
InputEvent                      InputEventResult
InputEventSource                InputHandler
InputResultContinue             InputResultHandled
InputResultTransform            ProviderConfig
ProviderModelConfig             ProviderOAuthConfig
ProviderOAuthCredentials        ProviderOAuthLoginCallbacks
ProviderStreamSimple            SessionStartEvent
SessionStartHandler             ToolCallEvent
ToolCallEventResult             ToolCallHandler
ToolResultEvent                 ToolResultEventResult
ToolResultHandler
```

The three internal-only symbols (`SessionBridge`, `discoverExtensions`,
`LoadedExtensionModule`) correctly remain absent from the barrel.

**Fix:** Add a `type`-only re-export block for the missing types to the
`from './agent/extensions'` group in `src/index.ts`:

```ts
export type {
  AfterProviderResponseEvent,
  AfterProviderResponseHandler,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeAgentStartHandler,
  BeforeProviderRequestEvent,
  BeforeProviderRequestHandler,
  ExtensionCommandDefinition,
  ExtensionCommandInfo,
  ExtensionEventsHandler,
  ExtensionEventsView,
  ExtensionSessionView,
  ExtensionTool,
  ExtensionTypeBuilder,
  ExtensionVolumesView,
  GenericExtensionEventHandler,
  InputEvent,
  InputEventResult,
  InputEventSource,
  InputHandler,
  InputResultContinue,
  InputResultHandled,
  InputResultTransform,
  ProviderConfig,
  ProviderModelConfig,
  ProviderOAuthConfig,
  ProviderOAuthCredentials,
  ProviderOAuthLoginCallbacks,
  ProviderStreamSimple,
  SessionStartEvent,
  SessionStartHandler,
  ToolCallEvent,
  ToolCallEventResult,
  ToolCallHandler,
  ToolResultEvent,
  ToolResultEventResult,
  ToolResultHandler,
} from './agent/extensions';
```

Also update `ai-docs/web-acp/specs/web-acp-agent/index.md` §"Public surface" to match
(the spec already lists them — just the code that needs to catch up).

---

## Finding 2 — Out-of-order `test.step` phase labels in `extensions.spec.ts` (Medium)

**File:** `packages/web-acp/e2e/extensions.spec.ts`, lines 173–291

**Issue:** Playwright steps execute sequentially in the order they appear in the source. The
spec has these steps out of order relative to their phase numbers:

```
phase 11 (line 173) — runs before phase 12 (correct)
phase 12 (line 185) — /extension off
phase 12 (line 198) — reload
phase 12 (line 204) — /extension on
phase 10 (line 215) — ping/pong  ← runs AFTER phase 12
phase 10 (line 225) — ping/pong reload
phase 8  (line 243) — session-counter  ← runs AFTER phase 10
phase 8+9 (line 255) — counter reload
phase 13 (line 293) — /extension add
```

Phases 10 and 8/9 are sequenced after phase 12 in execution order. The Playwright HTML report
shows steps out of phase order, and the intent of the progression ("phases 3 → 4 → 5 → …")
becomes unreadable. There is no functional correctness issue because each step is independent
and the full extension set is loaded in phase 2, but the report is confusing and misleading.

**Fix:** Reorder the `test.step` blocks to match execution order. If phase ordering is
intentional (phase 12 tests toggle → reload → restore before exercising events), rename the
phase labels to match the actual order, e.g.:

```
phase 10 — pi.events ping/pong (before phase 12's reload wipes the session)
phase 12 — toggle off / reload / toggle on
phase 8 — session-counter
```

---

## Finding 3 — Redundant `stat()` call in `mock-npm-registry.ts` walk function (Medium)

**File:** `packages/web-acp/e2e/helpers/mock-npm-registry.ts`, lines 91–105

**Issue:** The `walk` function calls `readdir(dir, { withFileTypes: true })`, which returns
`Dirent` objects whose `.isFile()` and `.isDirectory()` methods are already authoritative.
Inside the `else if (entry.isFile())` branch it immediately calls `stat(abs)` and re-checks
`info.isFile()`. This `stat()` call is always redundant (any entry for which `Dirent.isFile()`
returned `true` will also have `stat().isFile() === true`), adds an unnecessary syscall per
file, and imports `stat` from `node:fs/promises` solely for this wasted check.

```ts
// Current (redundant)
} else if (entry.isFile()) {
  const info = await stat(abs);   // ← stat is always true here; remove
  if (!info.isFile()) continue;   // ← dead code
  ...
}
```

**Fix:** Remove the `stat` import and the `stat(abs)` / `info.isFile()` check:

```ts
} else if (entry.isFile()) {
  const rel = '/' + relative(root, abs).split(/[\\/]/).join('/');
  out[rel] = await readFile(abs, 'utf8');
}
```

The companion `walk` in `install-volumes.ts` (line 58) already uses this simpler pattern
correctly. The two helpers are now inconsistent.

---

## Finding 4 — Missing edge-case unit tests in `builtins.test.ts` for `/extension` (Medium)

**File:** `packages/web-acp-agent/src/agent/commands/builtins/builtins.test.ts`, line 296+

**Issue:** The `/extension handler` describe block covers the happy paths for `list`, `off`,
`on`, `add`, and error cases. Three edge cases are absent:

### 4a — `/extension on <name>` when the extension is already active
The `extension.ts` handler calls `current.delete(target)` (no-op on Set if not present) and
then `setDisabled(...)` with an unchanged set. This is functionally safe but the result text
will say `` Extension `pirate` is now enabled `` even if pirate was never disabled. No test
verifies the reply or that `setDisabled` is not called unnecessarily.

### 4b — `/extension off <name>` when the extension is already disabled
Symmetric to 4a: `current.add(target)` is a no-op if already present, `setDisabled` is
called again, and the reply is the same. A unit test would document this idempotency.

### 4c — `/extension off` with no argument
The handler covers `verb === 'off'` and `!target` returning a usage message, but there is no
test for `ext().handler('off', ctx({ extensions: handle }))`.

**Fix:** Add three `it(...)` cases to the `/extension handler` describe block:

```ts
it('re-enabling an already-active extension is a no-op (still calls setDisabled)', async () => {
  const handle = fakeExtensionsHandle({ active: ['pirate'], disabled: [], known: ['pirate'] });
  const result = await ext().handler('on pirate', ctx({ extensions: handle }));
  expect(handle.calls.setDisabled).toHaveLength(1); // called once (idempotent)
  expect(result.replyText).toContain('`pirate` is now enabled');
});

it('disabling an already-disabled extension is a no-op', async () => {
  const handle = fakeExtensionsHandle({ active: [], disabled: ['pirate'], known: ['pirate'] });
  const result = await ext().handler('off pirate', ctx({ extensions: handle }));
  expect(handle.calls.setDisabled).toHaveLength(1);
  expect(result.replyText).toContain('`pirate` is now disabled');
});

it('rejects `/extension off` without a name', async () => {
  const handle = fakeExtensionsHandle({ active: ['pirate'], disabled: [], known: ['pirate'] });
  const result = await ext().handler('off', ctx({ extensions: handle }));
  expect(handle.calls.setDisabled).toEqual([]);
  expect(result.replyText).toMatch(/requires an extension name/i);
});
```

---

## Finding 5 — `sessions.listIds()` uses `evaluateAll` (Low)

**File:** `packages/web-acp/e2e/tests/pages/SessionPickerComponent.ts`, lines 22–26

**Issue:** `listIds()` uses `page.locator(...).evaluateAll(...)` to read `data-sessionid`
attributes from the DOM. Principle 7 prohibits `page.evaluate` reaching into ZenFS/transport
internals; this usage reads a DOM attribute that is explicitly stamped as test data (not an
internal) so it doesn't violate the spirit of the rule. However, it is still `page.evaluate`
under the hood, and this usage could be replaced with a purely locator-based approach.

**Assessment:** Acceptable as written because `data-sessionid` is a test-seam attribute on
the rendered list item, not an access into runtime state. No change strictly required, but a
comment documenting why this is a legitimate `evaluateAll` usage would pre-empt future
confusion during reviews.

**Suggested comment:**

```ts
// `evaluateAll` is used here to batch-read `data-sessionid` DOM attributes from the
// rendered session list. This is a test-seam attribute (not runtime state), so it
// does not violate the principle-7 ban on page.evaluate into internals.
async listIds(): Promise<string[]> { ... }
```

---

## Finding 6 — Wire constants: `BODHI_FEATURE_CONFIG_CATEGORY` inconsistency (Low)

**File:** `packages/web-acp-agent/src/wire/index.ts`, line 303

**Issue:** The config category constant is declared as `'_bodhi/feature'` (singular) while the
config option IDs are `'_bodhi/features/bashEnabled'` (plural). This creates a namespace
mismatch: the category prefix `_bodhi/feature` does not share a prefix with the option IDs
`_bodhi/features/*`, making them visually confusing and inconsistent.

```ts
export const BODHI_FEATURE_CONFIG_CATEGORY = '_bodhi/feature';  // singular
export const BODHI_FEATURE_BASH_ENABLED_CONFIG_ID = '_bodhi/features/bashEnabled';  // plural
```

**Assessment:** The existing behavior is established (changing the literal value would break
persisted data). This is a Nit unless the config category is used as a prefix match, in which
case it is a Low bug. Check `acp/feature-config.ts` to confirm it is used as an exact equality
check, not a prefix filter.

---

## Finding 7 — `hello-passive` example is a no-op (Nit)

**File:** `packages/web-acp-agent/examples/extensions/hello-passive/index.js`

```js
export default function helloPassive(pi) {
  pi.on('session_start', () => {});
}
```

The handler registers a `session_start` listener that does nothing. The e2e test asserts the
`session_start` event chip is present in `ExtensionsPanel`, which is driven by the capability
registration, not the handler body. The example is correct for demonstrating the API shape but
is indistinguishable from a broken handler. A one-line comment explaining this is intentional
would reduce confusion for future readers who wonder why the callback is empty.

**Suggested fix:**

```js
export default function helloPassive(pi) {
  // Records `session_start` in the extension's capability list without doing any work.
  // Used in e2e to confirm the ExtensionsPanel chip appears for a passive observer.
  pi.on('session_start', () => {});
}
```

---

## Finding 8 — `event-bus-ping/index.js` pong reply may create infinite ping-pong loop (Nit)

**File:** `packages/web-acp-agent/examples/extensions/event-bus-pong/index.js`

```js
export default function eventBusPong(pi) {
  pi.events.on('ping', async data => {
    ...
    await pi.events.emit('pong', { from: 'event-bus-pong', seq: payload.seq ?? null });
  });
}
```

And `event-bus-ping/index.js` listens for `'pong'`. This would create an infinite loop if
`event-bus-ping` also emitted a new `'ping'` in its pong handler. It does not — `event-bus-ping`
only listens for pong and appends an entry, it does not re-emit. So the current code is
correct. However, the design is fragile; a future contributor extending `event-bus-ping` might
inadvertently create a cycle. A comment on the pong emitter noting "ping handler does not
re-emit" would prevent this.

---

## Finding 9 — `extensions.spec.ts`: raw `page.locator` calls leak into spec body (Nit)

**File:** `packages/web-acp/e2e/extensions.spec.ts`, lines 175–182 (phase 11), 230–239 (phase 10), 260–290 (phase 8+9)

**Issue:** Several test steps use `page.locator(...)` directly in the spec body rather than
delegating to a page object. Examples:

```ts
// line 175 — model selector
const trigger = page.locator('[data-testid="model-selector"]');

// line 230 — extension entry attributes
const pongSide = page.locator('[data-builtin-command="extension:event-bus-pong:event-bus"]');

// lines 260, 276, 287 — builtin-command locators
page.locator('[data-builtin-command="extension:session-counter:counter"]')
```

The principle-7 test discipline calls for page objects to own all locators. The
`ExtensionsPanelComponent` object owns extension-row locators, but the extension entry bubble
locators (which are rendered via `MessageBubble.data-builtin-command`) are not encapsulated
anywhere. The model selector selector is also in `page.locator` inline.

**Assessment:** This is not a violation of the core rule (no `page.evaluate` into internals),
but it does produce fragile selectors inline in the spec. The `MessagesView` class would be
the right home for a `extensionEntryByType(extensionName, customType)` helper.

**Suggested fix:** Add to `MessagesView`:

```ts
extensionEntry(extensionName: string, customType: string): Locator {
  return this.page.locator(
    `[data-builtin-command="extension:${extensionName}:${customType}"]`
  );
}
```

And move the model-selector interaction in phase 11 into `ChatPage` or a new
`ModelSelectorComponent`.

---

## Finding 10 — `install-extensions.ts` only reads `index.js`, no multi-file support (Nit)

**File:** `packages/web-acp/e2e/helpers/install-extensions.ts`, lines 23–29

```ts
export async function readExampleExtension(name: string): Promise<Record<string, string>> {
  const path = join(AGENT_EXAMPLES_DIR, name, 'index.js');
  const source = await readFile(path, 'utf8');
  return { [`/.pi/extensions/${name}/index.js`]: source };
}
```

This helper only reads `index.js`. If a future multi-file example extension is added (or if
`package.json` needs to be seeded alongside `index.js` for the extension's `pi.types` to
resolve), this helper will need to be extended. The `pi-greet-fixture` example already has
both `index.js` and `package.json` but its `package.json` is only used via `mockNpmPackage`,
not via `readExampleExtension`.

**Assessment:** Not a current bug since all current examples are single-file. Consider adding
a `readExampleExtensionDir(name)` variant that walks the full directory (like `mock-npm-registry`
does) for future proofing.

---

## E2E Test Quality Assessment

| Criterion | Status | Notes |
|---|---|---|
| No `waitForTimeout` | Pass | Confirmed via grep — zero occurrences |
| No `page.evaluate` into internals | Pass | Only legitimate use: `evaluateAll` for DOM attribute batch-read in `SessionPickerComponent.listIds` |
| `data-testid` + `data-test-state` used correctly | Pass | `ExtensionsPanelComponent` uses `data-test-state` for count and `data-test-state` on rows for mount-name |
| `test.step` used liberally | Pass | 17 steps in one test — each step carries explicit assertions |
| Black-box (no internal state access) | Pass | Extension state observed via `ExtensionsPanelComponent` chips, `MessagesView` bubbles |
| Phase ordering readable | Fail | Steps 14–16 are out of order relative to phase labels (Finding 2) |
| Page object encapsulation | Partial | Most locators in page objects; some raw `page.locator` in spec body (Finding 9) |

---

## Wire/ACP Compliance Assessment

| Constant | Namespace | Status |
|---|---|---|
| `BODHI_EXTENSIONS_LIST_METHOD` | `_bodhi/extensions/list` | Correct |
| `BODHI_EXTENSIONS_RELOAD_METHOD` | `_bodhi/extensions/reload` | Correct |
| `BODHI_EXTENSIONS_ADD_METHOD` | `_bodhi/extensions/add` | Correct |
| `BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD` | `_bodhi/extensions/state` | Correct |
| `BODHI_MCP_TOGGLES_SET_METHOD` | `_bodhi/mcp/toggles/set` | Correct |
| `BODHI_FEATURE_BASH_ENABLED_CONFIG_ID` | `_bodhi/features/bashEnabled` | Correct |
| `BODHI_FEATURE_CONFIG_CATEGORY` | `_bodhi/feature` (singular) | Inconsistent with plural IDs — see Finding 6 |

All new `_bodhi/extensions/*` methods are declared as constants in `wire/index.ts` — none are
inlined at call sites. Principle 15 is satisfied.

---

## Session Store Backward Compatibility Assessment

**File:** `packages/web-acp-agent/src/storage/session-store.ts`

The M6 additions are:
- `SessionEntryKind` gains `'extension'` as a new union member
- `ExtensionPayload` interface is added
- `recordExtension(...)` and `setExtensionLabel(...)` are added to `SessionStore`

**Backward compatibility:** The comment at line 16 correctly explains why adding a new
`SessionEntryKind` is on-disk safe: entries keyed by `[sessionId+seq]` and the Dexie schema
does not index on `kind`. Existing rows with `kind: 'turn'` or `kind: 'builtin'` are
unaffected. New rows with `kind: 'extension'` are simply unknown to older code versions and
would be skipped by any replay logic that doesn't recognise the new kind — this is documented
behavior ("the host decides how to render it and may ignore unknown `customType`s").

No schema version bump is required by the design and none is present. This is correct.

**One risk:** The new `SessionStore` interface methods (`recordExtension` and
`setExtensionLabel`) are additive to the interface. Any host that implemented the interface
before M6 without these methods will have a TypeScript error but no runtime crash (since the
agent only calls them via the extensions bridge). A migration note in the spec would help.

---

## Examples Quality Assessment

| Example | API usage | Correctness |
|---|---|---|
| `hello-passive` | `pi.on('session_start', ...)` | Correct (no-op handler; see Finding 7) |
| `hello-tool` | `pi.registerTool(...)` | Correct; uses `pi.types` alias appropriately |
| `pirate` | `pi.on('before_agent_start', ...)` returns `{ systemPrompt }` | Correct |
| `claude-rules` | `pi.volumes.list()`, `pi.fs.readdir()`, uses boolean `entry.isFile` | Correct — `ExtensionsFsEntry.isFile` is a boolean, not a method |
| `input-transform` | `pi.on('input', ...)` checks `event.source` | Correct |
| `protected-paths` | `pi.on('tool_call', ...)` returns `{ block, reason }` | Correct |
| `redact-secrets` | `pi.on('tool_result', ...)` returns `{ content }` | Correct |
| `commands` | `pi.registerCommand('volumes', ...)` uses `pi.volumes.list()` | Correct |
| `session-counter` | `pi.session.appendEntry(...)` from `session_start` and `before_agent_start` | Correct |
| `provider-payload` | `pi.session.appendEntry(...)` from provider hooks | Correct |
| `rate-limit-watch` | `event.headers` access in `after_provider_response` | Correct; handles missing header gracefully |
| `event-bus-ping` | `pi.events.on/emit` | Correct; see Finding 8 for fragility note |
| `event-bus-pong` | `pi.events.on/emit` | Correct |
| `custom-provider-anthropic` | `pi.registerProvider(...)` with `oauth` block | Correct; OAuth callbacks use scaffolded pattern |
| `pi-greet-fixture` | `pi.registerCommand(...)` + `package.json` with `pi.extensions` | Correct; serves as install-flow fixture |

---

## Overall Assessment

**Ship status: Ship with follow-ups.**

The M6 extensions e2e suite is high quality — comprehensive, black-box, uses `data-test-state`
correctly, zero `waitForTimeout`. The wire constants are properly namespaced and consistent.
The session-store addition is backward-compatible. The example extensions demonstrate all 14
phases clearly.

The single Critical finding (missing barrel exports) must be fixed before the package can be
consumed by TypeScript extension authors — it is straightforward to add and carries no
behavioral risk. The Medium findings (test-step ordering, redundant stat, missing unit test
cases) are improvements rather than blockers. The Nit findings are quality of life.

**Priority order for follow-ups:**
1. Fix public barrel (Critical, Finding 1) — add the 35 missing type exports
2. Reorder or relabel test steps (Medium, Finding 2) — Playwright report clarity
3. Remove redundant `stat()` in `mock-npm-registry.ts` (Medium, Finding 3)
4. Add three idempotency unit tests for `/extension` (Medium, Finding 4)
5. Add `extensionEntry` helper to `MessagesView` (Nit, Finding 9)
