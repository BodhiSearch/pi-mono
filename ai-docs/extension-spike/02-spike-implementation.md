# 02 — Spike Implementation Writeup

**Purpose.** Record what actually landed on this branch so future work does not have to reverse-engineer the code. This is a description, not an endorsement; weaknesses are listed in [`04-gap-analysis.md`](04-gap-analysis.md).

---

## 1. High-level architecture

Three threads cooperate:

```
┌─────────────────────────┐       ┌───────────────────────────────────┐
│   Main thread (React)   │       │          Agent Worker              │
│                         │       │                                    │
│  useAgent()             │ RPC   │  WorkerAgentHost                   │
│    └─ useExtensions() ──┼───────┼─▶ ExtensionSupervisor              │
│                         │       │     │                              │
│  ExtensionsPopover UI   │       │     │  spawns nested Worker(s)     │
│                         │       │     ▼                              │
│                         │       │  ┌───────────────────────────┐     │
│                         │       │  │  Extension Host Worker    │     │
│                         │       │  │  (one per ext, nested)    │     │
│                         │       │  │                           │     │
│                         │       │  │  • Blob URL ← manifest.src│     │
│                         │       │  │  • await import(blobUrl)  │     │
│                         │       │  │  • factory(api, ctx)      │     │
│                         │       │  │  • net guard on self.fetch│     │
│                         │       │  └───────────────────────────┘     │
│                         │       │                                    │
│  Dexie: sessions+       │ VFS   │  Dexie: extensionBundles +         │
│         entries         │ port  │         extensionEnabled           │
└─────────────────────────┘       └───────────────────────────────────┘
```

Storage layer (Dexie/IDB) and ZenFS vault shared with the rest of web-agent, not shown. Communication between the main thread and the agent Worker uses the existing typed RPC; a new union of commands and events was added for extensions. Supervisor ↔ host-worker uses its own small RPC over the nested `MessagePort`.

---

## 2. Code map (new / modified)

### New — `src/web-agent/core/extensions/`

| File | Purpose | LOC |
|---|---|---|
| `types.ts` | `ExtensionAPI`, `ExtensionContext`, `ExtensionManifest`, event union (trimmed) | 198 |
| `supervisor.ts` | `ExtensionSupervisor` — runs inside the agent Worker; manages nested host Workers, dispatches events, aggregates tools | 362 |
| `supervisor.test.ts` | vitest against an in-process fake Worker | 206 |
| `host/bridge.ts` | `HostCommand` / `HostMessage` RPC types for supervisor ↔ host-worker | 54 |
| `host/host-worker.ts` | Entrypoint for each nested Worker. Loads the bundle, installs the `fetch` guard, wires `ExtensionAPI`, dispatches events back | 226 |
| `store/types.ts` | `ExtensionStore` interface, `ExtensionBundleRow`, `ExtensionEnabledRow`, `InstalledExtensionSummary` | 50 |
| `store/memory-store.ts` | In-memory `ExtensionStore` for tests | 55 |
| `store/dexie-store.ts` | Dexie-backed `ExtensionStore` | 124 |
| `store/*.test.ts` | vitest for both stores | 138 |

### New — `src/web-agent-extensions/`

Three sample extensions, intentionally deterministic so the e2e tests can assert on their effects:

| Folder | Genre demonstrated | Effect |
|---|---|---|
| `echo-prefix/` | `before_agent_start` — system-prompt mutation | Agent replies start with `[EXT:ECHO]` |
| `magic-word-tool/` | `registerTool` — new tool | Tool returns the fixed string `MAGIC_RABBIT_42` |
| `shout-results/` | `tool_result` — mutate tool output | Upper-cases every tool result's text content |

Each sample exports a `{manifest, bundleText}` record. `bundleText` is a literal ESM string (default-exports a factory). Bundling these at build time into the app would be trivial; the spike loads them through the same "install bytes into IDB → blob URL → import" path as user-authored extensions. That is an over-demonstration, not a requirement.

### Modified — existing files

