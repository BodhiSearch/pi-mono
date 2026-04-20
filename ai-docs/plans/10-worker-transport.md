# M4 — Worker transport (agent + ZenFS off the main thread)

## Context

**The problem.** All web-agent work to date runs on the main thread. The agent loop, tool execution, ZenFS reads, and the React UI share one event loop. While this is fine at M3 scale, every milestone past M4 makes it more expensive to migrate later:

- M5 adds an IndexedDB-backed `/sessions` mount and a turn-end persistence hook — more fs traffic, more JSON serialisation on the UI thread.
- M7 adds compaction — string-heavy work over long histories that will jank the Milkdown editor.
- M8 *requires* a Worker host for the agent because each loaded extension runs in its own Worker and talks to the host as a peer Worker, not to the DOM.
- Phase 6 extraction (`@bodhiapp/web-agent`) requires the public API to be structured-clone-clean. As long as everything runs in-process, accidental closure passing won't surface until extraction.

**The decision.** Move `AgentSession`, the six vault tools, and the ZenFS mount into a single dedicated Web Worker. Main thread keeps React, the directory-handle picker (user-gesture-bound), the file viewer, and the file-tree poll — but its `fs.promises.*` calls go through ZenFS's `Port` backend, which auto-marshals every operation over `MessagePort` to the real backend in the Worker.

**Browser scope.** Chrome ≥ 130. No cross-browser compatibility; the FSA picker is already Chrome-only.

**Why now and not later.** Migration surface is at its minimum: one session, six tools, no sessions/compaction/extensions yet. Every milestone past this point makes M4 strictly larger.

**Test invariant.** All three existing e2e specs (`chat.spec.ts`, `vault-fs.spec.ts` M2, `vault-fs.spec.ts` M3) and all 62 unit tests must stay green without modification. M4 is purely architectural; the user-visible product is identical.

---

## Web research summary (relevant findings)

