# Code Review — M6 Extension Runtime: Runner, API, Loader, Event Bus, ExtensionsFs

**Commit:** `067bed6a` (M6 phase 0 plan + all shipped phases)
**Reviewer scope:** `runner.ts`, `api.ts`, `loader.ts`, `event-bus.ts`, `extensions-fs.ts`, `builtins/extension.ts`, `builtins/types.ts`, `builtins/index.ts`
**Supporting context read:** `registry.ts`, `types.ts`, `install.ts`, `prompt-driver.ts`, `start-agent.ts`, `extensions.md` (spec)
**Review date:** 2026-05-07

---

## Summary

The extension runtime is well-structured. Error isolation at the handler level is thorough, the factory-arg-only module-identity posture is correctly enforced, the data-URL loader is a clean solution for cross-environment compatibility, and the event bus correctly sequences async handlers. The findings below are mostly low-to-medium severity — the three higher-severity items are a spec inconsistency, a provably broken mutation path, and a missing `ExtensionsFs` sandbox boundary.

---

## Findings

### 1. Spec inconsistency: command conflict resolution is defined two ways

**Severity: High** (spec-vs-code divergence; blocks correct user-facing documentation)

**Files:** `ai-docs/web-acp/specs/web-acp-agent/extensions.md` lines 157–160 vs. line 362

The "Conflict resolution" table (§ "Conflict resolution") says:

> **Commands** (`pi.registerCommand`): load-order suffix. Two extensions registering `/foo` → first gets `/foo`, second gets `/foo-2`, third gets `/foo-3`. Picker advertises both.

The `pi.registerCommand` section (§ "Phase 7") says:

> Conflict resolution is **last-write-wins**.

The code in `registry.ts:359–385` implements **last-write-wins with a warning** — the second registration silently replaces the first owner and removes the first from that extension's capability list. Neither "load-order suffix" logic nor a suffix-numbered name is implemented anywhere.

**Impact:** An extension that calls `pi.registerCommand('foo', ...)` when another already owns `/foo` silently steals the slot; the prior owner's disposable still calls `unregister('foo')` but may be called too late; users reading the spec expect suffixed coexistence.

**Fix:** Update the conflict resolution table to say **last-write-wins** (matching the implementation and the Phase 7 section). If suffix semantics were ever intended, they need to be implemented — but there is no evidence that is the case. A one-line update to the table is the minimal correct fix:

```
- **Commands** (`pi.registerCommand`): **last-write-wins** on command name.
  The second extension to register `/foo` evicts the first; a structured
  warning is logged against the prior owner. Picker advertises the current owner.
```

---

### 2. `ToolCallEvent.input` mutation does not reach `tool.execute` (no e2e, but a code-path lie)

**Severity: High** (documented feature that silently no-ops; spec says it "is allowed")

**Files:**
- `packages/web-acp-agent/src/agent/extensions/types.ts:103` — `readonly input: Record<string, unknown>`
- `packages/web-acp-agent/src/acp/engine/prompt-driver.ts:192–200`
- `ai-docs/web-acp/specs/web-acp-agent/extensions.md` (Phase 6 row, tool_call)

The spec says:

> Mutating `event.input` in place (e.g. rewriting a path argument) is allowed but Phase 6 has no e2e for the rewrite path.

In `prompt-driver.ts` the `beforeToolCall` callback passes `event.input` as `argsRecord`:

```ts
const argsRecord =
  toolCtx.args && typeof toolCtx.args === 'object'
    ? (toolCtx.args as Record<string, unknown>)
    : {};
const result = await extensions.dispatchToolCall({
  type: 'tool_call',
  sessionId,
  toolName: toolCtx.toolCall.name,
  input: argsRecord,   // <-- same reference as toolCtx.args
});
```

