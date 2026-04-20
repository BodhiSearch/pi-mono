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

## 2026-04-20 — Post-M3 stabilisation decisions

### D5. Vault mount state is owned by a single `<VaultProvider>`, not by `useVaultMount` callers

**Decision:** the mount side-effect (read directory handle / dev seed → call `mountVault` → track `status` and `name`) lives in exactly one place: `src/providers/VaultProvider.tsx`. `useVaultMount` is now a thin context consumer (`return useVaultContext()`). All readers of vault state must go through the provider; the provider must wrap the app once near the root.

In addition, `mountVault` and `unmountVault` (in `src/web-agent/fs/zenfs-provider.ts`) keep an in-flight promise guard so overlapping calls — React StrictMode effect re-runs, fast-refresh remounts, accidental duplicate provider mounts — serialise instead of racing on `configure`/`vfs.mount`.

**Why:** the original M2 implementation called `useVaultMount` from three components (`Header`, `VaultPanel`, `ChatDemo`). Each subtree ran the mount effect on its own. The last racer "won" the actual VFS mount so the file tree rendered, but an earlier racer threw on a half-configured VFS and pinned the status badge to `"error"` after every reload. The module-level mount guard inside `in-memory-vault.ts` (added in `2c437c0f`) hid the symptom for the dev-seed path but did not protect the real WebAccess mount path. A single owner of the mount effect is the only durable fix; the in-flight guard inside the provider functions is defence-in-depth for StrictMode.

**Alternatives rejected:**
- *Make `useVaultMount` itself idempotent via a module-level singleton*: works for state, doesn't work for effect-scheduling — React still schedules the effect from each subtree, the singleton just dedupes the side-effect. The status state would still diverge between consumers.
- *Per-component mount guards*: every new consumer would need to re-implement the guard. Forgetting it produces hard-to-reproduce status flapping.
- *Remove the in-flight promise guard inside `mountVault` once the provider is the single owner*: would re-break under React StrictMode, which double-invokes effects in development. The guard cost is one boolean check; keeping it is cheap insurance.

### D6. Reference app uses a 3-column `[tree | viewer | chat]` layout with a Milkdown markdown editor

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

---

## 2026-04-20 — M4 (Worker transport) decisions

### D7. Single agent Worker hosts both AgentSession and ZenFS; dual MessageChannels

**Decision:** the page spawns exactly one Web Worker (Vite-bundled ES module worker, named `web-agent`). Inside it lives the AgentSession, the six vault tools, and the real ZenFS backend (WebAccess for production, InMemory for the dev seed). Communication between main and worker uses two separate MessageChannels:

- **ChannelA** — agent RPC. Existing `RpcServer`/`RpcClient`/`RpcEventEnvelope` protocol carries `prompt`, `abort`, `set_model`, `mount_vault`, `set_auth_token`, `set_mcp_tools`, `tool_call_response`, etc.
- **ChannelB** — ZenFS Port backend. Worker calls `attachFS(vfsPort, fs)`; main calls `Port.create({ port: vfsPort })`. Internal ZenFS protocol; we don't see or marshal individual fs ops.

Both ports are transferred together in a single tagged init message: `{ type: '__webAgent_init', agentPort, vfsPort, devSeed?, transferList: [agentPort, vfsPort] }`.

**Why:** dual channels keep each protocol clean of the other's shape. The Worker boot is the only place that knows about both. Vault tools execute fully Worker-side with no per-tool RPC hop. UI consumers (`useVaultTree`, `FileViewer`, `MarkdownEditor`) keep their existing `fs.promises.*` API — the Port backend is transparent to them. Phase 6 extraction stays clean: the package exports `getAgentWorker()` and the consumer wires the Provider; nothing about the API surface changes.

