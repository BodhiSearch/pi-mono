# Code Review: M6 Browser Host Layer
**Commit:** `067bed6a` — web-acp M6 phase 0-14 (extensions runtime)
**Scope:** Browser host layer (`packages/web-acp/src/`)
**Reviewer focus:** Extension wiring, React correctness, one-worker invariant, type safety, ACP surface completeness

---

## Summary

The M6 host-layer changes are generally correct and well-structured. The architecture decisions (slash-command-driven enable/disable, notification-driven refresh, worker-side loading) are sound. Seven findings of Low–Medium severity; no Critical or High findings. The most notable issue is a race window in `useExtensions` between the initial `listExtensions()` fetch and the `onExtNotification` subscription (Medium). Everything else is Low or Nit.

---

## Findings

### 1. Race window in `useExtensions`: subscription registered after async fetch

**File:** `packages/web-acp/src/hooks/useExtensions.ts:36–56`
**Severity:** Medium

The effect fires an unguarded `listExtensions()` Promise, then — in the same synchronous tick — registers the `onExtNotification` subscription. Because the subscription is set up in the same synchronous continuation (no await between the `.then()` call and `onExtNotification`), this is actually fine for the subscription. However the fetch and the subscription are coupled with no ordering guarantee: if the agent emits a `_bodhi/extensions/state` notification *before* the `listExtensions()` Promise resolves (possible if a session event races boot), the notification updates state to `X`, then the fetch completes and overwrites state with whatever was snapshotted at call-time (potentially stale). The net result is a momentary incorrect panel count that self-corrects on the next notification.

```ts
// useExtensions.ts:36-56 — subscription is registered synchronously after
// the fetch is *initiated*, but the fetch completion may arrive AFTER
// a state notification has already set correct state.
runtime.client
  .listExtensions()             // async: may settle after a state notification
  .then(list => {
    if (cancelled) return;
    setState({ entries: list, error: null });   // ← may overwrite newer state
  })
  ...
const unsubscribe = runtime.client.onExtNotification(...)  // registered sync
```

**Fix:** Use a logical sequence number or version counter to discard fetch results that arrive after a state notification:

```ts
let fetchSeq = 0;
const localSeq = ++fetchSeq;
runtime.client.listExtensions().then(list => {
  if (cancelled || fetchSeq !== localSeq) return;
  setState({ entries: list, error: null });
});
const unsubscribe = runtime.client.onExtNotification((method, params) => {
  if (method !== BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD) return;
  fetchSeq++; // invalidate any in-flight fetch
  ...
  setState({ entries: next, error: null });
});
```

Alternatively, initialise state from the notification if it arrives first and only fall back to the fetch if no notification has arrived.

---

### 2. `useExtensions` calls `listExtensions()` without awaiting `runtime.initialize`

**File:** `packages/web-acp/src/hooks/useExtensions.ts:36–50`
**Severity:** Low

Every other hook that issues an ACP call on `isAuthenticated` flip (`useAcpSession`, `useAcpAuth`) first awaits `runtime.initialize` before issuing the call. `useExtensions` calls `listExtensions()` directly against `runtime.client` without awaiting `runtime.initialize`, relying implicitly on the fact that `isAuthenticated` will only be `true` after `useAcpAuth` has completed, which itself awaits `initialize`. That dependency chain is correct today but is a fragile coupling: if the ordering of slice hooks inside `useAcp` changes, or if `isAuthenticated` is passed from a context that fires before auth completes, `listExtensions()` will race the ACP handshake.

**Fix:** Add an explicit guard:

```ts
await runtime.initialize;
const list = await runtime.client.listExtensions();
```

This mirrors the pattern used in `useAcpSession.ts:89`, `useAcpAuth.ts:88`, etc.

---

### 3. `useExtensions` has two separate `onExtNotification` listeners (double-listener pattern)

**File:** `packages/web-acp/src/hooks/useAcpStreaming.ts:71–84` and `packages/web-acp/src/hooks/useExtensions.ts:51–56`
**Severity:** Low

Both `useAcpStreaming` and `useExtensions` independently call `runtime.client.onExtNotification(...)`. The `useAcpStreaming` listener explicitly no-ops on `BODHI_EXTENSIONS_STATE_NOTIFICATION_METHOD` (line 82–83) with a comment. This is correct but represents a non-obvious implicit contract: the extension state notification is handled by `useExtensions`, not by the streaming reducer. There's no enforcement of this division; a future contributor adding a case in `useAcpStreaming` might accidentally handle it there too and produce a double state update.

