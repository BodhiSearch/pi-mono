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

## 2026-04-20 — M5 (session persistence) decisions

### D10. SessionManager lives Worker-side; main drives it through RPC

**Decision:** the `SessionManager` singleton lives inside the agent Worker, owned by `WorkerAgentHost`. The main thread doesn't import `SessionManager`. Listing / loading / creating / deleting / renaming sessions goes through six new RPC commands (`list_sessions`, `load_session`, `new_session`, `delete_session`, `set_session_name`, `get_session_meta`); the Worker fires a synthetic `session_loaded` event back over the existing transport so the main-thread `useAgent` can update messages + active-session state from one envelope.

**Why:**
- The Worker already owns the pi-agent-core loop and the ZenFS backend for `/sessions`. Co-locating the SessionManager means `message_end → appendMessage` is a local call on the same thread; no RPC hop per turn.
- Main thread stays UI-only. The React layer never touches IndexedDB, never imports ZenFS, and can't accidentally serialise a SessionManager instance into a React context.
- Extension forward-compat. M8 plans to pass SessionManager as `ExtensionContext.sessionManager`; extensions run Worker-side in their own sandboxes and need the manager reachable locally, not across a boundary.
- `loadSession` needs to reset the agent and replay messages atomically. Doing that from main via RPC would require a multi-step dance (abort → clear → restore) each of which crosses the boundary; a single Worker-side method handles it in one pass.

**Alternatives rejected:**
- *SessionManager on main, ZenFS-proxy the Worker writes*: puts the hot message_end persistence path across the Worker boundary. Every turn pays an RPC hop per message + an `fs.promises.appendFile` hop (each of those itself being an RPC call through the ZenFS Port backend). Worse latency + double the ceremony.
- *Both sides get a SessionManager shadowing each other*: two sources of truth, two buffers, divergent `leafId` pointers. Worst-of-both: the bug surface of distribution without any of the upside.

### D11. Port the full `SessionEntry` union + `ReadonlySessionManager` interface in M5, even though only three variants are written

**Decision:** `src/web-agent/core/session/types.ts` defines all nine entry variants from coding-agent (`SessionMessageEntry`, `ThinkingLevelChangeEntry`, `ModelChangeEntry`, `CompactionEntry`, `BranchSummaryEntry`, `CustomEntry`, `CustomMessageEntry`, `LabelEntry`, `SessionInfoEntry`) plus `SessionHeader`, `SessionTreeNode`, `SessionContext`. The exported `ReadonlySessionManager` interface matches the shape of coding-agent's `ExtensionContext.sessionManager` Pick (getCwd / getSessionDir / getSessionId / getSessionFile / getHeader / getEntries / getEntry / getLeafId / getLeafEntry / getLabel / getBranch / getTree / getSessionName).

M5 only writes `SessionMessageEntry` + `ModelChangeEntry` + `SessionInfoEntry` to disk. The remaining variants are scaffolded but not emitted yet.

**Why:**
- **Wire-format stability.** An extension author who writes an analytics extension against coding-agent should read a web-agent JSONL file without modification. If M5 shipped only three types and M6 added `BranchSummaryEntry`, any extension that reads the file would have to case-switch on a possibly-missing variant. Ship the full union now so the file format is versioned at `CURRENT_SESSION_VERSION = 3` from day one and M6/M7/M8 only change the *set of writers*, never the *set of readers*.
- **Interface stability.** M8 wires `ExtensionContext.sessionManager = workerHost.sessionManager` and expects extensions to call `.getBranch()` / `.getTree()` / `.getLabel()` as-is. If M5 only shipped a subset of the reads, M8 would have to widen the interface and every M5 extension call-site would need updating.
- The marginal cost of porting types + reads is small (the reads are pure in-memory traversals) compared to the cost of breaking extensions written against coding-agent.

**Alternatives rejected:**
- *Ship only the variants M5 writes*: bakes an incompatibility between coding-agent and web-agent session files that M8 extensions would hit immediately.
- *Make `ReadonlySessionManager` extension-specific and keep a narrower M5 interface internally*: two interfaces drift; eventually someone calls an M5-only method from an extension path and the type compiles but fails at runtime.

### D12. `/sessions` on IndexedDB with per-session append queue (not OPFS)

