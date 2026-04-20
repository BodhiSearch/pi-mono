# Post-M3 stabilisation decisions

Date: 2026-04-20

## D5. Vault mount state is owned by a single `<VaultProvider>`, not by `useVaultMount` callers

**Decision:** the mount side-effect (read directory handle / dev seed → call `mountVault` → track `status` and `name`) lives in exactly one place: `src/providers/VaultProvider.tsx`. `useVaultMount` is now a thin context consumer (`return useVaultContext()`). All readers of vault state must go through the provider; the provider must wrap the app once near the root.

In addition, `mountVault` and `unmountVault` (in `src/web-agent/fs/zenfs-provider.ts`) keep an in-flight promise guard so overlapping calls — React StrictMode effect re-runs, fast-refresh remounts, accidental duplicate provider mounts — serialise instead of racing on `configure`/`vfs.mount`.

**Why:** the original M2 implementation called `useVaultMount` from three components (`Header`, `VaultPanel`, `ChatDemo`). Each subtree ran the mount effect on its own. The last racer "won" the actual VFS mount so the file tree rendered, but an earlier racer threw on a half-configured VFS and pinned the status badge to `"error"` after every reload. The module-level mount guard inside `in-memory-vault.ts` (added in `2c437c0f`) hid the symptom for the dev-seed path but did not protect the real WebAccess mount path. A single owner of the mount effect is the only durable fix; the in-flight guard inside the provider functions is defence-in-depth for StrictMode.

**Alternatives rejected:**
- *Make `useVaultMount` itself idempotent via a module-level singleton*: works for state, doesn't work for effect-scheduling — React still schedules the effect from each subtree, the singleton just dedupes the side-effect. The status state would still diverge between consumers.
- *Per-component mount guards*: every new consumer would need to re-implement the guard. Forgetting it produces hard-to-reproduce status flapping.
- *Remove the in-flight promise guard inside `mountVault` once the provider is the single owner*: would re-break under React StrictMode, which double-invokes effects in development. The guard cost is one boolean check; keeping it is cheap insurance.

## D6. Reference app uses a 3-column `[tree | viewer | chat]` layout with a Milkdown markdown editor

**Decision:** `packages/web-agent/src/components/Layout.tsx` arranges the reference app as three columns — vault file tree on the left, file viewer in the middle, chat panel pinned to 420px on the right. Markdown files (`.md` / `.mdx` / `.markdown`) render through Milkdown Crepe with autosave (on blur + every 5s) that writes back through `fs.promises.writeFile`; non-markdown text files render in a read-only `<pre>`; unrecognised extensions show a placeholder. New dependencies: `@milkdown/crepe`, `@milkdown/kit`, `@milkdown/react`.

**Why:**
- The reference app is the canonical demonstration of `web-agent`'s capabilities. A folder-picker-button-only UI is sufficient to gate M2/M3 but says nothing about how a downstream consumer would *actually* expose the vault to a user. A tree + viewer is the obvious shape and matches what `bodhiapps/zenfs-browser` already validated.
- Milkdown specifically proves the FSA write-back round trip end-to-end: edit in the browser → autosave → ZenFS WebAccess backend → user's local disk. Without an interactive editor this round trip is only exercised by the agent's `write` tool, which is enough for M3's gate but doesn't surface regressions in user-driven writes.
- The layout shape is what M5 (sessions panel), M6 (branch navigator), and M8 (extensions installer) will hang their UI off. Locking it in now means each downstream milestone slots its panel into an established frame instead of redesigning the shell.

**Out of scope (still):**
- Markdown editing is a *reference-app* feature, not a `@bodhiapp/web-agent` library feature. Phase 6 extraction does not pull Milkdown into the package — it ships a headless agent harness; consumers wire their own viewer.
- This decision does not promote markdown editing into `01-goals.md`. The goals doc is the library capability checklist; reference-app polish does not belong there.

**Alternatives rejected:**
- *No viewer at all, just a "files" link list*: insufficient to demonstrate write-back. Defers a UI shape we'll need anyway for M5+.
- *Build a custom CodeMirror-based editor*: 1–2 weeks of work for marginal benefit over Milkdown for the markdown case. Defer to a later milestone if non-markdown editing becomes a real ask.
- *Render markdown read-only via `marked` + DOMPurify*: cheaper, but doesn't exercise the write path. Half the value of the editor is proving the FSA round trip works under user-driven edits.
