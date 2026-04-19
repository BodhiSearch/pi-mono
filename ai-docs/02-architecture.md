# Architecture — web-agent

## The layer cake

```
┌────────────────────────────────────────────────────────────────┐
│  Host app (React)                                              │
│  ├─ <WebAgentProvider>                                         │
│  └─ useAgent() → RpcClient                                     │
├────────────────────────────────────────────────────────────────┤
│  Transport boundary (structured-clone-safe)                    │
│  Phase 1: MessageChannel on main thread                        │
│  Phase 4: Web Worker + MessagePort (same Transport interface)  │
├────────────────────────────────────────────────────────────────┤
│  Agent runtime                                                 │
│  ├─ RpcServer ←→ AgentSession (wraps pi-agent-core Agent)      │
│  ├─ Tool execution (over ZenFS)                                │
│  └─ Extension host (Phase 5: each extension in its own Worker) │
├────────────────────────────────────────────────────────────────┤
│  Storage layer (ZenFS mounts)                                  │
│  ├─ /vault       — Chrome FSA handle (WebAccess backend)       │
│  ├─ /extensions  — IndexedDB backend                           │
│  └─ /sessions    — IndexedDB backend                           │
├────────────────────────────────────────────────────────────────┤
│  LLM providers (via @mariozechner/pi-ai)                       │
│  — OpenAI, Anthropic, Bodhi, custom providers from extensions  │
└────────────────────────────────────────────────────────────────┘
```

Arrows only flow downward between layers. Upward flow happens exclusively via events emitted out of the Transport.

## The Transport boundary (why it matters)

**Claim:** every message between the host app and the agent runtime must be structured-clone-safe — plain data, no function references, no DOM nodes, no class instances with methods that matter.

**Why:** the only meaningful difference between MessageChannel (Phase 1) and a real Web Worker MessagePort (Phase 4) is that the Worker forbids passing non-cloneable values. If we let Phase 1 cheat by passing closures through MessageChannel, Phase 4 becomes a full rewrite. By holding the Phase 1 code to Worker-grade discipline, Phase 4 becomes: *replace the transport constructor, done.*

**Consequences:**

- Tools cannot flow over RPC. Their `execute` is a closure. Instead, the server holds the tool registry; the client configures it via a host-side side channel (Phase 1: direct method call because same JS context; Phase 4: a separate cloneable command like "activate tool by name" + the Worker instantiates the tool).
- `StreamFn` similarly cannot flow. Configured on the server side at construction.
- `AgentEvent` and `AgentMessage` *are* cloneable by shape (plain JSON-ish). Good.
- The `AgentSessionHost` interface in `rpc-server.ts` is the contract the RPC dispatcher speaks. Anything the server needs from the session must be on that interface.

## ZenFS mount layout

ZenFS lets a single `fs.promises`-shaped API cover multiple storage backends at different mount points. We pick three.

### `/vault` — user's local folder

- Backend: `@zenfs/dom` `WebAccess` wrapping a `FileSystemDirectoryHandle` from `window.showDirectoryPicker()`.
- Handle is persisted in IndexedDB via `idb-keyval` under a known key.
- On every page load: read the handle, call `requestPermission({ mode: 'readwrite' })`, mount at `/vault`.
- If the user declines or the handle is invalid, the vault is not mounted; the agent runs without filesystem tools.
- Tools write here. Agent reads here. This is the user's actual disk — no sandboxing, no copy.

### `/extensions` — app-owned extension storage

- Backend: `@zenfs/core` IndexedDB backend.
- Layout: `/extensions/<name>/manifest.json`, `/extensions/<name>/entry.js`, plus any extension-local data files.
- Writable only from privileged internals (extension installer), not from tools.
- Tools cannot read here by default. Extensions get file access to their own directory and nowhere else.

### `/sessions` — app-owned session/chat storage

- Backend: `@zenfs/core` IndexedDB backend.
- Layout: `/sessions/<session-id>/messages.jsonl`, `/sessions/<session-id>/meta.json`.
- Writable only from session internals; not reachable from tools.

### Why IndexedDB, not OPFS

OPFS (Origin Private File System) is the obvious-looking choice for app-owned storage: it's `fs.promises`-shaped, sync-accessible from workers, and nominally faster than IndexedDB. We rejected it.

- **Concurrent tabs corrupt state.** OPFS does not serialise writes across tabs. Two tabs of the same origin writing the same file can produce torn or interleaved bytes with no error surface. The user simply sees broken data.
- **No transactional story.** IndexedDB has `readwrite` transactions that abort atomically. With OPFS, a half-written file stays half-written if the tab closes mid-write.
- **IndexedDB's cost is negligible at our scale.** Session metadata and extension manifests are small. The performance delta doesn't matter.

This is binding. If a contributor reaches for OPFS, the answer is no without a new decision in `05-decisions.md` that explains what changed.

## Extension sandboxing

Extensions are third-party code downloaded from the network. They must not:

- read files outside `/extensions/<self>/`,
- touch `/vault` without going through the agent's tool surface (because users only auth'd tool-surface access, not raw extension access),
- make unaudited network requests from inside the agent's origin.

**Design (Phase 5):** each loaded extension runs in its own Web Worker spawned from a Blob URL. The Worker is given a MessagePort back to the host. Every capability — `registerTool`, `registerProvider`, `read own file`, `make network request to an allow-listed host` — is a discrete RPC command from the extension to the host, which validates it against the extension's declared manifest permissions.

**What the extension cannot do:**

- `window`/`document` access — Worker globals only.
- `fetch` to arbitrary URLs — the host intermediates based on manifest.
- Import from other extensions' code — each Worker is isolated.
- Keep running when idle — Workers can be terminated by the host without warning; extensions must hold no non-persistable state.

We will *also* type-check and schema-validate extension manifests and tool schemas at load time, but the runtime Worker boundary is what makes it actually safe.

## Testing seam: `useDevSeedBoot`

Playwright cannot click through `showDirectoryPicker` — it's a user-gesture-gated native dialog that requires real user focus in Chromium. We need fs-dependent tests to run headlessly in CI.

**Pattern (copied from `bodhiapps/zenfs-browser`):**

1. `e2e/helpers/install-vault.ts` walks a source directory (`e2e/data/<name>/`) and builds a `Record<"/vault/…", utf8>` object.
2. The test calls `await page.addInitScript(args => { window.__zenfsSeed = args.seed; }, { seed })` — so the seed is present *before* any app code runs.
3. The app's `useDevSeedBoot()` hook (gated by `import.meta.env.DEV`) checks for `window.__zenfsSeed`, and if present, pre-mounts an `InMemory` ZenFS backend populated with the seed *before* `useDirectoryHandle` gets a chance to run. `/vault` already exists by the time the rest of the app renders.
4. Production builds: `import.meta.env.DEV` is `false`, the whole `useDevSeedBoot` branch dead-codes, Vite tree-shakes it out. No test code in shipped bundles.

This is the *only* allowed way to prime filesystem state for tests. No `page.evaluate` reaching into ZenFS internals, no exposing singletons on `window` for tests to poke — that produces tests that pass even when the product is broken.

## Reference sources — what we copy, what we don't

### `packages/coding-agent` (node-side sibling)

Copy shapes, do not import:

- RPC command/response/event schema — `modes/rpc/rpc-types.ts` is our pattern.
- `AgentSession` lifecycle — how a turn is driven, how steering/follow-up queues work.
- Extension hook signatures — the event types (`ToolCallEvent`, `TurnEndEvent`, …) are the right surface.
- Tool "operations" pattern — every tool takes an `operations` object so the same tool schema can back node-fs, ZenFS, or an InMemory stub.

**Do not import from `packages/coding-agent`.** It pulls in `fs`, `child_process`, `pi-tui` (terminal), jiti (filesystem-based TS loader). All node-specific, all bundle-breaking, all would block Phase 6 extraction.

### `bodhiapps/zenfs-browser` (browser reference)

Copy patterns for:

- ZenFS mount lifecycle — `mountVault(handle)` / `unmountVault()` as pure functions isolated from React.
- FSA handle persistence + `requestPermission` re-grant flow.
- The dev-seed seam above.

This isn't on npm and we don't depend on it. We read its code for technique; we write our own implementations.

### `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` (direct deps)

Actually used. `pi-ai` gives us model adapters and the stream abstraction; `pi-agent-core` gives us the Agent loop. Both are browser-safe with the `/* @vite-ignore */` hint applied in Phase 0. See `05-decisions.md` D1.

## Phase-6 extraction shape

At the end of the roadmap, `packages/web-agent/src/web-agent/` gets lifted to its own package:

- Its only local dependencies are `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` (both already separately published).
- `react` becomes a `peerDependency`.
- ZenFS, `@zenfs/dom`, `idb-keyval`, `dexie` (if used) move to `dependencies`.
- The current `packages/web-agent/src/` (non-`web-agent/`) becomes a reference app consuming the extracted package.
- Tests split: package-local unit tests stay with the package; Playwright e2e stays with the reference app.

This only works if Principle "`src/web-agent/` imports inward only" (see `04-principles.md`) holds through every phase. Every Phase 2–5 review must check this.

## Open architectural questions (to resolve before the phase that needs them)

- **Phase 4:** which thread holds the ZenFS mount? Handle mounted on main thread + proxy over port, or mounted in Worker directly? Needs benchmarking and an FSA-handle-transferability check before committing.
- **Phase 5:** extension manifest schema — JSON Schema? TypeBox? Zod? Needs to be cloneable and runtime-checkable, should match how `pi-agent-core` tools already declare schemas (TypeBox).
- **Phase 5:** network allow-list format for extensions — glob-on-origin, or full URL patterns?
- **Phase 6:** final package name and scope. `@bodhiapp/web-agent` is a working placeholder.

Each of these lands as a decision in `05-decisions.md` when we actually need the answer.