**Decision:** `/sessions` is mounted on `@zenfs/dom`'s `IndexedDB` backend (`storeName: 'web-agent-sessions'`). Multi-tab correctness relies on IndexedDB's per-store transactional writes serialising concurrent `appendFile` calls; per-session append order within a single tab is enforced by a `writeChain: Promise<void>` inside `SessionManager` that every `_enqueueWrite` chains onto.

**Why:**
- **Repository core value #2 forbids OPFS.** OPFS doesn't coordinate cross-tab writes — two tabs appending to the same file produce torn bytes with no error surface, and IndexedDB transactions are the existing solution we've already paid for (via `@zenfs/dom` being a dep already).
- **No new dep.** `@zenfs/dom` already ships with the IndexedDB backend we use for `WebAccess` lifecycle glue; mounting `/sessions` costs zero dependency budget.
- **Per-session queue is cheap and solves the within-tab case.** ZenFS `appendFile` on IDB internally does `readFile → concatenate → writeFile`. Without the queue, two rapid `appendFile` calls could race on the read step and the second write would clobber the first. With the queue, the second append sees the post-first-write state.
- **Worst-case for cross-tab (both tabs writing the same session) is a torn leaf pointer, not torn bytes.** IDB serialises the writes, so each tab's in-memory `leafId` pointer becomes stale from the other tab's additions but the JSONL file remains coherent (last-writer-wins on the in-memory index; next `open()` rebuilds the index correctly from the file). M5 ships as-is; M6 may add a "another tab is editing" affordance if it becomes a real problem.

