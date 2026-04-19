# web-agent architectural decisions

Running log of locked decisions. Each entry: what, why, alternatives considered, date.

---

## 2026-04-19 — Phase 0 decisions (workspace integration)

### D1. Silence Vite dynamic-import warnings at the `packages/ai` source

**Decision:** add `/* @vite-ignore */` inside the two `import()` call sites in `packages/ai`:

- `packages/ai/src/env-api-keys.ts` — `dynamicImport` for `node:fs`/`node:os`/`node:path`
- `packages/ai/src/providers/register-builtins.ts` — `importNodeOnlyProvider` (currently only used for `amazon-bedrock`)

**Why:** the warning is cosmetic — the dynamic imports are node-only and gated by `typeof process !== "undefined" && process.versions?.node`, so they never execute in the browser. Fixing at the source benefits every Vite consumer of `packages/ai` (web-ui, web-agent, future packages), not just web-agent. Vite's own warning message recommends the `/* @vite-ignore */` hint for this case.

**Alternatives rejected:**
- *Config-level suppression in web-agent `vite.config.ts`*: would need `optimizeDeps`/`rollupOptions` hacks that only silence the warning for this app and leak the issue elsewhere.
- *Leave the warning*: clutters dev logs and conditions readers to ignore warnings, making real ones easier to miss.

### D2. Web-agent consumes `packages/ai` and `packages/agent` as workspace symlinks via version `"*"`

**Decision:** in `packages/web-agent/package.json` the entries for `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` use the specifier `"*"`.

**Why:** under npm workspaces, `"*"` guarantees the local package wins regardless of the version numbers in the two package.jsons drifting apart. This is what we need for Phase 0 to pick up the D1 fix immediately without publishing a new `@mariozechner/pi-ai` version first. It also aligns web-agent with how other sibling apps in this monorepo (e.g. web-ui) consume its dependencies: from the repo, not from npm.

**Alternatives rejected:**
- *Keep pinned `^0.67.3` and publish a new `pi-ai` release for the warning fix*: slower, and it couples "fix a warning" to a publishing cadence we don't need yet.

### D3. E2E tests use a dev-mode-only InMemory ZenFS seam (Phase 2+)

**Decision:** when we mount ZenFS for the coding-agent features, Playwright tests will NOT drive the real `showDirectoryPicker()`. Instead, the app will carry a `useDevSeedBoot()` hook gated by `import.meta.env.DEV` that reads `window.__zenfsSeed` (injected by Playwright's `page.addInitScript`) and pre-mounts an InMemory ZenFS backend before React renders.

**Why:**
- `showDirectoryPicker()` is user-gesture-gated and cannot be driven in headless Chromium without experimental flags.
- InMemory seeding makes tests deterministic, fast, and independent of OS temp dirs / permission prompts.
- The dev seam is compile-time dead in production builds (Vite tree-shakes the `import.meta.env.DEV` branch), so no test code leaks.
- This is exactly the pattern `bodhiapps/zenfs-browser` already validated — see `zenfs-browser/src/hooks/useDevSeedBoot.ts` and `zenfs-browser/e2e/helpers/install-vault.ts`.

**Alternatives rejected:**
- *Real FSA via `--use-fake-ui-for-file-system-access`*: higher fidelity, but brittle (depends on Chrome flag stability + OS-level temp dirs) and slower in CI. May add a single smoke test later; not the default.

### D4. Phase 1 RPC transport is `MessageChannel` on the main thread; Worker swap deferred to Phase 4

**Decision:** in Phase 1, the RPC server and client exchange messages over a `MessageChannel` (two `MessagePort`s), both running on the main thread. The public `Transport` interface (`send`, `onMessage`) is fixed now so that Phase 4 can swap in a Web Worker + MessagePort transport without touching the RPC dispatcher, tool operations, or the React layer.

**Why:**
- Gets the UI speaking RPC immediately, which is the real architectural goal.
- Keeps Phase 1 diffs small and reviewable — no worker boilerplate, no SharedArrayBuffer / cross-origin-isolation headaches until we need them.
- Natural progression: once tools and ZenFS mounts are in place (Phases 2–3), we know exactly which objects must be transferable or proxyable, and can design the Worker split against real constraints.

**Alternatives rejected:**
- *Direct in-process function calls*: simpler short-term, but Phase 4 would touch every call site because we'd need to introduce the Transport abstraction later. Wasted churn.
- *Web Worker from day one*: more boilerplate without real payoff until tools/filesystem exist. Risks premature abstraction over worker message shape before we know what we need to transfer.

---

## Conventions

- **Append-only:** never overwrite past decisions. Supersede with a new entry that references the old one.
- **Date format:** ISO `YYYY-MM-DD`.
- **Scope:** architectural choices that shape future implementation. Routine code style lives in lint configs, not here.
- **Cross-refs:** prefer repo-relative paths (e.g. `packages/ai/src/env-api-keys.ts`) over commit SHAs so entries remain readable as the code evolves.
