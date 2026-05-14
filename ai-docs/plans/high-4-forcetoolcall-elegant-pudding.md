# M6 Review — Batch 2: Stability + Test Coverage + Spec Alignment

## Context

Batch 1 (Critical barrel + 4 High findings) shipped in `39df8fdb`. The M6
review surfaced a second tier of items the index labels "Soon (M7 or
standalone polish commit)" — stability gaps in the install flow and
registry, missing test coverage, host-layer race, and three
spec/comment-alignment items. Fixing them now keeps M7 from inheriting
known-broken corners; none require a design decision beyond the two
called out below.

The Explore pass against current code (`packages/web-acp-agent/`,
`packages/web-acp/`) verified every finding. Two adjustments to the
review's framing:

- **M3 is a false alarm.** `discoverExtensions` /
  `LoadedExtensionModule` are exported from the internal
  `agent/extensions/index.ts` but **not** re-exported through
  `src/index.ts`. The public barrel is already correct. Drop M3.
- **M5 needs a decision, not a fix.** The steering doc
  (`web-acp/steering/04-principles.md` § 13) already documents
  extensions as fully-trusted. A path-sandbox in `ExtensionsFs`
  contradicts that posture. Resolution: document the fully-trusted
  contract in the `ExtensionsFs` interface JSDoc; no code change.

This batch covers 8 items: M2, M5, M6, M7, M8, M9, M10, M11, M12.

---

## Fix 1 — M2: Wire `session_shutdown` or drop it from the spec

**Verified:** `dispatchSessionShutdown` does not exist anywhere in
`packages/web-acp-agent/src/agent/extensions/runner.ts`. Subscribers
to `session_shutdown` silently never fire.

**Decision:** Remove `session_shutdown` from the spec. Extensions are
already cleaned up via `ExtensionRunner.disposeAll()` on registry
reload + on session close (engine path); a separate per-session
shutdown event adds dispatch surface without a real subscriber today.
If a future use case appears, re-add as a deliberate spec change.

**Files:**

- `ai-docs/web-acp/specs/web-acp-agent/extensions.md` — remove
  `session_shutdown` from the lifecycle table and the events union
  description. Add a one-line note: "session-end cleanup happens via
  `ExtensionRunner.disposeAll()`; no separate event."
- `packages/web-acp-agent/src/agent/extensions/types.ts` — if
  `'session_shutdown'` appears in the `ExtensionEvent` union literal,
  remove it. (Verify during execution; the Explore agent listed
  every other dispatch method but did not enumerate the union.)

No code in `runner.ts` to change — the dispatch method does not
exist.

---

## Fix 2 — M5: Document `ExtensionsFs` as fully-trusted (no path sandbox)

**Verified:** `createZenfsExtensionsFs` in `agent/extensions/extensions-fs.ts`
applies no path-prefix check. `pi.fs.readFile('/sessions/...')` would
succeed today.

**Decision:** Document the fully-trusted contract; do not add a
sandbox. Rationale: `steering/04-principles.md` § 13 establishes that
extensions are manually installed by the user into their vault and
are fully trusted. A sandbox would imply otherwise and create
ongoing maintenance pressure to keep it tight. The interface is
already only reachable from extension code that the user installed.

**Files:**

- `packages/web-acp-agent/src/agent/extensions/extensions-fs.ts` —
  add a JSDoc block above `ExtensionsFs` interface and
  `createZenfsExtensionsFs` factory:
  > Extension code is fully trusted (see
  > `steering/04-principles.md` § 13). This filesystem accepts any
  > absolute path the worker can resolve; there is no sandbox.
  > Loaders construct paths under
  > `/mnt/<mount>/.pi/extensions/<name>/` by convention, but the
  > interface does not enforce it.
- `ai-docs/web-acp/specs/web-acp-agent/extensions.md` — add the same
  fully-trusted note to the `pi.fs` subsection.

---

## Fix 3 — M6 + M10: Comment cancel-skip + input-bypass

Two pure-comment items rolled into one fix.

**M6 — `beforeProviderRequest` / `afterProviderResponse` silent skip.**

**File:** `packages/web-acp-agent/src/agent/extensions/runner.ts` —
above the two dispatch methods (`dispatchBeforeProviderRequest` ~L213,
`dispatchAfterProviderResponse` ~L242), add to the JSDoc:

> Subscriptions marked disposed (e.g. after session cancel) are
> skipped silently. This is intentional — a cancelled turn must not
> drive provider hooks. Do not "fix" this by re-running disposed
> subscriptions; cancellation is a hard barrier.

**M10 — extension commands bypass `dispatchInput`.**

**File:** `packages/web-acp-agent/src/acp/engine/builtin-dispatch.ts`
~L61, above `tryHandleExtensionCommand`:

> Extension commands handle their own argument parsing and run
> outside the `input` event chain — input handlers cannot intercept
> or rewrite a `/<extension-cmd>` invocation. This matches the
> built-in command behaviour (`tryHandleBuiltin`). Vault commands
> and prompts go through `dispatchInput` because they substitute
> into the user-message text.

