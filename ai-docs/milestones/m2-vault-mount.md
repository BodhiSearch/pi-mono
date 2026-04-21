# M2 — Vault mount (ZenFS + FSA picker + dev-seed seam)

**Status:** ✅ done (`2c437c0f` + follow-ups `dcd75a1c`, `bf68d906`, `4c3401d3`). Test seam: +1 Playwright spec (`vault-fs.spec.ts` M2).

**Why first (among planned).** Every downstream milestone that touches files needs the mount. No fs capability in the product means no meaningful tools, no sessions, no extensions storage. The dev-seed seam is also a prerequisite for testing all future fs-dependent work without the user-gesture-gated picker.

**Scope preview (historical).**
- Add `@zenfs/core`, `@zenfs/dom`, `idb-keyval` as `packages/web-agent` deps.
- `src/worker-agent/fs/zenfs-provider.ts` — pure `mountVault(handle)` / `unmountVault()`, no React.
- `src/hooks/useDirectoryHandle.ts` — pick folder, persist handle in IndexedDB, re-grant permission on reload.
- `src/hooks/useDevSeedBoot.ts` — dev-mode-only seam reading `window.__zenfsSeed`, mounting InMemory ZenFS before React renders. Tree-shakes in production.
- `e2e/helpers/install-vault.ts` — Node-side helper walking `e2e/data/<name>/` and injecting via `page.addInitScript`.
- Minimal UI: folder-picker button + vault-status indicator.

**Coding-agent references.** No direct equivalent — node uses real fs. Architectural reference is `bodhiapps/zenfs-browser`.

**Gate.** Playwright spec seeds a 3-file vault, assertions confirm the file tree UI surfaces them.

## Outcome

What landed:

- `@zenfs/core ~2.5.6`, `@zenfs/dom ~1.2.9`, `idb-keyval ^6.2.2` added as dependencies; `fake-indexeddb` added dev-side for vitest.
- `src/worker-agent/fs/zenfs-provider.ts` — `mountVault(handle)`, `unmountVault()`, `isVaultMounted()`, `setMountedForSeed()`; pattern copied from `bodhiapps/zenfs-browser`.
- `src/worker-agent/fs/path-utils.ts` — `resolveVaultPath()` + `VaultPathError`, with 12 unit tests covering relative/absolute/escape cases.
- `src/hooks/useDirectoryHandle.ts` — three-state (`empty`/`prompt`/`ready`) with idb-keyval persistence and `requestPermission` re-grant.
- `src/hooks/useDevSeedBoot.ts` — dev-only, reads `window.__zenfsSeed`, lazy-imports InMemory vault adapter. Tree-shakes in production.
- `src/fs/in-memory-vault.ts` — InMemory ZenFS adapter used exclusively by the dev-seed path. Module-level mount guard makes it idempotent (two React subtrees both call `useVaultMount` and we must not reconfigure the VFS mid-session).
- `src/hooks/useVaultMount.ts` — orchestrates seed-vs-handle; exposes `VaultMountStatus` + display name.
- `src/components/vault/VaultStatus.tsx` — `data-testid="vault-status"` badge + pick / re-grant / close buttons; wired into `<Header>`.
- `src/types/fsa.d.ts` — type augmentations for FSA permission methods (TypeScript's DOM lib still lacks them).
- `e2e/helpers/install-vault.ts` + `e2e/data/sample/*` + `e2e/tests/pages/VaultPage.ts` + `e2e/vault-fs.spec.ts` (M2 describe block) — Playwright seam proven end-to-end.

Surprises worth remembering:

- Two React subtrees both calling `useVaultMount` triggered a double-mount race that wiped agent writes mid-turn. Fixed with a module-level `mountPromise` guard in `in-memory-vault.ts`.
- `FileSystemDirectoryHandle.requestPermission` is not in TypeScript's DOM lib — ships a local `fsa.d.ts` augmentation.
- Jsdom has no `indexedDB`; `fake-indexeddb/auto` added to `src/test/setup.ts` so component tests that mount the full App (and therefore the vault hooks) do not throw on boot.