**Fix (documentation only):** The comment in `useAcpStreaming` is good but brief. Expand it and add a reciprocal note in `useExtensions` referencing the paired design:

```ts
// useAcpStreaming.ts:82-83 — EXTENDED comment
// Extensions panel update is deliberately split out to useExtensions
// (which also owns the boot-time `listExtensions()` fetch).
// Only one consumer should write the extensions slice; keep it that way.
```

Alternatively, route all extNotification dispatch through a single registered listener in `useAcpStreaming` and use a callback prop/context to reach `useExtensions` state — but that is more invasive and the current approach is acceptable at this scale.

---

### 4. `acp/index.ts` exports `BodhiExtensionsReloadRequest/Response` but `AcpClient` has no `reloadExtensions()` method

**File:** `packages/web-acp/src/acp/index.ts:31–32`, `packages/web-acp/src/acp/client.ts`
**Severity:** Low

`BODHI_EXTENSIONS_RELOAD_METHOD`, `BodhiExtensionsReloadRequest`, and `BodhiExtensionsReloadResponse` are re-exported from `acp/index.ts` but `AcpClient` has no `reloadExtensions()` method consuming them. The reload flow is entirely slash-command driven (`/extension reload`) and does not need a direct host-side ACP call — the agent handles it and broadcasts `_bodhi/extensions/state` which `useExtensions` already subscribes to. The re-exports therefore create dead types in the host barrel that suggest a method exists that doesn't.

**Fix (two options):**
- Remove the `BodhiExtensionsReload{Request,Response}` re-exports from `acp/index.ts` until a `reloadExtensions()` host method is actually added.
- Alternatively, add a `reloadExtensions()` method to `AcpClient` if a future host UI button will call it directly (e.g. a "Reload" button in `ExtensionsPanel`). Add a TODO comment tracking this.

---

### 5. `ExtensionsPanel` has no toggle controls despite `disabled`/`knownNames` being available in the state notification

**File:** `packages/web-acp/src/components/extensions/ExtensionsPanel.tsx`
**Severity:** Low

The `_bodhi/extensions/state` notification carries `disabled: string[]` and `knownNames: string[]` alongside `extensions: BodhiExtensionDescriptor[]`. The `useExtensions` hook discards `disabled` and `knownNames` (only storing `entries`). The panel therefore has no way to show the user which extensions are disabled, or to provide a toggle. The M6 design routes enable/disable through the `/extension on|off` slash command, which is intentional for Phase 12 of M6. However there is no code comment in `ExtensionsPanel` or `useExtensions` noting this constraint and pointing at the deferred follow-up.

**Fix:** Add a comment in both files:

```ts
// ExtensionsPanel.tsx: Toggle/reload actions are intentionally absent in M6 —
// use the `/extension on|off` and `/extension reload` slash commands.
// See ai-docs/web-acp/milestones/deferred.md § "Extension settings panel".

// useExtensions.ts: `disabled` and `knownNames` from the state notification
// are dropped here — the panel currently only renders active extensions.
// Re-surface when a settings-panel toggle UI lands (M6 deferred).
```

---

### 6. `data-test-state` on `extensions-panel` encodes count as a string, inconsistent with established convention

**File:** `packages/web-acp/src/components/extensions/ExtensionsPanel.tsx:12`
**Severity:** Nit

```tsx
data-test-state={String(entries.length)}
```

The `data-test-state` attribute is documented in `steering/04-principles.md` § 7 for **state assertions** (`idle|mounting|mounted|error`), not for count values. Count observability is better served by a dedicated `data-test-count` attribute or by asserting on the number of child elements. Using `data-test-state` for a count breaks the convention that Playwright can `toHaveAttribute('data-test-state', 'mounted')` — a count-based value requires a dynamic assertion (`toBe('3')`) which is more fragile.

**Fix:**

```tsx
<section
  data-testid="extensions-panel"
  data-test-count={String(entries.length)}
  className="border-b bg-gray-50"
>
```

Note that `VolumeRow.tsx:30` has the same pattern (`data-test-state={String(entry.tags.length)}`), so any fix should be applied consistently.

---

### 7. `agent-worker.ts` does not await `startAgent()` — boot errors are silently lost