No code change.

---

## Fix 4 — M7: Cleanup orphan extension dir on partial-install failure

**Verified:** `installExtensionFromNpm` at
`packages/web-acp-agent/src/agent/extensions/install.ts:155–159`
runs `rm` → `mkdir` → `writeFile(index.js)` →
`writeFile(package.json)` with no try/catch. A `writeFile` failure
leaves the directory at `installRoot` with a `.dir` marker but no
real files; the next `loadAll` will treat it as a broken extension.

**Change:** Wrap the three writes in a try/catch that calls
`writeFs.rm(installRoot)` on failure, then re-throws.

```ts
await input.writeFs.rm(installRoot);
await input.writeFs.mkdir(installRoot);
try {
  await input.writeFs.writeFile(`${installRoot}/index.js`, entryEntry.text);
  await input.writeFs.writeFile(`${installRoot}/package.json`, pkgJsonEntry.text);
} catch (err) {
  // Best-effort rollback; surface the original error.
  try {
    await input.writeFs.rm(installRoot);
  } catch {
    // Cleanup failed — leave it for the next reload to skip.
  }
  throw err;
}
```

**Test:** add to `install.test.ts`. Use a `memWriteFs` whose
`writeFile` throws on the second call. Assert that
`installExtensionFromNpm` rejects, and that `writeFs.files.size` is
0 (no leftover `installRoot` entries).

---

## Fix 5 — M8: Reload concurrency guard

**Verified:** `ExtensionRegistry.reload()` at
`packages/web-acp-agent/src/agent/extensions/registry.ts:576–587`
has no in-flight guard. Two concurrent calls both
`disposeAll()` + `clear()` + `loadAll()`, producing torn registry
state.

**Change:** Add a single-slot mutex. Either reuse an in-flight
promise on overlapping calls, or queue them serially. Reusing is
simpler and matches the user intent (concurrent reloads converge
to one fresh state).

```ts
#reloadInFlight: Promise<void> | undefined;

async reload(): Promise<void> {
  if (this.#reloadInFlight) return this.#reloadInFlight;
  if (!this.#lastInput) throw new Error(...);
  const run = (async () => {
    try {
      await this.#runner.disposeAll();
      this.#tools.clear();
      this.#commands.clear();
      this.#providers.clear();
      this.#toolCapabilities.clear();
      this.#eventBus.clear();
      await this.loadAll(this.#lastInput!);
    } finally {
      this.#reloadInFlight = undefined;
    }
  })();
  this.#reloadInFlight = run;
  return run;
}
```

**Test:** add to `registry.test.ts`. Two `await Promise.all([reg.reload(),
reg.reload()])` calls; assert `disposeAll` is invoked exactly once
(spy on `runner.disposeAll`) and the final state matches a single
reload's output.

---

## Fix 6 — M9: Expand `install.test.ts` coverage

**Verified:** existing 5 cases cover happy path, entry precedence,
version traversal, http tarball, missing entry. Missing 5 cases
the review calls out.

Add to `packages/web-acp-agent/src/agent/extensions/install.test.ts`:

1. **Registry metadata fetch fails** — `fetchImpl` returns
   `Response('boom', { status: 500 })` on the metadata URL. Assert
   the install rejects with `/registry metadata fetch failed/` and
   no files written.
2. **Tarball fetch fails** — registry returns valid metadata, but
   the tarball URL returns `status: 502`. Assert
   `/tarball fetch failed/` and no files written.
3. **Reinstall over existing dir** — pre-populate `writeFs.files`
   with stale content at `installRoot`. Run `installExtensionFromNpm`
   for the same `<name>@<version>`. Assert the stale content is
   gone and only the freshly written `index.js` + `package.json`
   exist (validates the existing `rm` step).
4. **Scoped package round-trip** — install
   `@scope/pi-foo@1.0.0`. Assert `result.extensionName` is
   `scope__pi-foo@1.0.0` and `result.installPath` ends with that.
5. **Malformed `package.json`** — tarball contains
   `package/package.json` with non-JSON body (e.g. `'not json'`).
   Assert the install rejects (the `JSON.parse` throws naturally;
   verify the error surfaces and no files written beyond what
   `mkdir`'s `.dir` marker placed — actually with Fix 4's cleanup,
   nothing should be left).

Note: the M9 list also mentions "entry-absent-from-tarball" but the
existing test "rejects packages with no entry hint" covers entry
declared but file missing? Verify during execution — if `pickEntryRelpath`
returns a value but the file isn't in `files`, the existing code at
`install.ts:138–142` already throws `entry '...' was not present`.
If there's no test for that exact path, add it as a 6th case.

---

## Fix 7 — M11: Dedup extension commands against vault commands + prompts

**Verified:** at
`packages/web-acp-agent/src/acp/engine/session-runtime.ts:320–330`,
extension commands are appended to `availableCommands` without
checking the `seenNames` Set used for vault commands + prompts. A
collision (e.g. vault `/foo` + extension `/foo`) duplicates in the
picker.