A handler that mutates `event.input` is mutating `argsRecord`, which IS `toolCtx.args` (same reference). Whether that mutation actually reaches `tool.execute` depends entirely on whether `pi-agent-core` re-reads `toolCtx.args` before calling the tool. The pi-agent-core `BeforeToolCallContext.args` field is typed as `unknown` and the `Agent` class validates args at entry; the validated object passed to `tool.execute` may be a clone or a different reference. Without an e2e test this is a silent no-op for extensions that rely on it.

The **TypeScript type** `readonly input` also actively misleads authors: extension code cannot write `event.input = { ... }` (reassignment blocked by TypeScript) but can silently mutate properties (`event.input['key'] = 'newValue'`), which may or may not take effect.

**Fix (minimal):** Add a comment to `ToolCallEvent` making the current status unambiguous:

```ts
export interface ToolCallEvent {
  readonly type: 'tool_call';
  readonly sessionId: string;
  readonly toolName: string;
  /**
   * Validated tool arguments. Property mutations are forwarded to the
   * underlying `pi-agent-core` call IF and only IF `pi-agent-core`
   * does not clone args between `beforeToolCall` and `tool.execute`.
   * Until Phase 6 ships an e2e for the rewrite path, treat this as
   * **read-only** in extension code.
   */
  readonly input: Record<string, unknown>;
}
```

**Fix (proper):** Add a vitest unit test that mutates `event.input` inside a `tool_call` handler and asserts the tool sees the mutated value. This will either confirm the path works (spec-accurate) or prove it silently no-ops (fix the spec to say read-only).

---

### 3. `ExtensionsFs` has no path-sandbox boundary — extensions can read any mounted path

**Severity: Medium**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/extensions-fs.ts`
- `packages/web-acp-agent/src/agent/extensions/api.ts:55–56`
- `ai-docs/web-acp/specs/web-acp-agent/extensions.md` § "pi.fs (Phase 3)"

The spec says:

> Extensions read vault content with absolute paths under `/mnt/<mountName>/...`

The `ExtensionsFs` interface has:

```ts
readdir(absolutePath: string): Promise<ExtensionsFsEntry[]>
readFile(absolutePath: string): Promise<string>
```

There is no guard in `createZenfsExtensionsFs()` (or anywhere in the call chain) that restricts paths to `/mnt/...` or prevents an extension from reading `/sessions/...` or `/.pi/...`. Since ZenFS mounts `/sessions` and `/extensions` as app-owned IndexedDB backends, a malicious or buggy extension could read session data or other extensions' source code by passing a path like `/sessions/<id>/messages.jsonl`.

This is mitigated somewhat by the fully-trusted trust model documented in the spec (§ Hard constraints § 3: "Trust model: fully trusted. A misbehaving extension can take the agent down.") but the spec's Phase 3 prose implies read access is intended to be scoped to vault content, not to app-owned IndexedDB mounts.

**Fix:** Since the trust model is fully trusted, this is a documentation clarity issue more than a code fix. Update the spec's `pi.fs` section to explicitly state that extensions may read any ZenFS-mounted path (not just `/mnt/...`), or add a cheap prefix guard to `createZenfsExtensionsFs` that rejects paths not starting with `/mnt/`:

```ts
const assertMntPath = (path: string) => {
  if (!path.startsWith('/mnt/')) {
    throw new Error(`[extensions] pi.fs: access outside /mnt/ denied ('${path}')`);
  }
};
```

If intentional cross-mount access is needed, let registries control the injected `ExtensionsFs` instance, which already flows through `createExtensionAPI`.

---

### 4. `dispatchBeforeProviderRequest` sets `#activeSessionId` via registry dispatch, but provider hooks read it from a separate `ActiveSessionRef`

**Severity: Medium**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/registry.ts:551–556` — `dispatchBeforeProviderRequest` sets `#activeSessionId` via the registry's own dispatch method
- `packages/web-acp-agent/src/api/start-agent.ts:70–93` — `buildProviderHooks` reads from a separate `activeSession: ActiveSessionRef` (captured in a closure at session start)
- `ai-docs/web-acp/specs/web-acp-agent/extensions.md` § "Provider hooks (Phase 9)"