**Alternatives rejected:**
- *Single channel multiplexed with a discriminator*: ZenFS Port backend's protocol doesn't include our envelope tag and doesn't expect to share a port. Multiplexing means writing a protocol gateway; dual channels means zero protocol code.
- *Per-tool RPC proxy with ZenFS staying main-thread*: every read/write/edit becomes an extra postMessage hop, multiplied by tool calls per turn. Loss in throughput + main-thread contention; gain only in saving ~5 lines of channel setup.
- *Worker per session*: deferred. Single Worker per page is right while session count is 1; M5/M6 may revisit if multi-session UX needs isolation.

### D8. MCP tools upcall to main via the agent RPC channel; vault tools execute Worker-side

**Decision:** vault tools (the six fs tools) run entirely inside the Worker — their closures close over the Worker-local ZenFS instance, no RPC hop per call. MCP tools work differently: main thread builds plain `McpToolDescriptor` records (`{ name, description, parameters }`) and ships them to the Worker via `set_mcp_tools`. The Worker constructs proxy tools whose `execute` posts a `tool_call_request` event over ChannelA. Main's `RpcClient.setToolCallHandler` receives the upcall, runs the actual MCP HTTP call (using the bodhiClient + auth token from React context), and replies via `tool_call_response`.

**Why:** MCP clients are constructed via `createMcpClient(bodhiClient, mcp.path)` where `bodhiClient` is React-context-bound (auth tokens, session state). Hoisting MCP clients into the Worker would require re-implementing the auth refresh + bodhi-client construction Worker-side, and would couple the Worker to `@bodhiapp/bodhi-js-react`. The upcall pattern keeps the Worker dep-clean (no React-context awareness) and *also* establishes the exact pattern M8 extensions will use for sandboxed tools whose implementation lives outside the Worker boundary.

**Alternatives rejected:**
- *Hoist MCP clients into the Worker*: works but pulls bodhi-react into the Worker bundle and forces auth-rotation via `set_auth_token` semantics across two systems instead of one.
- *No upcall — proxy tools throw "not implemented"*: makes MCP tools unusable from the agent; defeats the existing M3 functionality.

### D9. Envelope-tagged transport with structured error round-trip — cribbed from Comlink

**Decision:** the new `worker.ts` transport posts every init payload as `{ type: '__webAgent_init', ... }`; the receiver's `isAgentWorkerInit` rejects anything that doesn't match. Error responses on the agent RPC channel ship a `SerializedError` payload `{ name, message, stack? }` (not a stringified message); the client `deserializeError` rehydrates it as a real `Error` so callers can `instanceof Error` and inspect the original stack frames.

**Why:** the agent RPC channel is dedicated today, but M8 will route extension messages through related channels into the same Worker; tagging the init envelope up front prevents future cross-talk debugging. Structured errors matter more across a real Worker boundary because the stack frames from inside the Worker are the only clue when something fails inside the agent loop or a tool — losing them to `String(err)` made the M3 debugging significantly harder than it needed to be.

**Alternatives rejected:**
- *Untagged init message*: works today, breaks the day a second protocol shares the global `self.onmessage`. Cheap to add now, hard to retrofit.
- *Comlink dependency*: 1.1KB and proven, but replacing the existing hand-rolled RPC dispatcher would mean rewriting `rpc-server.ts`, `rpc-client.ts`, `rpc-types.ts`, and the existing `rpc.test.ts` for marginal ergonomic gain. We crib the patterns (envelope tagging, structured errors) without the dependency.
- *Round-trip the entire `Error` object via structured clone*: Errors aren't structured-cloneable. Comlink uses the same `{ name, message, stack }` shape we adopted.

---

## Conventions

- **Append-only:** never overwrite past decisions. Supersede with a new entry that references the old one.
- **Date format:** ISO `YYYY-MM-DD`.
- **Scope:** architectural choices that shape future implementation. Routine code style lives in lint configs, not here.
- **Cross-refs:** prefer repo-relative paths (e.g. `packages/ai/src/env-api-keys.ts`) over commit SHAs so entries remain readable as the code evolves.
