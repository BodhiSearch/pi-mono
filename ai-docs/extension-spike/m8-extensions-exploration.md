# M8 Extensions — Exploration & Research Context

Scope: everything we know before running any experiment. Read this before the research plan ([m8-extensions-plan.md](m8-extensions-plan.md)).

Two primary references for what "extensions" means:

- **pi-coding-agent** (`packages/coding-agent/`) — the source of truth for the extension contract we are porting. See §1 for the anatomy and [the coding-agent README / docs/extensions.md](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#extensions) for the shape of real-world extensions.
- **mitsuhiko/agent-stuff** — a large public collection of real pi-agent extensions ([repo](https://github.com/mitsuhiko/agent-stuff)). Useful for calibrating what real extensions do, how TUI-heavy most are, and which genres translate to a browser.

---

## 1. pi-coding-agent extension system anatomy

### 1.1 `core/extensions/types.ts` (everything the contract surfaces)

- **Event union `ExtensionEvent`** (22 types). Grouped:
  - **Session**: `session_start`, `session_before_switch`, `session_before_fork`, `session_before_compact`, `session_compact`, `session_shutdown`, `session_before_tree`, `session_tree`.
  - **Agent loop**: `context`, `before_provider_request`, `after_provider_response`, `before_agent_start`, `agent_start`, `agent_end`, `turn_start`, `turn_end`.
  - **Message**: `message_start`, `message_update`, `message_end`.
  - **Tool**: `tool_execution_start`, `tool_execution_update`, `tool_execution_end`, `tool_call` (pre, mutable args), `tool_result` (post, mutable content/details/isError).
  - **Model**: `model_select`.
  - **Other**: `resources_discover`, `input`, `user_bash` (node-only — drop).
- **`ExtensionAPI`** — what a factory receives. Surfaces: `on(event, handler)`, `registerTool`, `registerCommand`, `registerShortcut`, `registerFlag`, `registerMessageRenderer`, `registerProvider`/`unregisterProvider`, `sendMessage`, `sendUserMessage`, `appendEntry`, `setSessionName`/`getSessionName`/`setLabel`, session-metadata getters, `exec` (shell — drop), model/thinking-level control, `events: EventBus`.
- **`ExtensionContext`** — second arg to handlers. `ui`, `hasUI`, `cwd`, `sessionManager`, `modelRegistry`, `model`, `signal`, `abort`, `compact`, `getContextUsage`, `getSystemPrompt`, etc.
- **`ExtensionUIContext`** — very TUI-heavy (`setWidget`, `setFooter`, `setHeader`, `setEditorComponent`, `onTerminalInput`, `custom` overlays, theme control). Most of this has no browser analog; we trim aggressively.
- **`ToolDefinition`** — name, TypeBox `parameters`, `execute`, optional `renderCall`/`renderResult` (TUI component factories — drop).

### 1.2 `runner.ts` (lifecycle, dispatch)

- Holds `extensions: Extension[]` + shared `runtime: ExtensionRuntime`.
- Two-phase init: constructor binds sessionManager + modelRegistry + cwd; `bindCore(actions, contextActions, providerActions?)` fills in action stubs after load, flushes queued `pendingProviderRegistrations`; `bindCommandContext`/`setUIContext` swap in interactive bits.
- Dispatch variants: generic `emit` (chain, `session_before_*` short-circuits on `cancel:true`), `emitToolCall` (mutate `input`, block on `block:true`), `emitToolResult` (chain mutations to `content`/`details`/`isError`), `emitContext` (chain message list), `emitBeforeProviderRequest` (chain payload), `emitBeforeAgentStart` (chain systemPrompt + collect `message` pushes), `emitInput` (chain, `handled` short-circuits), `emitResourcesDiscover` (collect skill/prompt/theme paths), `emitUserBash` (first-result-wins — drop).

### 1.3 `loader.ts` (node-only, fully replaced)

- jiti with `virtualModules` so extensions can `import "@mariozechner/pi-agent-core"` in dev or in a Bun binary.
- Discovery: walks `cwd/.pi/extensions`, `~/.pi/extensions`, reads `package.json` `pi` manifests.
- None of this survives the browser. The conceptual shape (factory function, throwing action stubs, `Extension` record) is what we copy.

### 1.4 `wrapper.ts` (thin ToolDefinition → AgentTool adapter)

- One function `wrapToolDefinition(def, () => runner.createContext())` that turns an extension-registered tool into a pi-agent-core `AgentTool`. Trivial to port.

### 1.5 "What's possible" per coding-agent README

Direct quote from the README's Extensions section: *custom tools (or replace built-ins), sub-agents and plan mode, custom compaction, permission gates and path protection, custom editors and UI components, status lines/headers/footers, git checkpointing and auto-commit, SSH and sandbox execution, MCP server integration, games (Doom runs), "anything you can dream up."* Most of these are TUI-dependent; see §3 below for the browser-compatible subset.

### 1.6 How real extensions look (mitsuhiko/agent-stuff sample)

From the [agent-stuff README](https://github.com/mitsuhiko/agent-stuff):

- **Pure text / UX**: `whimsical.ts` (random thinking phrases), `notify.ts` (desktop notification on idle), `prompt-editor.ts`.
- **Data stored in-process / on disk**: `todos.ts`, `context.ts` (introspection), `session-breakdown.ts` (session analytics TUI).
- **Tool replacement / augmentation**: `multi-edit.ts` (replaces built-in `edit` with batch/patch), `answer.ts` (interactive Q&A tool for the LLM).
- **Session control flow**: `split-fork.ts` (spawns new pi in a Ghostty split), `loop.ts` (auto-continuation), `go-to-bed.ts` (late-night guard).
- **Workflow tools**: `review.ts`, `commit.ts` skill, `files.ts` (browser).
- **Pi skills** (playbook-style markdown referenced by the agent): `/commit`, `/github`, `/mermaid`, `/librarian` (git checkout cache), `/summarize`, `/sentry`, `/web-browser`, etc.

Observations:

- Many extensions lean heavily on pi's **TUI APIs** (`ui.custom`, `setWidget`, `setEditorComponent`) — these are the most interactive but also the least portable.
- A surprising number are **pure event-hook mutations** (whimsical, notify, commit-subject enforcement, go-to-bed) — these port to a browser with zero UI work.
- **Skills** are largely markdown playbooks + a few custom scripts. In a browser these are "add this skill path to the system prompt" + optional scoped tool registrations. Very portable.
- **Process-spawning** extensions (split-fork, tmux, uv, openscad) have no browser analog and must be dropped or replaced.

---

## 2. web-agent current structure (what we plug into)

### 2.1 Infrastructure already in place

- **Agent Worker** (`packages/web-agent/src/web-agent/worker/agent-worker.ts`, `worker-host.ts`). Owns `AgentSession`, `SessionManager`, vault FS, MCP proxy tools, compaction. Extensions plug in here, not in the main thread.
- **Message-channel RPC** (`rpc/rpc-types.ts`, `rpc-server.ts`, `rpc-client.ts`). Typed commands + unsolicited events (`compaction_start`/`compaction_end` pattern is the model for synthetic events).
- **Agent event subscription**. `AgentSession.subscribe(handler)` already feeds `message_end` into the write chain in `WorkerAgentHost`. Extensions subscribe through the same stream.
- **Tool injection**. `AgentSession.setTools(tools)` + `WorkerAgentHost.refreshTools()` already support dynamic list updates. Extension-registered tools append to this list.
- **`SessionManager` + `ReadonlySessionManager`** (per D11) — already shaped to match coding-agent's `ExtensionContext.sessionManager`.
- **`HostEventSink`** in `RpcServer` — synthetic unsolicited events out of the worker without a new channel.
- **`UiMessageMeta` parallel array** (M7) — metadata alongside messages without mutating shared types; model extensions can reuse the pattern.

### 2.2 Scaffolding to be replaced

- `packages/web-agent/src/web-agent/core/extensions/types.ts` — minimal stub (`isIdle`, `abort`, `on`, `registerTool`), not barrel-exported ([`index.ts`](packages/web-agent/src/web-agent/index.ts) lines 98–99). D17 in `05-decisions.md` acknowledges the earlier registry was removed pre-extraction.

### 2.3 Missing pieces

- Extension loader (any form).
- Extension runner / dispatcher.
- Extension worker harness.
- Enabled-list persistence.
- Install/list/permission UI.
- No skill reference.

### 2.4 Reference app plug points

- `Layout.tsx` is `Header | VaultPanel + FileViewer | ChatDemo(420px)`. Extension UI likely lives as a modal triggered from the header, a settings dropdown, or alongside `SessionPicker` in `ChatDemo`.
- `src/App.tsx` uses Bodhi `clientState` for setup flow — that's a separate concept (Bodhi browser extension) and does **not** interact with our M8 extension system.

---

## 3. Extension categories — what's browser-viable

Taxonomy with an eye toward which sample extensions we'll build during research. Each row names (a) the minimum ExtensionAPI surface it needs, (b) whether it touches the DOM / main thread, (c) whether our current M7 surface is already sufficient.

| Category | Example | Needs | Main-thread touch? | Today's surface OK? |
|---|---|---|---|---|
| Pure text-mutation hooks | uppercase-echo (`tool_result` mutation), whimsical thinking ("setWorkingMessage") | `on(event)` | No (setWorkingMessage: yes) | Yes for tool_result; setWorkingMessage needs a small extra RPC event or a UI surface |
| Permission / policy gates | Block `write` to `/vault/.secrets` | `on("tool_call")` with `block:true` | No | Yes |
| Vault-backed data tools | Todos stored as `/vault/.todos.md`, a `todos` tool | `registerTool`, access to vault FS (already shipped as built-in tools) | No | Yes |
| Custom slash command | `/commit` generates commit-message text from vault diff | `registerCommand` | Commands UI (future M9) | Partial — M9 surface needed |
| Custom tool that fetches URLs | `fetch_url(url)` tool with net:<origin> | `registerTool`, net permission, Worker `fetch` | No | Almost — need net permission model |
| Custom model provider | "Local Ollama at :11434" | `registerProvider` | No | Requires wiring `registerProvider` into our model-selection path |
| Browser-native notification | `desktop-notify` on idle | `api.on("agent_end")` + browser `Notification` API | Yes — Notification API is main-thread-only | Needs a `ui.notify(level, msg)` bridge we define |
| Clipboard / web-share | Copy last assistant to clipboard | main-thread `navigator.clipboard` | Yes | Needs UI bridge |
| Custom message renderer | Mermaid diagrams from code-block fences | `registerMessageRenderer` returning JSX | Yes | Not yet — renderer API needs design (React vs HTML string vs structured-clone-safe DSL) |
| Session analytics | Read `SessionManager`, emit summary when idle | `sessionManager`, `ui.notify` | Partially | Yes for read; no for notify |
| Agent skill (playbook + optional tools) | A skill that biases the agent to write idiomatic React, plus a `component-skeleton` tool | `resources_discover` (M9) OR injected via before_agent_start | No | Can simulate in M8 via `before_agent_start` + tools |
| MCP-over-HTTP in extension | Remote MCP server called by an extension tool | `registerTool` + `fetch` | No | Yes with net permission |
| Games / canvases | Doom-in-terminal equivalent | Would need `ui.custom` with canvas | Yes | Deferred — huge renderer API surface |

Research sample extensions we should actually build during the experiments (one per genre we care about for M8 scope):

1. **uppercase-echo** — tool_result mutation (baseline for every loading-mechanism spike).
2. **working-message-jokes** — overrides streaming "working..." text. Tests whether `ExtensionUIContext` needs a minimal bridge.
3. **path-guard** — tool_call pre-hook blocks writes into `/vault/.secrets`. Tests block-semantics.
4. **vault-todos** — registerTool + vault access. Tests tool registration ergonomics.
5. **fetch-url-tool** — registerTool that does `fetch(url)` inside the extension worker. Tests net permission + cross-origin fetch behavior.
6. **ollama-provider** — registerProvider for a local Ollama endpoint. Tests model-registry plumbing.
7. **mermaid-render** — registerMessageRenderer with a Markdown-like preview. Tests renderer API; may be deferred if too large.
8. **greeting-skill** — a minimal skill (just a prompt template + a scoped tool) to validate the skills-as-extensions story (K2 + K4).

We don't need to build all 8 for the feasibility study — 1, 3, 4 cover the loading/registration hot path; 5 validates fetch permission; 6 validates providers; 7 is a stretch goal; 8 validates K-axis goals.

---

## 4. Loading & lifecycle approach matrix

Two orthogonal design axes. The research experiments in [m8-extensions-plan.md](m8-extensions-plan.md) map to the cells.

### Axis A — where the extension code comes from

| Approach | Summary | Storage |
|---|---|---|
| **A1. Cross-origin URL + dynamic import** | Host extension ESM on a separate origin; `await import(url)` inside a Worker | None; browser HTTP cache |
| **A2. Same-origin static file + dynamic import** | Extension served by the app's own dev/prod server | None beyond the app bundle |
| **A3. ZenFS-stored bytes → Blob URL → dynamic import** | One-time fetch to an IDB-backed `/extensions/` mount, rehydrate via `URL.createObjectURL(new Blob([bytes], {type:'text/javascript'}))` | ZenFS `/extensions` |
| **A4. Dexie-stored bytes → Blob URL → dynamic import** | Same as A3 but raw Dexie table, not ZenFS (aligns with D13/D14 session swap rationale) | Dexie table |
| **A5. Build-time static import (vite `glob`)** | Extensions live under `src/extensions/**` or as npm deps; vite's import graph resolves them at build | None at runtime |
| **A6. Build-time + runtime hybrid** | Bundle a core set statically, allow extra extensions via one of the dynamic approaches | Combination |

### Axis B — lifecycle / reconfiguration UX

| Approach | Summary |
|---|---|
| **B1. Add/remove requires rebuild** | Paired with A5 only. Publishing a new bundle is the only way to change extension set |
| **B2. Enable/disable via config; page reload to apply** | Store enabled-list in DB; on next full page reload, loader composes the active set |
| **B3. Enable/disable via config; agent-worker restart (no page reload)** | Main thread survives; agent Worker is disposed + rebooted with new extension set. Tools/sessions re-hydrate from DB |
| **B4. Live hot-swap without restart** | Dynamically spawn/terminate extension Workers, update tool registry, update handler tables, inform the agent Worker of changes without resetting session state |

### Combinations of interest (not every pair makes sense)

| Pair | Makes sense? | Notes |
|---|---|---|
| A5+B1 | Yes, simplest | "Build-time plugin composition" — common in product apps |
| A1+B4 | Yes, richest | "Live install from URL" — full hot-swap UX |
| A3+B4 | Yes | Offline-capable + hot-swap; requires ZenFS |
| A4+B3 | Yes | Middle-ground: Dexie persistence + agent-worker restart per change |
| A2+B2 | Yes | "App ships a small set, user picks which to turn on, reload" |
| A1+B1 | No | Mismatched — if you have runtime loading, B1 rebuild makes no sense |

### Evaluation dimensions

Each experiment's findings should score against:

1. **Complexity** (code + tests required).
2. **Offline support** (does reload work with no network?).
3. **Third-party install-ability** (can a user paste a URL and install, or is it rebuild-only?).
4. **Type safety** (does the extension's manifest/API type-check at compile time?).
5. **UX cost** (does enabling/disabling require a page reload, worker restart, or nothing?).
6. **Security surface** (what can a malicious extension reach? what's the default deny?).
7. **Extraction compatibility** (will this still work when `src/web-agent/` becomes `@bodhiapp/web-agent`?).
8. **Vite/Worker build correctness** (does Vite 8 bundle it?).
9. **Parity with coding-agent contract** (does the extension factory shape match so code ports unmodified?).
10. **Debuggability** (source maps, stack traces, console access inside the extension Worker).

---

## 5. Risks & constraints common to all approaches

- **CORS + CSP.** Any dynamic-import approach needs the browser to accept the module script. In dev we control both servers; in production the consumer app's CSP must whitelist the extension origin (or same-origin delivery sidesteps this).
- **Module identity across extensions.** Within a single Worker, `import("same-url")` returns the same module exports object. Across Workers, each spawns its own module graph. Our "one Worker per extension" default gives clean isolation.
- **Blob URL idempotence.** `URL.createObjectURL(blob)` gives a unique URL each call — two extensions built from the same bytes will have separate module instances. Fine for isolation, means cache-by-content doesn't happen automatically.
- **Supply chain / integrity.** Any runtime-load mechanism (A1–A4) is a supply-chain attack surface. Sub-Resource Integrity hashes pinned in the manifest are the obvious mitigation; out of scope for feasibility spikes but cost-model it in findings.
- **Principle #1.** `src/web-agent/` cannot import `packages/coding-agent`. Types are ports, not imports. Spike code that temporarily imports is fine; production code must not.
- **Principle #3.** `src/web-agent/**` cannot import `@/...`. Extensions themselves **can** import anything — but the framework code wiring them cannot.
- **Principle #2.** Storage is IndexedDB, not OPFS. A3 and A4 both comply.

---

## 6. Execution environment (for experiments)

- **Reference app dev server**: `packages/web-agent/` Vite dev on `:25173` (`npm run dev` under `packages/web-agent`).
- **Bodhi server**: user-managed, running on `:11135` via `make app.run` in `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/BodhiApp`. Already running. Feeds the chat LLM.
- **Credentials**: `packages/web-agent/.env.local` and `packages/web-agent/e2e/.env.test` hold Bodhi client ID, auth server URL, etc.
- **Extension static server** (when testing A1): simple Node `http` server on a different port (e.g. `:21136`), set CORS permissive in dev only.
- **Browser automation** for live exploration: `cursor-ide-browser` MCP (documented in system rules). Use for quick visual checks. Playwright for deterministic specs.
- **Test seams**: vitest for bridge logic (in-process MessageChannel); Playwright under `packages/web-agent/e2e/` for end-to-end.

---

## 7. Open questions that the research will resolve

- Which combination of Axis A × Axis B gives the best balance of complexity, UX, and extensibility for v1?
- Is `registerMessageRenderer` worth the cross-boundary cost in M8, or deferred to a later milestone?
- Can the "skill" concept be satisfied entirely by `before_agent_start` + scoped tools in M8, or does it require M9's resource loader?
- Is one-Worker-per-extension viable under Vite 8 + nested-Worker semantics, or do we spawn extension Workers from the main thread and relay?
- What's the minimum viable permission model when there is no `/extensions/<name>/` mount (because we may not use ZenFS)?

All of the above feed into a single decision at the end of the research phase (see [m8-extensions-plan.md](m8-extensions-plan.md) §"Decision gate").