| Source | Finding | Implication |
|---|---|---|
| MDN — [Structured clone algorithm](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Structured_clone_algorithm) | `FileSystemDirectoryHandle` IS structured-cloneable; deep-cloned (not transferred) across `postMessage`. Both threads end up with their own clone referencing the same underlying directory permission. | We can `postMessage(handle)` from main → Worker after the user picks the folder. No special API needed. |
| ZenFS docs — [`Port` backend](https://zenfs.dev/core/) + local read of `node_modules/@zenfs/core/dist/backends/port.d.ts` | `PortFS` proxies every `fs.promises.*` call over a `MessagePort`-like channel. Pair: `resolveRemoteMount(port, { backend: WebAccess, handle })` on Worker side; `configure({ mounts: { '/vault': { backend: Port, port } } })` on main. Built-in request/response correlation, transfer lists, timeouts. | We don't have to hand-roll the VFS RPC. Use the Port backend directly. UI fs callsites (`useVaultTree`, `FileViewer`, `MarkdownEditor`) need zero changes. |
| [Partytown](https://github.com/QwikDev/partytown) | Designed for sandboxing third-party analytics scripts that need synchronous DOM access. Uses sync XHR + Service Worker + Atomics to fake DOM-on-Worker. Still in beta; "not guaranteed to work in every scenario". Not designed for application logic that does fetch streaming + custom event posting. | Wrong tool. **Skip.** Our agent doesn't need DOM, and Partytown's sync-DOM machinery is overhead we don't need. |
| [Comlink](https://github.com/GoogleChromeLabs/comlink) source + [LogRocket overview](https://blog.logrocket.com/comlink-web-workers-match-made-in-heaven/) | 1.1KB Proxy-based RPC with auto error propagation, transferable handling via WeakMap cache, strict message tagging, FinalizationRegistry-based cleanup. | Confirmed user choice: keep our hand-rolled RPC (~200 lines, working tests). Crib these specific patterns: (a) error round-trip preserving `{ name, message, stack }`; (b) strict envelope tag check (`_webAgent: true` discriminator) so the same port can carry multiple message kinds without cross-talk; (c) explicit `dispose` / `release` with port-close. Skip: Proxy-based path tracking, FinalizationRegistry — overkill for our small surface. |

---

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Single Worker, dual MessageChannels: one for agent RPC (existing protocol), one for ZenFS Port backend. | Keeps the existing `RpcServer`/`RpcClient` exactly as-is. Avoids multiplexing one channel with two protocols. ZenFS Port backend wants its own channel to itself for clean message validation. |
| 2 | Worker mounts the real ZenFS backend (`WebAccess` for production / `InMemory` for dev seed). Main thread mounts `Port` backend pointing at the Worker. | Vault tools execute fully Worker-side with no per-call RPC hop. UI fs callsites unchanged. Clean Phase-6 extraction story. |
| 3 | FSA `FileSystemDirectoryHandle` is acquired on main thread (user gesture required) then sent to Worker via `postMessage`. The handle is structured-cloneable. | Only main thread can call `showDirectoryPicker()`. The clone in the Worker is an independent handle holding its own permission grant — re-grant flow stays on the main thread. |
| 4 | Agent RPC stays hand-rolled. Add `createWorkerTransportPair()` returning the same `Transport` interface as `createInProcessTransportPair()`. | User confirmed. Existing `RpcServer`/`RpcClient`/`rpc-types.ts` untouched. New transport is a sibling to the in-process one; no dispatcher rewrite. |
| 5 | Agent RPC envelope adds a `_webAgent: true` discriminator and a strict-shape check on receive. | Crib from Comlink. The Worker may someday host other message kinds (extension RPC in M8); marking ours up front prevents future cross-talk debugging. Trivial cost now, large debt avoided. |
| 6 | Agent RPC error propagation captures `{ name, message, stack }` and rehydrates as `Error` on the client. | Today errors stringify. With a Worker boundary, debuggability matters more — the stack from the Worker side is the only clue when something fails inside the agent loop. |
| 7 | Auth tokens for `streamFn` (currently captured as a closure on main) are pushed into the Worker via a new RPC command `set_auth_token(token)`. Main side re-pushes on every token rotation. | The `streamFn` must run Worker-side (it's invoked inside the agent loop). Closures don't cross. Push-on-change is simpler than every-call upcall. |
| 8 | MCP tools execute via a "tool-call upcall" channel: Worker emits `{ kind: 'tool_call_request', id, toolName, args }`; main runs the actual MCP HTTP call; main returns `{ kind: 'tool_call_response', id, result }`. | MCP clients are constructed from `bodhiClient` (React-context-bound, holds auth). Hoisting them into the Worker means re-implementing the auth refresh. Upcall preserves the React context; it also gives us the exact pattern extensions (M8) will use. |
| 9 | Vault tools are constructed Worker-side at boot. No upcall needed for them. | Their `VaultOperations` close over the Worker-local ZenFS — local function calls, not RPC. |
| 10 | Worker module is loaded via Vite's native worker import: `new Worker(new URL('./agent-worker.ts', import.meta.url), { type: 'module' })`. Spawned once on app boot, terminated on app unload. | No new dep. Vite handles the chunking and HMR. Single instance per tab keeps the model state coherent. |
| 11 | StrictMode + fast-refresh safety: Worker spawn is module-singleton-guarded (one Worker per browser tab regardless of how many provider mounts run). | Mirrors the existing `mountPromise` guard in `in-memory-vault.ts` and the in-flight guard in `zenfs-provider.ts`. Same problem, same fix. |
| 12 | Dev-seed seam (`window.__zenfsSeed`) is read on main thread at app boot, sent to Worker via the init message. Worker mounts InMemory ZenFS from the seed before any UI fs call resolves. | Keeps the existing `useDevSeedBoot` shape. The seed object is structured-cloneable. |

---

## Architecture

### Topology after M4

```
┌───────────────────────────────────────────────────────────────┐
│ Main thread (React)                                           │
│  ├─ <WebAgentProvider>                                        │
│  │   ├─ useAgent → RpcClient (agent RPC channel)              │
│  │   └─ useVaultMount → posts handle/seed to Worker init      │
│  ├─ ZenFS Port backend mounted at /vault                      │
│  │   (PortFS proxies every fs.promises.* over MessageChannel) │
│  ├─ useVaultTree (polls fs every 500ms)         ┐             │
│  ├─ FileViewer (read on select)                 │ all transparent
│  └─ MarkdownEditor (write on blur+5s)           ┘ via PortFS  │
│                                                               │
│  ChannelA (agent RPC) ◄────── existing protocol ──────────┐   │
│  ChannelB (ZenFS Port) ◄───── ZenFS-internal protocol ──┐ │   │
│                                                         │ │   │
└─────────────────────────────────────────────────────────│─│───┘
                                                         │ │
                            postMessage on each channel  │ │
                                                         ▼ ▼
┌───────────────────────────────────────────────────────────────┐
│ agent-worker.ts (single Web Worker per tab)                   │
│  ├─ ChannelA listener → RpcServer → AgentSession              │
│  │   ├─ pi-agent-core Agent (tool loop + streamFn)            │
│  │   ├─ Vault tools (closure over Worker-local ZenFS)         │
│  │   └─ MCP tool stubs (upcall to main via ChannelA)          │
│  └─ ChannelB listener → ZenFS attachFS / resolveRemoteMount   │
│      └─ Real WebAccess backend wrapping FSA handle            │
│         (or InMemory backend in dev-seed mode)                │
└───────────────────────────────────────────────────────────────┘
```

### Boot sequence

1. Main thread loads. `<VaultProvider>` and `<WebAgentProvider>` mount.
2. Module-singleton boots the Worker once. Worker init message carries: `{ devSeed?: InMemoryVaultSeed, channelA: MessagePort, channelB: MessagePort }`.
3. Worker receives the init message:
   - If `devSeed` present: `resolveRemoteMount(channelB, { backend: InMemory })` and seed it.
   - Else: wait for the next message on ChannelA — `mount_vault(handle)`.
4. Main thread mounts ZenFS Port backend on its side: `configure({ mounts: { '/vault': { backend: Port, port: channelB } } })`.
5. UI consumers (`useVaultTree`, `FileViewer`) start their work. Their `fs.promises.*` calls now flow through PortFS → ChannelB → Worker → real backend. They don't know.
6. User picks a directory (or the dev-seed path skips this). `useDirectoryHandle` posts the handle to the Worker via ChannelA `mount_vault(handle)`. Worker constructs `WebAccess` and `attachFS(channelB, webAccess)`.
7. `useAgent` sends `prompt(...)` over ChannelA. AgentSession runs. Vault tools execute Worker-side; MCP tools upcall via ChannelA. Events stream back over ChannelA.

### Key shapes

```ts
// New transport (sibling of in-process)
export function createWorkerTransportPair(worker: Worker): {
  client: Transport;        // wraps a MessagePort to the Worker
  channelB: MessagePort;    // unattached port for ZenFS
};

// New RPC commands added to existing RpcCommand union
type RpcCommand =
  | ...existing
  | { kind: 'mount_vault'; handle: FileSystemDirectoryHandle }
  | { kind: 'unmount_vault' }
  | { kind: 'set_auth_token'; token: string | null };

// New event kind on RpcEventEnvelope (Worker → Main upcall)
type RpcEventEnvelope =
  | ...existing
  | {
      kind: 'tool_call_request';
      id: string;
      toolName: string;
      args: unknown;
    };

// Response from main back to Worker (new client → server command)
type RpcCommand =
  | ...existing
  | { kind: 'tool_call_response'; id: string; ok: true; result: unknown }
  | { kind: 'tool_call_response'; id: string; ok: false; error: { name: string; message: string; stack?: string } };
```

---

## Phase breakdown

Each phase has its own gate (lint + typecheck + unit test + the e2e specs that *should* still pass at that point). Phases land in one commit total — but checkpoint commits are fine if any phase takes more than a day.

### Phase 0 — Spike + scaffolding (~half day, no functional change)

**Goal.** Verify the assumptions before committing to the architecture. Stand up the Worker harness with no work moved yet.

- Spike script (throwaway, NOT committed): in a fresh Vite page, `postMessage(handle, [])` to a Worker; Worker `WebAccess.create({ handle })` succeeds; Worker writes a file; main reads it via PortFS. Confirms the FSA-handle-clone path works end-to-end in our Vite + Chrome 130+ setup. ≤ 1 hour.
- Add `packages/web-agent/src/web-agent/worker/agent-worker.ts` — empty Worker that prints `[agent-worker] hello` on init. Vite picks it up via `new Worker(new URL(...))`. Confirms the build pipeline.
- Add `src/web-agent/rpc/transports/worker.ts` skeleton — `createWorkerTransportPair(worker)` returning `{ client, channelB }` with a no-op listener. Not yet wired to anything.

**Gate.** `npm run check` + `npm run build` + dev server boots and the Worker logs from devtools. No tests added yet. No tests broken.

### Phase 1 — Worker-side AgentSession + agent RPC over ChannelA (~1 day)

**Goal.** Move `AgentSession` into the Worker, route the existing agent RPC through ChannelA. ZenFS still on main thread for now (vault tools become temporary upcall stubs — see note below).

- `src/web-agent/worker/agent-worker.ts` — receives init message, spawns `RpcServer` bound to ChannelA, instantiates `AgentSession`.
- `src/web-agent/rpc/transports/worker.ts` — full `createWorkerTransportPair`. Implements the `Transport` interface. Wraps `MessagePort.postMessage` and `addEventListener('message', ...)`. Strict envelope tag: every outgoing message is `{ _webAgent: true, ...inner }`; receiver ignores anything without the tag. Crib from Comlink.
- `src/web-agent/rpc/rpc-types.ts` — extend `RpcCommand` with `set_auth_token` (Decision 7). Extend error shape to `{ name, message, stack? }` (Decision 6). Update `RpcServer` and `RpcClient` to round-trip the structured error.
- `src/hooks/useAgent.ts` — swap `createInProcessTransportPair()` for the worker variant. Spawn the Worker via a module-singleton.
- **Temporary tool wiring:** for this phase only, vault tools stay on main thread and become RPC proxies (Decision 8 pattern, but applied to vault tools temporarily). Phase 2 inverts this.

**Gate.** `chat.spec.ts` (no vault) + `rpc.test.ts` updated for new error shape + new vitest `worker-transport.test.ts` mirroring the in-process round-trip suite. M2/M3 specs may flake until Phase 2.

### Phase 2 — Move ZenFS into Worker via Port backend (~1.5 days)

**Goal.** Real architectural shift. Vault tools execute Worker-side directly against ZenFS; UI consumers transparently proxy through PortFS.

- `src/web-agent/worker/agent-worker.ts` — on init, if `devSeed` present, `resolveRemoteMount(channelB, { backend: InMemory })` and seed it; else wait for `mount_vault(handle)` on ChannelA, then `WebAccess.create({ handle })` and `attachFS(channelB, webAccess)`.
- `src/web-agent/fs/zenfs-provider.ts` — main-thread version becomes thin: `mountVault(handle)` posts the handle to the Worker via `RpcClient.mountVault(handle)`; the actual `configure({ mounts: { '/vault': { backend: Port, port: channelB } } })` runs once at app boot in the provider.
- `src/providers/VaultProvider.tsx` — wires ChannelB into the Port backend at provider mount; sends handle/seed to Worker on availability.
- `src/fs/in-memory-vault.ts` — main-thread side becomes a stub that just passes the seed object to the Worker init message. The actual InMemory mount happens in the Worker.
- `src/hooks/useDevSeedBoot.ts` — read `window.__zenfsSeed` and stash it on the Worker init payload. Don't mount on main.
- **Vault tools move into the Worker.** `src/web-agent/worker/agent-worker.ts` calls `createVaultTools(createZenfsVaultOperations())` after the Port mount is ready, then `session.setTools([...])`.
- Remove the temporary main-thread vault tool wiring from Phase 1.
- **MCP tools** stay on main thread, become tool-call upcall stubs (Decision 8). New events `tool_call_request` (Worker → Main) and `tool_call_response` (Main → Worker) wire through ChannelA.

**Gate.** All three e2e specs green unchanged. Vitest suite green. Manual: open dev server, check that `useVaultTree` polling still surfaces files and Markdown editor saves still hit the user's local disk.

### Phase 3 — Hardening + cleanup (~half day)

- Idempotent Worker boot (StrictMode-safe, fast-refresh-safe). Module-singleton with in-flight guard.
- Worker termination on app unload (`worker.terminate()`).
- Error rehydration: confirm a thrown error inside a Worker-side tool surfaces in the chat UI with the original message + stack frames (best-effort across boundary).
- Remove the temporary Phase 1 vault-tool main-thread path — should already be gone after Phase 2, but verify.
- Smoke check: `Worker terminate()` mid-turn; the next prompt must spawn a fresh Worker cleanly (relevant for M5+ session reset).
- Bundle delta: Worker should split into its own chunk; main bundle should *shrink* (agent + tools no longer in main entry).

**Gate.** All milestone-gate items per `ai-docs/milestones.md`.

### Phase 4 — Documentation + commit (~1 hour)

- Update `ai-docs/milestones.md` M4 row → ✅ done with this commit's SHA.
- Add a "M4 — Worker transport (done)" outcome summary to the per-milestone summaries section. Cover: dual-channel choice, ZenFS Port backend usage, MCP upcall pattern, surprises worth remembering.
- Append decisions to `ai-docs/05-decisions.md`:
  - **D7** — Single Worker hosts both AgentSession and ZenFS; dual MessageChannels (one agent RPC, one ZenFS Port).
  - **D8** — MCP tools use upcall pattern; vault tools execute Worker-side (no upcall).
  - **D9** — `_webAgent: true` envelope discriminator + structured error shape, cribbed from Comlink.
- Single commit covering all phases.

---

## Files

### Add

```
packages/web-agent/src/web-agent/
  worker/
    agent-worker.ts            # Worker entry — receives init, spawns RpcServer, mounts ZenFS
    boot.ts                    # main-thread side: spawn-once Worker singleton + init message
  rpc/transports/
    worker.ts                  # createWorkerTransportPair(worker) → { client: Transport, channelB: MessagePort }
  rpc/
    error.ts                   # serializeError / deserializeError preserving {name, message, stack}

packages/web-agent/src/web-agent/rpc/transports/
  worker.test.ts               # mirrors in-process round-trip; uses real Worker via vitest workspace config

packages/web-agent/src/providers/
  AgentWorkerProvider.tsx      # owns the Worker lifecycle + the two MessagePorts; exposes them via context
```

### Modify

```
packages/web-agent/src/web-agent/rpc/
  rpc-types.ts                 # add: set_auth_token, mount_vault, unmount_vault, tool_call_request, tool_call_response; structured error shape
  rpc-server.ts                # handle new commands; emit tool_call_request events; structured error throw
  rpc-client.ts                # serve tool_call_response back to server; structured error rehydrate

packages/web-agent/src/web-agent/core/
  agent-session.ts             # add setAuthToken(token), mountVault(handle), unmountVault(); proxy MCP tool execs through tool_call_request

packages/web-agent/src/web-agent/fs/
  zenfs-provider.ts            # main-thread: mountVault becomes "post handle to Worker"; reuse Port backend mount
  in-memory-vault.ts           # main-thread: pass seed to Worker init (no main-thread ZenFS mount)

packages/web-agent/src/web-agent/index.ts
  # re-export createWorkerTransportPair; keep createInProcessTransportPair for tests

packages/web-agent/src/hooks/
  useAgent.ts                  # use AgentWorkerProvider context; push auth token via set_auth_token on rotation
  useVaultMount.ts             # delegate mount/unmount to RpcClient.mountVault; UI status comes from agent events
  useDevSeedBoot.ts            # read seed and stash for Worker init (no main-thread mount)
  useVaultTools.ts             # DELETE — vault tools now live in the Worker; useAgent stops merging them
useMcpAgentTools.ts            # closures stay; execute path becomes tool_call_request emit + await
useDirectoryHandle.ts          # unchanged (handle still acquired on main)

packages/web-agent/src/providers/
  VaultProvider.tsx            # wire Port backend mount on first render; provide ChannelB to ZenFS
  vault-context.ts             # unchanged shape (status / name / actions)

packages/web-agent/src/components/chat/
  ChatDemo.tsx                 # stop merging vault tools (useVaultTools deleted); pass only MCP tools

packages/web-agent/src/App.tsx
  # wrap with <AgentWorkerProvider>

packages/web-agent/vite.config.ts
  # confirm worker bundling; no plugin changes expected with native Vite worker support

packages/web-agent/src/test/setup.ts
  # may need a Worker shim for vitest (TBD; node-side Worker via jsdom-worker if needed)
```

### Reference (read-only)

- `packages/web-agent/src/web-agent/rpc/transports/in-process.ts` — pattern for the new worker.ts.
- `packages/web-agent/src/web-agent/rpc/rpc-server.ts:20-32` — `AgentSessionHost` interface (add new methods here).
- `node_modules/@zenfs/core/dist/backends/port.d.ts:88-145` — Port backend usage pattern.
- `node_modules/@zenfs/core/dist/internal/rpc.d.ts` — `Channel`, `fromWeb`, `attach`, `resolveRemoteMount` shapes.
- [Comlink source](https://github.com/GoogleChromeLabs/comlink/blob/master/src/comlink.ts) — error transfer handler + envelope tagging patterns to crib.

---

## Test strategy

### Existing tests — must stay green unchanged

- `e2e/chat.spec.ts` — no vault touch; pure agent round-trip. Validates Phase 1.
- `e2e/vault-fs.spec.ts` M2 — seeded vault mounts, file tree shows files, viewer shows content. Validates Phase 2 dev-seed path through Worker.
- `e2e/vault-fs.spec.ts` M3 — agent reads + writes via vault tools, derived file appears in tree, viewer renders it. Validates the full Worker-side tool execution end-to-end.
- All 62 vitest unit suites.

### New unit tests

- `src/web-agent/rpc/transports/worker.test.ts` — round-trip identical in shape to `rpc.test.ts`'s in-process suite; uses a real `Worker` (vitest's `pool: 'threads'` + a tiny test worker entry).
- `src/web-agent/rpc/error.test.ts` — `serializeError`/`deserializeError` preserves `{ name, message, stack }`; `instanceof Error` survives; non-Error values pass through.

### New e2e — none required

This is purely architectural. The user-visible product is identical. Adding e2e here would be busywork; the existing three specs cover the surface.

### Manual verification (Phase 3)

- Dev server boots; DevTools shows the agent worker as a separate context.
- `useVaultTree` polling continues to surface agent-written files.
- Milkdown editor save persists to the user's local disk (FSA round trip).
- Mid-turn `worker.terminate()` followed by a new prompt cleanly recovers (relevant for future M5 session reset).
- Bundle analyzer: agent worker is its own chunk; main entry shrinks.

---

## Gate checks (per `ai-docs/milestones.md#milestone-gate`)

Run sequentially. Failure stops the chain.

1. `cd packages/web-agent && npm run lint:fix` — auto-format.
2. `cd packages/web-agent && npm run check` — lint + `tsc -b`, zero warnings.
3. `cd packages/web-agent && npm test` — vitest including new worker-transport + error tests.
4. `cd packages/web-agent && npm run build` — production bundle, Worker chunk present.
5. `cd packages/web-agent && npm run test:e2e` — all three specs green.
6. `npm run check` at repo root — biome + tsgo + browser-smoke + web-ui + web-agent.
7. No new `any`, no `// @ts-ignore`, no skipped tests.

---

## Out of scope — explicit

- **Comlink adoption.** Confirmed by user; we crib patterns, not the library.
- **Multiple Workers.** Single agent Worker per tab. Per-extension Workers land in M8.
- **SharedArrayBuffer / sync FS bridge.** No COOP/COEP headers needed; everything is async.
- **MCP client hoisting into Worker.** Stays on main; tools upcall.
- **Worker terminate-on-idle / lifecycle policy.** Single Worker for the tab's lifetime; `terminate()` only on tab unload.
- **Bundle splitting beyond what Vite gives natively.** No manual chunking config.
- **Cross-browser support.** Chrome 130+ only.
- **Migrating vault file viewer / markdown editor away from `fs.promises.*`.** They keep their current API; the Port backend is transparent to them.

---

## Verification (end-of-milestone checklist)

- [ ] DevTools shows the agent worker as a separate context.
- [ ] `chat.spec.ts` passes unchanged.
- [ ] `vault-fs.spec.ts` M2 passes unchanged.
- [ ] `vault-fs.spec.ts` M3 passes unchanged — vault tools execute Worker-side, file shows up in tree, viewer renders content.
- [ ] All 62 vitest suites pass; new worker-transport + error suites pass.
- [ ] `npm run build` succeeds; agent-worker chunk visible in dist.
- [ ] Milkdown editor save persists to user's local disk via PortFS round trip.
- [ ] Markdown editor save during an in-flight agent turn does not deadlock.
- [ ] `npm run check` at repo root green.
- [ ] `ai-docs/milestones.md` updated; `ai-docs/05-decisions.md` D7 + D8 + D9 appended.
- [ ] Single commit with message summarising the architectural shift.

---

## Risks worth flagging upfront

- **FSA handle clone semantics.** The cloned handle in the Worker holds an independent permission grant. If the user's permission expires (rare, browser-managed), the Worker-side handle's `requestPermission()` would also need a user gesture — but only the main thread can do that. Mitigation: re-grant flow stays on main; on success, post a fresh handle to the Worker via `mount_vault(handle)`.
- **Vitest's Worker support is uneven.** We may need a small shim or `pool: 'threads'` config for the worker-transport unit test. If genuinely intractable, that test can run as a Playwright smoke instead. Flagged, not blocking.
- **MCP tool upcall latency.** Each MCP call now takes one extra postMessage hop. For the local MCP server case this is negligible; flag if a remote MCP becomes flaky.
- **The Markdown editor writes during an in-flight agent turn.** With Port backend, both paths queue through the same MessagePort. ZenFS Port backend handles concurrent requests with its own correlation IDs, so no expected deadlock — but worth a manual smoke check in Phase 3.
- **`pi-ai` browser safety in Worker context.** Already validated browser-safe in M0 (Vite warning fix). Worker context is a stricter subset than `window` (no DOM), so confirm `streamSimple` doesn't reach for any browser-only globals beyond `fetch`. Spike during Phase 0 if uncertain.