- `core/session/dexie-store.ts` — added `extensionBundles` and `extensionEnabled` tables (Dexie schema v2).
- `worker/worker-host.ts` — wired `ExtensionSupervisor` into `WorkerAgentHost`; added `bootExtensions`, `installExtension`, `uninstallExtension`, `listExtensions`, `setExtensionEnabled`, `applyExtensionEnabled`, `flushPendingExtensionChanges`. Intercepted `prompt()` for `before_agent_start`; wrapped every tool with the `tool_result` chain via `wrapToolWithExtensionChain`. Tracks `userSystemPrompt` separately from the extension-mutated one so it can be restored at `agent_end`.
- `worker/agent-worker.ts` — constructs `DexieExtensionStore`, passes `spawnExtensionHostWorker` factory to the host, calls `host.bootExtensions()` at startup.
- `rpc/rpc-types.ts` — added 5 extension commands (`install_extension`, `uninstall_extension`, `list_extensions`, `set_extension_enabled`, `boot_extensions`) and 5 unsolicited events (`extension_loaded`, `extension_unloaded`, `extension_error`, `extension_notify`, `extension_pending`).
- `rpc/rpc-server.ts` / `rpc-client.ts` — plumbed the new commands + event subscription (`onExtensionEvent`).
- `hooks/useExtensions.ts` — main-thread state hook. Exposes `rows` (installed + built-in), `install`, `uninstall`, `setEnabled`, `refresh`, `enabledCount`.
- `components/chat/ExtensionsPopover.tsx` — popover UI in the chat toolbar with install / enable / disable / uninstall buttons and the `data-testid`/`data-test-state` attributes the e2e tests look for.
- `components/chat/ChatInput.tsx` — inserted `<ExtensionsPopover />` next to the MCP popover.
- `e2e/extensions.spec.ts` + `e2e/tests/pages/ExtensionsPanel.ts` — Playwright spec covering install → enable → prompt → assert conversational impact → disable → uninstall.

Ported / updated docs:

- `packages/web-agent/docs/extensions.md` — author-facing guide (factory signature, events, permissions, lifecycle).
- `packages/web-agent/scratch/m8/README.md` — archive pointer to the promoted code.

---

## 3. Runtime flow — install to visible impact

Happy path (user clicks "Install echo-prefix" and then "Enable"):

1. UI calls `rpcClient.installExtension({ manifest, bytes, source: 'builtin' })`.
2. RPC server in the agent Worker invokes `WorkerAgentHost.installExtension` → `extensionStore.putBundle(...)` into Dexie.
3. Host emits `extension_loaded` over the event channel. (This is a bug — it fires before the extension is actually loaded into the supervisor. See gap analysis §2.)
4. UI calls `rpcClient.setExtensionEnabled(id, true)`.
5. `WorkerAgentHost.setExtensionEnabled` → if no turn is streaming, `applyExtensionEnabled(id, true)` runs immediately: loads the bundle, calls `supervisor.load({ id, manifest, bundleText })`.
6. `ExtensionSupervisor.load` spawns a nested Worker via the injected factory, sends `{type: 'init', manifest, bundleText}`.
7. Host worker constructs a Blob from `bundleText`, creates an object URL, dynamic-imports it, calls the default-exported factory with `(api, ctx)`. The factory's `on('before_agent_start', handler)` and `registerTool(...)` calls update in-Worker state. `api.registerTool` posts `{type: 'register_tool', tool}` back to the supervisor.
8. Supervisor aggregates the tool list across all loaded extensions and calls `onToolsChanged` → `WorkerAgentHost.refreshTools()` → `session.setTools([...wrapped, ...extensionTools])`.
9. User sends a prompt. `WorkerAgentHost.prompt(message)`:
   - Calls `supervisor.dispatchBeforeAgentStart(userSystemPrompt, message)` — each extension with a handler gets the current prompt and returns a mutation; chain short-circuits if an extension returns `cancel`.
   - Sets the mutated prompt on the session.
   - Runs `session.prompt(message)`.
   - In the `finally`, restores `userSystemPrompt` so the next turn starts from the user's baseline.
10. LLM returns `[EXT:ECHO] ...`. e2e assertion passes.

### `tool_result` interception

Every base tool (vault + MCP) is wrapped in `wrapToolWithExtensionChain(tool)` before being handed to `AgentSession.setTools`. The wrapper calls the original tool, then pipes its content array through `supervisor.dispatchToolResult(name, content, isError)`. Each loaded extension's `tool_result` handlers see the current (possibly already-mutated) content and may return a new one. Extension-registered tools are **not** wrapped; they bypass the chain to avoid self-recursion.

### Hot-swap / deferred changes

If `setExtensionEnabled` fires while the agent is streaming, `WorkerAgentHost` records the target state in `pendingExtensionChanges: Map<string, boolean>` and emits an `extension_pending` event. The existing `agent_end` subscription handler calls `flushPendingExtensionChanges()`, applying each queued toggle before the next turn starts. This is the "B4 hot-swap" decision (D21).

---

## 4. RPC surface added (by the spike)

**Commands (main → worker):**