The spec says `pi.session.getId()` should return the active session id inside `before_provider_request` / `after_provider_response` handlers. The registry's `dispatchBeforeProviderRequest` sets `this.#activeSessionId = event.sessionId` before calling the runner, so `pi.session.getId()` will return the correct id during dispatch.

However, the `buildProviderHooks` in `start-agent.ts` is called **lazily** (it's a closure that re-reads `activeSession.current` at call time), and then calls `extensions.dispatchBeforeProviderRequest(...)` which sets the registry's internal `#activeSessionId`. This is fine IF the registry's dispatch is always entered through `registry.dispatchBeforeProviderRequest`. Verify that no call site bypasses the registry and goes directly to `runner.dispatchBeforeProviderRequest(...)`. A search confirms `runner` is never exposed publicly, so this is safe.

The actual concern is subtler: `buildProviderHooks` captures `activeSession.current` (the `PromptTurnDriver`-controlled ref) at hook-build time (line 75: `const sessionId = activeSession.current`). This is then used to construct the event. The registry's dispatch will correctly set `#activeSessionId = event.sessionId`. But if a streaming turn takes long enough that the session closes mid-stream (e.g., concurrent cancel), `activeSession.current` could be `null` at hook-build time, causing `buildProviderHooks` to return `undefined` — silently skipping the dispatch. This is a race condition rather than a definitive bug, but worth noting.

**Fix:** Add a comment in `buildProviderHooks` noting the `activeSession.current` snapshot-at-closure-time behavior:

```ts
// activeSession.current is read here (at hook-build time, before each streamSimple call)
// by the PromptTurnDriver contract. If cancelled mid-turn the value may be null, causing
// the hook to be skipped. This is intentional — cancelled turns do not fire provider hooks.
const sessionId = activeSession.current;
```

No code change needed if the current behavior is intentional.

---

### 5. Event-bus infinite loop between extensions is possible and undetected

**Severity: Medium**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/event-bus.ts:36–47`

The event bus sequences handlers in subscription order and awaits each. A handler that calls `bus.emit(sameChannel, ...)` will create a recursive call chain that will exhaust the stack (for sync scenarios) or spin indefinitely (for async scenarios where each recursive `emit` awaits the next, including its own re-subscriber).

Example: Extension A listens on `'ping'` and emits `'ping'` back. `emit('ping', data)` calls handlerA → handlerA calls `emit('ping', data)` → calls handlerA → ... stack overflow.

The `[...handlers]` snapshot on line 40 means a handler added during emit is not in the snapshot, which prevents some infinite loops. But handlers present at emit time that re-emit the same channel are not protected.

**Fix (minimal):** Add a depth guard per channel:

```ts
const inflight = new Set<string>();

async emit(channel, data) {
  if (inflight.has(channel)) {
    console.warn(`[extensions] pi.events: recursive emit on '${channel}' ignored`);
    return;
  }
  inflight.add(channel);
  try {
    const handlers = channels.get(channel);
    if (!handlers || handlers.size === 0) return;
    for (const handler of [...handlers]) {
      try { await handler(data); }
      catch (err) { console.error(...); }
    }
  } finally {
    inflight.delete(channel);
  }
}
```

This mirrors the `event-bus-pong` example in the spec (ping→pong→ping is a valid cross-channel pattern; same-channel recursion is a bug). The guard only blocks same-channel recursion, leaving cross-channel patterns free.

**Alternative:** Document in `pi.events` API jsdoc that re-emitting on the same channel from a handler causes a stack overflow. The simple note may be sufficient given the fully-trusted extension model.

---

### 6. `registerTool` disposable does not record the unregister in capabilities

**Severity: Medium**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/api.ts:97–105`
- `packages/web-acp-agent/src/agent/extensions/registry.ts:476–501`

When an extension calls `pi.registerTool(tool)`, the API records the tool in `capabilities.tools` via `recorder.recordTool(tool.name)`. The returned disposable calls `tools.unregister(extensionName, tool.name)`. The unregister removes the tool from `#tools` (good) but does **not** remove the name from `capabilities.tools` (the capability recorder's list). After disposal:

- `_bodhi/extensions/list` still advertises the tool in `ExtensionInfo.capabilities.tools`.
- The tool is no longer callable (it was removed from `#tools` so `listTools()` won't return it).

The dangling capability entry is confusing for host-rendered Extensions panels.

The same issue applies to `registerCommand` and `registerProvider` disposables (missing capability cleanup on manual dispose, though the cleanup logic exists for last-write-wins evictions via `cleanupOwnedRegistrations`).

**Fix:** Update the registrar `unregister` path (or the dispose closures in `api.ts`) to also remove from the capability list:

```ts
// In api.ts registerTool:
const disposable: Disposable = {
  dispose() {
    tools.unregister(extensionName, tool.name);
    // Remove from recorded capabilities:
    recorder.removeTool(tool.name);  // needs new CapabilityRecorder method
  },
};
```

Or have the registrar accept a capability recorder and handle it internally. Whichever is cleaner.

---

### 7. Factory-validation in loader does not call the factory — type check only

**Severity: Low**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/loader.ts:100–107`

The loader validates that `mod.default` is a function. This is the correct and only validation possible (no schema exists for the factory). The comment in the spec is clear about this. However, the error message says "has no default-exported factory function (got `${typeof factory}`)" but does not include the module name / source path clearly in the user-facing console output when the `warn` function is the default. The first arg already includes the path:

```ts
warn(`[extensions] '${sourcePath}' has no default-exported factory function (got ${typeof factory})`);
```

This is fine. No action needed — calling this out as a nit.

---

### 8. `registerTool` returns a disposable even when registration was rejected

**Severity: Low**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/api.ts:96–105`

When `tools.register(...)` returns `false` (rejected because the tool name is invalid), the API still returns a disposable whose `dispose()` calls `tools.unregister(...)`. The unregister is a no-op (the tool is not in the map for this extension), so no harm is done. But calling `dispose()` on a rejected registration is semantically odd — the returned `Disposable` is a no-op.

The same applies to `registerCommand` and `registerProvider` when registration is rejected.

**Fix (cosmetic):** Return a null-object disposable that logs a warning when disposed:

```ts
if (!accepted) {
  return { dispose() {} }; // or a logging no-op
}
```

The current code already returns the no-op variant (unregister on a non-owned slot is a no-op), so this is a documentation / clarity issue only.

---

### 9. `BuiltinExtensionsHandle.disabled()` returns a mutable `readonly string[]` snapshot that callers can construct a `Set` from — acceptable but worth noting

**Severity: Nit**

**Files:**
- `packages/web-acp-agent/src/agent/commands/builtins/types.ts:70–71`
- `packages/web-acp-agent/src/agent/commands/builtins/extension.ts:64`

`ctx.extensions.disabled()` returns `readonly string[]`. In `extension.ts:64` it is immediately spread into a `new Set(...)`. This is fine — `readonly` prevents assignment of the array reference but spread still works. The naming `disabled()` returning `readonly string[]` is consistent with how `active()` and `known()` work. No action needed; noting for awareness.

---

### 10. `encodeBase64Utf8` binary conversion loop is O(n) character concatenation

**Severity: Nit**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/loader.ts:114–128`

```ts
let binary = '';
for (const byte of bytes) binary += String.fromCharCode(byte);
return globals.btoa(binary);
```

String concatenation in a loop creates O(n²) intermediate strings in older JS engines. Extension source files are typically < 50 KB; at that scale this is imperceptible. For larger extensions it will be slow.

**Fix:** Use `String.fromCharCode(...bytes)` or accumulate into an array then join:

```ts
return globals.btoa(String.fromCharCode(...bytes));
// or for large files:
const chunks: string[] = [];
for (let i = 0; i < bytes.length; i += 65536) {
  chunks.push(String.fromCharCode(...bytes.subarray(i, i + 65536)));
}
return globals.btoa(chunks.join(''));
```

The spread approach (`String.fromCharCode(...bytes)`) stack-overflows for very large buffers (> ~65K bytes). The chunked version is safe for any size.

---

### 11. `extension.ts` slash command: the `known()` check for `on`/`off` uses the discovered name list, not the active-or-disabled list

**Severity: Nit**

**Files:**
- `packages/web-acp-agent/src/agent/commands/builtins/extension.ts:58–63`

```ts
const known = ctx.extensions.known();
if (!known.includes(target)) {
  return { replyText: `Unknown extension \`${target}\`. Known: ...` };
}
```

`known()` returns every name the loader has ever discovered (including disabled). This means `/extension on <name>` works even for extensions discovered but currently disabled — which is the intended behavior (you want to be able to re-enable them). The check is correct. No issue; noting it was examined.

---

### 12. `dispatchToolCall` runner comment says "first `block` wins" but inner loop does not short-circuit extension iteration

**Severity: Nit**

**Files:**
- `packages/web-acp-agent/src/agent/extensions/runner.ts:113–134`

The docstring says "The first `block` wins and stops the chain." The code does return early on the first blocking result. However, it only checks the current subscription's result before returning — it correctly breaks out of both loops (the inner `for...of sub` and the outer `for...of ext`) because `return` exits the method entirely. The behavior is correct; the comment is accurate. No issue.

---

## Architecture constraint checks

| Constraint | Result |
|---|---|
| No browser-only deps at runtime | Pass — `@zenfs/dom`, `idb-keyval`, `dexie`, `MessagePort`, `Worker`, `FileSystemDirectoryHandle` are absent from the reviewed files. |
| No Node-only deps | Pass — `node:*`, `fs`, `child_process` are absent. `btoa` has a `Buffer` fallback for Node environments, correctly gated. |
| Factory-arg-only module identity | Pass — `createExtensionAPI` provides `pi` as the only surface; no shared imports leak through. |
| Data URL (not blob URL) for loader | Pass — `data:text/javascript;base64,...` scheme is used; Blob/URL.createObjectURL are absent. |
| Error isolation — one extension cannot crash others | Pass — every dispatch method in `runner.ts` wraps each handler in try/catch; `registry.ts` wraps factory invocation in try/catch and continues. `dispose()` also wraps in try/catch. |
| ACP as wire protocol | Not directly applicable to these files; extension callbacks produce local in-process effects, not bespoke ACP messages. |
| `_bodhi/*` namespace for extension methods | Pass for the wire methods; not applicable to the in-process event bus. |

---

## Overall Assessment

The extension runtime is solid. The core design decisions — factory-arg-only API, data-URL loader, per-subscription `disposed` flag, per-handler try/catch in the runner, capability recorder + cleanup on dispose, separate `ExtensionEventBus` from lifecycle events — are all correct and well-executed.

Three items warrant attention before M7:

1. **Finding 1 (spec inconsistency):** The command conflict resolution table says "load-order suffix" but the code does "last-write-wins". The spec needs to be corrected or the code does (one-line fix either way).

2. **Finding 2 (`tool_call` input mutation):** The spec documents a mutation path that may silently no-op. Needs either a vitest unit test confirming it works or a spec correction saying it doesn't. Leaving it undecided until M7 is acceptable only if a TODO is added.

3. **Finding 3 (ExtensionsFs sandbox):** `pi.fs` exposes the full ZenFS VFS including app-owned mounts. Acceptable under the fully-trusted model, but the spec should say so explicitly rather than implying `/mnt/...` scoping.

Findings 4–12 are low severity and can be tracked as follow-ups.