**File:** `packages/web-acp/src/agent/agent-worker.ts:56–65`
**Severity:** Low

`startAgent(...)` is called without `await` and without error handling. If the transport framing setup or the ACP `initialize` handshake fails, the worker silently becomes a no-op. The main thread's `runtime.initialize` promise never resolves and the UI hangs rather than surfacing an error.

```ts
// Current (agent-worker.ts:56)
startAgent({ transport: ..., ... });

// boot() is already async, so await is straightforward:
await startAgent({ transport: ..., ... });
```

`boot()` itself is called with `void boot(...)` (line 36) so outer errors are also discarded. That top-level void is acceptable (it's a worker global handler), but the inner `startAgent` call should be awaited so that any error inside `boot` propagates to the `void boot(...)` expression's catch path (currently `console.error` from the `.catch` that wraps it in some callers — though here there is no `.catch`, so the `void` swallows silently).

**Fix:**

```ts
async function boot(port: MessagePort, hostVolumes: HostVolumeInit[]): Promise<void> {
  ...
  await startAgent({ transport: ..., ... });
}
```

And in the message handler:

```ts
void boot(msg.agentPort, msg.volumes ?? []).catch(err => {
  console.error('[agent-worker] boot failed:', err);
});
```

---

## Checklist Results

| # | Item | Result |
|---|---|---|
| 1 | `ExtensionRegistry` correctly constructed, `loadAll` called before `startAgent` | Pass |
| 2 | `createZenfsExtensionsFs` and `createZenfsExtensionsWriteFs` correctly wired | Pass |
| 3 | `extensionsWriteFs` passed to `startAgent` | Pass |
| 4 | `useExtensions` listens to `_bodhi/extensions/state` notifications | Pass |
| 5 | State correctly managed (EMPTY sentinel, error field) | Pass |
| 6 | Race between notification and initial fetch | Finding #1 (Medium) |
| 7 | One-worker-per-tab invariant preserved | Pass — `ensureRuntime` singleton is untouched |
| 8 | VolumeRow renders `tags` chips correctly | Pass |
| 9 | Dexie schema migrations — `extension` kind requires no schema change | Pass — `entries` table schema unchanged; new `kind` value is backward-compatible |
| 10 | `setTitle` null fix (title `?? null`) | Pass — aligns with `SessionStore.setTitle(id, title: string \| null)` interface |
| 11 | `acp/client.ts` `listExtensions()` correctly typed and dispatched | Pass |
| 12 | `acp/index.ts` barrel completeness | Partial — `BodhiExtensionsReload*` exported but unused (Finding #4); `BODHI_EXTENSIONS_ADD_METHOD` and `BodhiExtensionsAdd*` not exported (acceptable — no host method uses them yet) |
| 13 | `backends.ts` tags propagation backward-compatible | Pass — `host.tags ?? host.seed?.tags` with empty guard |
| 14 | React dep arrays | Pass — `useExtensions` dep array `[isAuthenticated]` is correct |
| 15 | Stale closures | Pass — `dispatchActionRef` and `messagesRef` patterns in `useAcpStreaming` are correct |
| 16 | `data-testid`/`data-test-state` seams for Playwright | Partial — count-as-state convention issue (Finding #6) |
| 17 | `agent-worker.ts` boot error handling | Finding #7 (Low) |
| 18 | Double extNotification listener coupling | Finding #3 (Low) |

---

## Overall Assessment

**Good:** The extension wiring follows the established pattern cleanly. `readDisabledExtensions` is called before `loadAll`, preserving the Phase 12 toggle semantics on worker restart. The `useExtensions` + `EMPTY_EXTENSIONS` sentinel + `isAuthenticated` gate in `useAcp` correctly handles the auth boundary. The session-store `recordExtension` / `setExtensionLabel` methods are correctly implemented within a `rw` transaction and return the `seq` for the host bridge. The Dexie schema v4 is unaffected (no new tables needed). The `toAgentVolumeInit` tag propagation is clean and backward-compatible.

**Attention needed:** The race in `useExtensions` (Finding #1) is unlikely to be visible in practice because the `_bodhi/extensions/state` notification is only emitted after a session action (`/extension` command or install), not at boot. But it should be fixed before M7 adds more session lifecycle events that could trigger it earlier. Finding #7 (silent boot error) is the highest practical risk — a broken transport or `startAgent` failure will hang the UI with no diagnostic.