| Command | Payload | Result |
|---|---|---|
| `install_extension` | `{manifest, bytes, source, origin?}` | `InstalledExtensionSummary` |
| `uninstall_extension` | `{extensionId}` | `void` |
| `list_extensions` | — | `InstalledExtensionSummary[]` |
| `set_extension_enabled` | `{extensionId, enabled}` | `void` |
| `boot_extensions` | — | `void` |

**Events (worker → main, unsolicited):**

| Event | Payload | When |
|---|---|---|
| `extension_loaded` | `{extensionId}` | After store write (see bug #1) |
| `extension_unloaded` | `{extensionId}` | After supervisor.unload |
| `extension_error` | `{extensionId, message}` | Spawn / init / handler failure |
| `extension_notify` | `{extensionId, level, text}` | `api.notify(...)` call from inside an extension |
| `extension_pending` | `{extensionId, enabled}` | Toggle queued mid-stream |

All five event types flow through the existing `HostEventSink` + `RpcServer` → `RpcClient` → `onExtensionEvent` path; no new channel.

---

## 5. Security posture, as implemented

What's actually enforced:

- **Per-extension Worker isolation.** Each extension's module graph, globals, and timers are Worker-scoped. A crash in one extension does not touch the agent loop or other extensions.
- **Network allow-list.** `host-worker.ts` wraps `self.fetch` with a guard that rejects any URL whose origin isn't in `manifest.permissions.netOrigins`. The guard is installed before the factory runs, so factory code cannot `delete self.fetch` before the guard binds.
- **No DOM access.** Workers have no `window` / `document`.
- **Termination.** `supervisor.unload(id)` calls `worker.terminate()`. Instant tearing down regardless of what the extension was doing.

What's **declared but not enforced** (gap):

- `fs:vault` / `fs:self` — the `manifest.permissions` field is typed and accepted, but no code path consumes them. Extensions never actually get a vault handle in the spike.
- No rate limiting on `registerTool` calls. An extension can register 10,000 tools and flood `refreshTools`.
- No bundle-size cap. Installing a 50MB extension is accepted.
- No signing / SRI. "Source: builtin" vs "source: upload" is a label only.

---

## 6. Tests

- **Unit (vitest).** `store/memory-store.test.ts`, `store/dexie-store.test.ts`, `supervisor.test.ts`. Cover CRUD, enable/disable, `aggregatedTools`, `dispatchBeforeAgentStart`, `dispatchToolResult`. 247 tests total in the web-agent package after M8.
- **E2E (Playwright).** `e2e/extensions.spec.ts`. Two scenarios:
  1. `echo-prefix` full lifecycle: install → enable → prompt → assert `[EXT:ECHO]` in reply → disable → assert marker absent → uninstall.
  2. `magic-word-tool` full lifecycle: install → enable → prompt "what is the magic word" → assert agent invokes `get_magic_word` → assert `MAGIC_RABBIT_42` in tool result + final reply.
- **Not covered.** Error paths (malformed manifest, bundle that throws at import, `registerTool` collisions, mid-stream toggle actually taking effect after `agent_end`, cross-tab consistency, `self.fetch` guard rejecting cross-origin). See gap analysis.

---

## 7. Lines of code, end to end

| Area | LOC added |
|---|---|
| Extension runtime (`core/extensions/**`) | ~1 220 |
| Built-in samples + bundle harness | ~160 |
| RPC surface additions | ~140 |
| UI (hook + popover + page object) | ~520 |
| E2E spec | ~140 |
| Docs (`docs/extensions.md`) | ~230 |
| **Total** | ~2 410 |

This is roughly 6× what an equivalent "built-in extensions toggle" would cost (see [`03-unbiased-approach.md`](03-unbiased-approach.md)).

---

## 8. What the spike does and does not prove

**Does prove.**

- Nested Worker + blob URL + dynamic import works, in principle, in Chromium and Firefox at runtime. You can load a user-authored extension and see its effects without restarting anything.
- The `ExtensionAPI` shape ported from coding-agent is expressive enough for the three M8 genres.
- The `pending + flush at agent_end` pattern is clean and matches the compaction deferral.
- Dexie schema v2 migration from v1 does not lose existing sessions.

**Does not prove.**

- That this works reliably under Vite's dev server (see [`04-gap-analysis.md`](04-gap-analysis.md)).
- That users will author extensions in a self-contained-ESM string format, which is the world's worst authoring UX.
- That the three genres generalise — there are extensions coding-agent supports (path guards, providers, renderers) that this surface cannot yet express.
- That the permission model, as sketched, is sufficient for untrusted code. It isn't; only `net:<origin>` is enforced.

Recommendation for the next reader: treat this branch as a **proof that the option is viable**, not as a foundation to build on.