**Change:** route extension commands through the same `seenNames`
dedup. Tools-and-providers conflict is last-write-wins; commands
should follow the same precedence as already documented for vault
commands beating prompts. Suggested order: built-ins → vault
commands → vault prompts → extension commands. The `seenNames` Set
already captures the first three; extension commands lose on
collision.

```ts
for (const ext of extensions.listCommands()) {
  if (seenNames.has(ext.name)) {
    // first-registered wins; vault and built-ins shadow extension commands
    continue;
  }
  seenNames.add(ext.name);
  extensionCommands.push({ name: ext.name, ... });
}
```

**Test:** add to `session-runtime.test.ts` (or wherever the
`available_commands_update` shape is tested). Register a vault
command `/foo` and an extension command `/foo`; assert exactly one
`/foo` appears and it's the vault one.

**Spec:** update
`ai-docs/web-acp/specs/web-acp-agent/extensions.md` "Conflict
resolution" — the Commands row already says last-write-wins for
extension-vs-extension collisions (Batch 1 fix); add a sentence
that extension commands are shadowed by vault commands and prompts
on cross-source collision.

---

## Fix 8 — M12: `useExtensions` race fix

**Verified:** at `packages/web-acp/src/hooks/useExtensions.ts:33–61`,
the initial `listExtensions()` resolves and overwrites state even
if a `BODHI_EXTENSIONS_STATE_NOTIFICATION` arrived in between.

**Change:** track a request sequence number; ignore the initial
`listExtensions()` resolution if a notification has bumped the seq.

```ts
useEffect(() => {
  if (!isAuthenticated) return;
  let cancelled = false;
  let seq = 0;
  const initialSeq = ++seq;
  const runtime = ensureRuntime();
  runtime.client.listExtensions().then(list => {
    if (cancelled) return;
    if (seq !== initialSeq) return; // a notification raced in; drop the stale snapshot
    setState({ entries: list, ... });
  });
  const unsubscribe = runtime.client.onExtNotification(..., params => {
    seq += 1;
    const next = ...;
    setState({ entries: next, ... });
  });
  return () => { cancelled = true; unsubscribe(); };
}, [isAuthenticated]);
```

**Test:** the host package has limited unit-test coverage for
hooks, and adding a vitest with timer/promise interleaving for this
race is high effort for low payoff. Verify by reasoning at code
review and rely on the existing e2e (`extensions.spec.ts`) catching
any regression in the visible-state contract. If the existing e2e
doesn't already exercise reload-during-open, document that as a
follow-up.

---

## Execution order

1. Comment-only fixes (Fix 3 — M6 + M10), spec-only fixes
   (Fix 1 — M2 partial, Fix 2 — M5). Land first; zero risk.
2. Install hardening (Fix 4 — M7) + test expansion
   (Fix 6 — M9). Touches one file pair; security-adjacent so do
   together.
3. Reload concurrency (Fix 5 — M8). Self-contained registry change.
4. Command dedup (Fix 7 — M11). Touches engine + spec + test.
5. Host race (Fix 8 — M12). Browser host only.

## Critical files

- `packages/web-acp-agent/src/agent/extensions/install.ts` —
  Fix 4 (try/catch cleanup).
- `packages/web-acp-agent/src/agent/extensions/install.test.ts` —
  Fix 4 + Fix 6 tests.
- `packages/web-acp-agent/src/agent/extensions/registry.ts` —
  Fix 5 (reload mutex).
- `packages/web-acp-agent/src/agent/extensions/registry.test.ts` —
  Fix 5 test.
- `packages/web-acp-agent/src/agent/extensions/runner.ts` —
  Fix 3 comment.
- `packages/web-acp-agent/src/agent/extensions/extensions-fs.ts` —
  Fix 2 JSDoc.
- `packages/web-acp-agent/src/agent/extensions/types.ts` —
  Fix 1 (drop `session_shutdown` literal if present).
- `packages/web-acp-agent/src/acp/engine/builtin-dispatch.ts` —
  Fix 3 comment.
- `packages/web-acp-agent/src/acp/engine/session-runtime.ts` —
  Fix 7 (dedup loop).
- `packages/web-acp-agent/src/acp/engine/session-runtime.test.ts`
  (or wherever) — Fix 7 test.
- `packages/web-acp/src/hooks/useExtensions.ts` —
  Fix 8 (seq guard).
- `ai-docs/web-acp/specs/web-acp-agent/extensions.md` —
  Fix 1 (drop `session_shutdown`), Fix 2 (fully-trusted note),
  Fix 7 (cross-source command precedence).

## Verification

```bash
# Inside packages/web-acp-agent/:
npm run check    # lint + tsc-b
npm test         # vitest — all new tests must pass

# Inside packages/web-acp/:
npm run check    # ensure host changes still compile
```

No e2e run required for this change set unless Fix 8's reasoning
proves wrong; the e2e suite already exercises the
`_bodhi/extensions/reload` round-trip in
`packages/web-acp/e2e/tests/extensions.spec.ts`. Run it
opportunistically at the end of the batch.