**Alternatives rejected:**
- *OPFS*: rejected by [core value #2](../CLAUDE.md).
- *Global write queue across all sessions*: heavier contention under zero benefit — one session's append can't torn-byte another session's file. Per-session queue keeps parallelism where it's safe.
- *Explicit IDB transactions for each entry*: `@zenfs/dom` already wraps each `appendFile` in an IDB transaction internally. Adding an outer transaction layer would require rewriting the backend, not the manager.

---

## 2026-04-20 — M5 storage-swap decisions (Dexie supersedes ZenFS sessions mount)

### D13. `SessionStore` interface makes session storage swappable

**Decision:** session persistence is defined by a `SessionStore` interface (`packages/web-agent/src/web-agent/core/session/store.ts`). Production wires `DexieSessionStore` (Dexie on IndexedDB); tests and the jsdom in-process fallback wire `MemorySessionStore`. `WorkerAgentHost`, `SessionManager`, and the main-thread hooks take a store via constructor or module singleton; no component imports a concrete backend directly.

**Why.**

- M5's first cut hard-wired storage to `@zenfs/dom`'s IDB backend through the ZenFS mount layer. When that silently broke in the browser, there was no ergonomic swap point — every SessionManager method was tangled with `fs/promises` + path helpers + lazy-flush scheduling. Replacing the storage meant rewriting the manager.
- An interface seam lets future decisions (cloud sync, OPFS once cross-tab lands, a remote API) slot in without churning `WorkerAgentHost` or the React hooks. Each backend satisfies the same contract and the rest of the code is unchanged.
- The interface also gave us a free test double: `MemorySessionStore` covers every path Dexie does and runs without IDB. This powers the `session-manager.test.ts` and `worker-host.test.ts` rewrites in the same commit as the Dexie implementation, so parity is enforced by tests rather than trust.
- Matches principle "interface and implementation loosely coupled" from the user's storage-swap brief.

**Alternatives rejected:**

- *Hard-wire Dexie and skip the interface.* Simpler short-term; pays the same migration tax the next time we reconsider storage. The cost of the interface is one file (`store.ts`); the cost of the re-migration is re-touching every caller.
- *Abstract only the reads (keep writes Dexie-specific).* Half-measure — appends are where the complexity lives; reads would still know about Dexie types.
- *Expose Dexie's `Table` directly as the "interface."* Leaks backend concepts (transactions, indexes, compound keys) into every caller and defeats the swap-out goal.

### D14. Dexie on IndexedDB for session storage — supersedes D12

**Decision:** replace the `/sessions` ZenFS-mounted IDB store with a Dexie-backed database named `web-agent` (tables: `sessions` keyed on `id` + indexed on `modifiedAt`; `entries` compound-keyed on `[sessionId+id]` with `sessionId`, `[sessionId+timestamp]`, `[sessionId+type]` indexes). Session records + entries live as IDB rows — not JSONL inside a simulated filesystem.

This supersedes D12, which mandated the ZenFS `/sessions` mount + per-session `appendFile` write queue. D12's reasoning on cross-tab safety via IDB transactions still holds — it's the implementation path (ZenFS file abstraction over IDB) we're walking away from, not the underlying storage.

**Why.**

- **The M5 ZenFS path was silently broken.** After M5 shipped, `localStorage.activeSessionId` was being set but `indexedDB.databases()` showed `web-agent-sessions` with zero keys after sending a prompt + getting a reply. The layers involved (`SessionManager` → `fs.promises` → `vfs.mounts` → `StoreFS` → `IndexedDBTransaction` → IDB) made root-causing expensive. Sessions are records; simulating them as JSONL files over IDB added complexity without benefit.
- **Records are cheap.** Direct Dexie `entries.add(row)` per append is O(1) and transactional. ZenFS `appendFile` on a JSONL file is "read entire file → concatenate → writeFile," which is O(file size) per append — flagged as a risk in M5 post-scripts and confirmed worse in practice.
- **Free cross-context reactivity.** Dexie's `liveQuery` uses BroadcastChannel internally; main-thread `useLiveQuery` re-renders automatically when the Worker commits a write, and another tab sees changes through the same channel. The previous design needed an `onSessionLoaded` synthetic event + explicit `listSessions` RPC after every write to keep the picker fresh.
- **Debuggable.** DevTools → Application → IndexedDB → rows, instead of opaque bytes inside a StoreFS-shaped key/value.
- **Zero schema migration cost today** — first boot, legacy `web-agent-sessions` IDB DB is best-effort deleted. User's IDB was empty at decision time; we're greenfield.
- **Bundle cost is acceptable.** Dexie ships ~30 KB gzipped; the main bundle already sits around 815 KB gzipped and this work is not performance-bound.

**Alternatives rejected:**

- *Fix the ZenFS path.* Plausible, but the root cause was somewhere in a third-party chain we don't maintain, and the "records → filesystem → IDB" layering is wrong for session data regardless of whether this specific bug is fixed.
- *Raw IndexedDB without Dexie.* Dexie is 30 KB for transactional API, index helpers, and liveQuery. Raw IDB's lower-level primitives would mean reinventing that surface and losing BroadcastChannel for free. Not worth it at our scale.
- *OPFS.* Core value #2 still binds — concurrent-tab writes would corrupt state with no error surface. No new concurrency guarantee changed.

### D15. Worker owns writes, main reads directly via Dexie

**Decision:** `WorkerAgentHost` is the single authoritative writer for session state. It takes a `SessionStore` via constructor and persists agent `message_end` events + lifecycle mutations (new / load / delete / rename) into it. Main-thread React code opens its own `DexieSessionStore` instance (module-singleton in `src/hooks/useSessionsList.ts`) against the same `web-agent` IDB DB — **for reads only**. The picker list is driven entirely by `useLiveQuery(() => store.listSessions())`; no RPC command fires when sessions change.

`setSessionName` stays on the RPC side (it's not just a read — the Worker's active `SessionManager` needs to refresh its in-memory entry cache afterwards, and letting main write directly would require cross-context cache invalidation). Everything else that looked like a reactive-data problem is handled by liveQuery.

**Why.**

- **Eliminates a whole category of race.** In the M5 wiring, the picker's view of sessions was out of date whenever the main thread hadn't yet pulled a fresh `listSessions` RPC. The `onSessionLoaded` → `listSessions` chain papered over it but still left windows where a reload-then-open showed stale data.
- **Single writer = single source of truth.** The Worker's `SessionManager` holds the authoritative `leafId` + entry cache for the active session; letting main also write would split authority and force invalidation protocols. Reads are idempotent and safe to duplicate across contexts.
- **Multi-tab support falls out for free.** Two tabs at the same origin both see a live picker; each has its own Worker owning its own active session. Writes from tab A broadcast to tab B via IDB + BroadcastChannel. No per-tab coordination code.
- **RPC surface shrinks where it should.** `listSessions` stays on the RPC for boot-time diagnostic use + tests, but the picker doesn't depend on it anymore. Future read-heavy flows (entry browser, branch navigator) can do the same.

**Alternatives rejected:**

- *Main writes, Worker mirrors for agent use.* Reverses the dependency — UI becomes the authority, Worker has to import changes from main. Worse cache-coherency story; bad fit when the Worker is where session_end events originate.
- *All reads via RPC so Worker stays the single IDB client.* Matches the pre-Dexie architecture but gives up liveQuery's cross-context reactivity. Every picker update is an explicit round-trip.
- *Both write, "last one wins."* IDB transactions would serialise, so no corruption, but leafId/cache divergence would silently accumulate across contexts until a user reload.

---

## 2026-04-20 — Post-M5 cleanup decisions

### D16. `vaultMount` + `sessionsDbName` are constructor options; defaults live on the library

**Decision:** `WorkerAgentHost` takes an options object carrying a `vaultMount?: string` field; `DexieSessionStore` already took an optional DB name, and `agent-worker.ts` now forwards both through the `AgentWorkerInit` envelope. Main-side `getAgentWorker(options)` accepts `{ devSeed?, agentOptions? }` where `agentOptions` is the shared `WebAgentOptions` type (`vaultMount`, `sessionsDbName`). Default values (`/vault`, `web-agent`) live inside the library, not at call sites.

**Why.**

- The library is meant to extract cleanly in Phase 6. Compile-time constants for the vault mount path and DB name couple every consumer to our single-app defaults — a second embed (e.g. two isolated agent instances on one page, or a consumer that needs a namespaced `/myapp-vault` mount) has no seam.
- Constructor-injection is already the shape the rest of the library uses (`WorkerAgentHost(session, vfsPort, store, options)`, `DexieSessionStore(db)`). One more options struct fits; no new idiom.
- `SessionManager.create` tightened from `cwd?: string` (defaulting silently to `/vault`) to `cwd: string` required. Missing cwd is caller error — the Worker host passes `this.vaultMount` explicitly, tests pass `'/vault'` explicitly. No silent fallback that drifts from the options struct.

**Alternatives rejected:**

- *Environment-variable-based configuration.* Doesn't cross the Worker boundary cleanly; every field would need plumbing through the init envelope anyway.
- *Static class-level setters.* Globals; break the second-consumer case immediately.

### D17. Extension scaffolding de-exported; M8 reintroduces

**Decision:** `src/web-agent/core/extensions/registry.ts` is deleted. The M8 event / tool / manifest *types* in `types.ts` stay as forward-compat scaffolding but are no longer re-exported from `index.ts`. M8 lands the real registry and re-exposes whatever shape it finalises at that time.

**Why.**

- The registry class was a Phase-1 stub — in-memory Map, never instantiated, never driven by any code path. Exporting it implied a stable API that didn't exist; removing it narrows the public surface to things consumers can actually use today.
- Keeping `types.ts` preserves the coding-agent-compatible shape M8 will need, but confines it to internal reference until wired.
- If M8 changes the extension manifest or event contract, there's no need to maintain backwards compatibility with the stub.

**Alternatives rejected:**

- *Delete `types.ts` too.* Forces M8 to re-derive the extension contract from scratch; marginal win on LOC, real cost on context.
- *Mark the registry `@internal`.* Exports with `@internal` JSDoc still ship in the public API barrel and tend to be rediscovered by downstream consumers.

---

## 2026-04-20 — M6 (session tree) decisions

### D18. Fork storage = full entry copy with `parentSession` pointer; ids/parentIds/timestamps preserved verbatim; labels skipped

**Decision:** `SessionStore.forkSession({ sourceSessionId, upToEntryId })` creates a new session whose entries are the root-to-`upToEntryId` path of the source, copied verbatim. Each copied `EntryRow` keeps the source entry's `id`, `parentId`, and `timestamp`. The new `SessionRow` carries `parentSession = sourceSessionId`. `LabelEntry` rows are skipped during the copy so the child starts with an empty label set. The whole operation runs in a single Dexie `rw` transaction over `[sessions, entries]` so partial copies never land. `DexieSessionStore.forkSession` writes copied rows via direct `db.entries.add(row)`, bypassing `_writeEntry`'s monotonic-timestamp bump — that's what keeps the source timestamps intact.

**Why.**

- **Coding-agent JSONL parity.** Coding-agent's `createBranchedSession` produces sessions whose JSONL files start with the same entries as the parent up to the fork point. Preserving ids + parentIds means the child's DAG slice is structurally identical to the parent's; analytics or tools that consume both files see consistent identifiers.
- **The compound `[sessionId+id]` primary key already protects shared ids.** Two rows with the same `id` but different `sessionId` coexist trivially; no special-casing needed in IDB.
- **Atomicity matters.** A half-applied fork (some entries copied, others not, or session row created with no entries) would leave a corrupt state that the next read couldn't reason about. Wrapping the copy in a single Dexie transaction makes it all-or-nothing.
- **Labels are ephemeral user bookmarks, not part of the conversation DAG.** Carrying them across forks would surprise users (a label they set on the parent suddenly appearing on the child); explicit skip is the cheapest safe default. M6.1 can revisit if a use case emerges.
- **Storage cost is acceptable at our scale.** ~5–20 KB per entry × typical 50-entry session = 250 KB – 1 MB per fork. IDB origin quotas are hundreds of MB. COW / parent-pointer / dedup were considered and rejected (D-side: complicates deletes + reads, no telemetry showing storage pressure). Revisit only on real numbers.

**Alternatives rejected:**

- *Copy-on-write entries (child references parent rows until divergence).* Smaller storage but every read needs a join, and deletes have to walk the dependency graph. Net complexity loss.
- *Parent-pointer / lazy join.* Same trade-offs as COW.
- *Generate fresh ids on copy.* Breaks JSONL interop and prevents extensions from correlating entries across parent and child sessions.
- *Carry labels across the fork.* Surprising user behaviour; deferred.

### D19. Ephemeral leaf navigation — `navigateToLeaf` mutates in-memory `leafId` only

**Decision:** `SessionManager.navigateToLeaf(entryId)` is a synchronous in-memory pointer move with no persistence. The next append uses the new leaf as its `parentId`, so the DAG grows a sibling branch from the navigated point. `WorkerAgentHost.navigateToLeaf` rebuilds the agent's message window from the new branch (so subsequent prompts continue from the chosen entry) and emits a `session_loaded` event so main UI sees the truncated message list. On reload, `SessionManager.load` re-derives the leaf as the chronologically-latest entry — the navigation is forgotten.

**Why.**

- **Matches coding-agent's `branch(fromId)`** — the same in-memory leaf move with no persisted marker. Coding-agent's optional `branchWithSummary(fromId, summary)` writes a `BranchSummaryEntry` to make the navigation persistent, but that variant is **out of scope for M6 MVP** (the user explicitly rejected the LLM-summary scope option).
- **No new schema commitments.** A persisted "last-navigated leaf" pointer would be a new concept the store has to version + reason about. Punting it keeps M6 minimal and lets us see whether real users actually want navigation to survive reload before paying for the feature.
- **The forgetting-on-reload behaviour is documented as known limitation.** Acceptable for an MVP that's primarily about enabling forks; M6.1 can add a `BranchSummaryEntry`-based persistence path if user feedback says it's worth it.
- **`session_loaded` re-emission keeps the UI honest.** Main thread's `messages` + `messageEntryIds` arrays update from the new branch, so the chat view truncates and the per-message Fork/Branch buttons re-bind to the right entry ids without any client-side bookkeeping.

**Alternatives rejected:**

- *Persist the navigated leaf in `SessionRow.leafId` (or a similar field).* Adds a field that's only meaningful when navigation has happened; reload semantics get fiddly (does the leaf still exist? what if the user pruned the entry it pointed at?). Defer until we know the persistence semantics matter.
- *Persist via a `BranchSummaryEntry`.* Coding-agent's mature path, but writing one MVP-style would be a no-summary entry that exists just to mark a leaf — that's the LLM-summary scope option the user rejected. Revisit when M7's compaction surface lands hooks for cheap summaries.

---

## Conventions

- **Append-only:** never overwrite past decisions. Supersede with a new entry that references the old one.
- **Date format:** ISO `YYYY-MM-DD`.
- **Scope:** architectural choices that shape future implementation. Routine code style lives in lint configs, not here.
- **Cross-refs:** prefer repo-relative paths (e.g. `packages/ai/src/env-api-keys.ts`) over commit SHAs so entries remain readable as the code evolves.
