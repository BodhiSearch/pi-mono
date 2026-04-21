# coding-agent vs web-agent

**Scope:** architectural comparison between the two in-repo agent harnesses.

- `packages/coding-agent/` — mature Node-runtime coding agent (stdin/stdout RPC, pi-tui interactive mode, local filesystem, child-process bash, file-backed auth + sessions).
- `packages/web-agent/` — browser-runtime coding-agent harness built around a Web Worker, an RPC wire protocol, ZenFS over File System Access, IndexedDB sessions, and a single pluggable `LlmProvider`. The worker-side runtime under `packages/web-agent/src/worker-agent/` is the extraction target for the future `@bodhiapp/bodhi-web-agent` library.

**Hard rule (from `CLAUDE.md`):** `packages/web-agent/` must not import from `packages/coding-agent/`. coding-agent pulls Node-only deps (`fs`, `child_process`, `jiti`, `pi-tui`) that would break browser bundling and block Phase 6 extraction. web-agent studies coding-agent's patterns — session shape, RPC schema, extension hooks, tool "operations" — and **ports** them, accepting short-term duplication.

This doc is a map of **where those ports are aligned, where they intentionally diverge, and what is still missing on either side**. It does not spec either harness in depth — see [`worker-agent/`](./worker-agent/index.md) and [`worker-bodhi/`](./worker-bodhi/index.md) for the web-agent specs; coding-agent does not (yet) have a matching spec folder in this repo.

## 1. High-level shape

| Axis | `coding-agent` | `web-agent` |
| --- | --- | --- |
| Runtime target | Node 20+ CLI binary (`main.ts`) | Browser — React host + Web Worker (`worker-agent/worker/agent-worker.ts`) |
| Process model | Single process, pi-tui for interactive, stdin/stdout for RPC, one-shot for print | Main thread ↔ Worker over `MessagePort`; in-process `MessageChannel` fallback for dev/tests |
| Entry points | `main()` → InteractiveMode / runPrintMode / runRpcMode (`src/modes/`) | `getAgentWorker()` (main-thread boot) + `agent-worker.ts` (Worker entry); React app in `packages/web-agent/src/` is one consumer |
| Extraction target | Standalone npm published from this folder | `@bodhiapp/bodhi-web-agent` (future) carved out of `src/worker-agent/` — everything outside that folder is host code |
| Concrete provider scope | In-tree: file-system auth storage, OAuth providers, JSON-defined providers/models (`model-registry.ts`) | In-tree provider abstraction only; concrete impl lives in sibling `src/worker-bodhi/` (or any host-supplied `LlmProvider`) |

## 2. Where they are aligned (ported patterns)

These are the surfaces web-agent explicitly copied from coding-agent to keep extension authors, session files, and RPC clients fluent across both.

### 2.1 Session format (wire-compatible ports)

`core/session/types.ts` in web-agent is a 1:1 port of `core/session-manager.ts` shapes in coding-agent:

- `CURRENT_SESSION_VERSION = 3`.
- `SessionHeader`, `SessionEntryBase`, `SessionMessageEntry`, `ModelChangeEntry`, `ThinkingLevelChangeEntry`, `CompactionEntry<T>`, `BranchSummaryEntry<T>`, `CustomEntry<T>`, `LabelEntry`, `SessionInfoEntry`, `CustomMessageEntry<T>`.
- `buildSessionContext`-style replay semantics (last `model_change` wins; compaction entries swap head-of-branch).

Several of these (`ThinkingLevelChangeEntry`, `BranchSummaryEntry`, `LabelEntry`, `CustomEntry`, `CustomMessageEntry`) are **ported up front but not yet written by the runtime** — the goal is that a future extension host (M8) can read coding-agent sessions and vice versa without a format break.

### 2.2 RPC command vocabulary

Both harnesses run the same core turn / session verbs (names differ in casing only):

| Verb | coding-agent (`modes/rpc/rpc-types.ts`) | web-agent (`worker-agent/rpc/rpc-types.ts`) |
| --- | --- | --- |
| Prompt turn | `prompt` | `prompt` |
| Abort | `abort` | `abort` |
| Query state | `get_state` | `get_state` |
| Messages | `get_messages` | `get_messages` |
| Set model | `set_model { provider, modelId }` | `set_model { provider, modelId }` |
| List models | `get_available_models` | `get_available_models` |
| Session list | (SessionManager APIs via mode glue) | `list_sessions` |
| New session | `new_session { parentSession? }` | `new_session { parentSession? }` |
| Switch session | `switch_session { sessionPath }` | `load_session { sessionId }` |
| Fork | `fork { entryId }` | `fork_session { fromEntryId }` |
| Navigate tree | (in-process `navigateTree` API) | `navigate_to_leaf { entryId }` |
| Session name | `set_session_name { name }` | `set_session_name { name }` |
| Compact | `compact { customInstructions? }` | `compact_now` |
| System prompt | (in-memory property on `AgentSession`) | `set_system_prompt { prompt }` |
| Reset | (implicit via `new_session`) | `reset` |

Both use typed `RpcResponse` envelopes correlated by `id`, and both emit unsolicited events (agent events + synthetic events) on the same channel.

### 2.3 Tool "operations" pattern

Both define filesystem tools through an **operations interface** that the tool consumes, so the same tool logic runs against different back ends:

- coding-agent: `ReadOperations`, `WriteOperations`, `EditOperations`, `LsOperations`, `GrepOperations`, `FindOperations`, `BashOperations` — Node `fs` implementation via `createLocalBashOperations` etc. (`core/tools/`).
- web-agent: the same operations interfaces, wired to **ZenFS** through `createZenfsVaultOperations` (`fs/zenfs-operations.ts`) and exposed via `createVaultTools`. Tool definitions (`read.ts`, `write.ts`, `edit.ts`, `ls.ts`, `glob.ts`, `grep.ts`) mirror the coding-agent shape so extension prompts remain identical.

### 2.4 Compaction pipeline

Both implement the same 4-stage pipeline (token estimation → cut-point selection → summarisation → entry persistence):

- coding-agent: `core/compaction/{estimate,findCutPoint,generateSummary,compact}`.
- web-agent: `worker-agent/core/compaction/{token-estimate,prepare,summarize,serialize,file-ops}`.

Both surface a lifecycle: `compaction_start` → `compaction_end` events, and both persist a `CompactionEntry` that subsequent `buildSessionContext` calls use to swap the head of the branch with a summary message.

### 2.5 Agent core

Both harnesses are thin wrappers over `@mariozechner/pi-agent-core`'s `Agent`:

- coding-agent: `AgentSession` (3000+ loc) owns the `Agent`, composes tools/streamFn/extensions, persists messages via `SessionManager`.
- web-agent: `AgentSession` (120 loc, `core/agent-session.ts`) is a minimal plain-data wrapper; persistence, streamFn wiring, event fan-out, and session replay live in `WorkerAgentHost` (`worker/worker-host.ts`).

The division is deliberate — see §3.

## 3. Where they diverge (and why)

### 3.1 Transport: stdio JSONL vs `MessagePort` structured clone

- **coding-agent** RPC mode runs on top of stdin/stdout JSONL (`modes/rpc/jsonl.ts`, `modes/rpc/rpc-mode.ts`). Commands and responses are JSON lines; streams are deterministic because stdout is taken over with `output-guard.ts`.
- **web-agent** runs on top of `postMessage` + structured clone (`worker-agent/rpc/transport.ts`, `transports/`). This buys cheap `ArrayBuffer`/`MessagePort`/`FileSystemDirectoryHandle` transfer at the cost of a hard rule: **no functions may cross the RPC** (closures don't clone). That constraint ripples through the rest of the architecture — MCP tools can't ship across, streamFn is wired worker-side only, tool executors are installed by the worker host rather than configured via RPC.

### 3.2 Auth + model registry: monolithic vs single provider seam

- **coding-agent** bundles **everything** — auth storage, OAuth flows, JSON-defined providers, model inventory, per-request header resolution — into `core/auth-storage.ts` + `core/model-registry.ts` (~1250 lines combined). A user can drop provider/model JSON into `~/.pi/` to extend the matrix; OAuth credentials live on disk.
- **web-agent** exposes a single 30-line `LlmProvider` interface (`worker-agent/llm/types.ts`) with two methods (`getApiKeyAndHeaders`, `getAvailableModels`) plus an optional `setAuthToken` rotation sink. The **host** owns auth storage (React providers, `localStorage`, etc.) and **rotates credentials into the worker** via the `set_auth_token` RPC. The concrete provider (`worker-bodhi/bodhi-provider.ts`) fetches the catalog on demand from `/bodhi/v1/models` and maps every alias variant to `Model<Api>`.

    **Why:** browsers don't have a file-system-level credential store, and the extracted `@bodhiapp/bodhi-web-agent` library needs to be usable behind any auth scheme (Bodhi, Supabase, custom OAuth, raw API key). Collapsing auth + catalog into one provider interface is the smallest possible coupling point.

### 3.3 Sessions: append-only JSONL on disk vs Dexie with in-memory fallback

- **coding-agent**: one session = one `.jsonl` file under `~/.pi/sessions/`. `SessionManager` (1425 loc) does `appendFileSync`/`readFileSync` directly. Sessions are browsable with `cat`, `jq`, `grep`.
- **web-agent**: `SessionStore` interface with **Dexie (IndexedDB)** as the primary backend and an in-memory store for tests (`core/session/{store,dexie-store,memory-store}.ts`). The same entry shapes are persisted but addressed by `(sessionId, entryId)` rows instead of file offsets. A single write chain (`turnBoundaryPersistence` in the host) serialises message persistence, auto-compaction, and `session_loaded` re-emission so parent-id links never dangle.

    **Why:** browsers can't write JSONL files directly. Dexie gives transactional writes, indexed lookups, and survives tab refresh. The append-only invariant is still there — entries are only ever added, never mutated.

### 3.4 Filesystem: process.cwd() vs FSA vault

- **coding-agent** tools walk real paths under `process.cwd()` and call Node `fs`.
- **web-agent** mounts a user-selected `FileSystemDirectoryHandle` (from the FSA picker) as a ZenFS volume at `VAULT_MOUNT`, or an in-memory seed for dev. Tool paths are always vault-relative and go through `resolveVaultPath` for sandboxing. The vault handle is forwarded to the Worker over a dedicated `vfsPort`; mounting is driven by `mount_vault` / `unmount_vault` RPCs.

    **Why:** the browser has no process-level CWD, and the security boundary must be enforced in code since the Worker can't `chroot`.

### 3.5 Tool hosting: worker-local vs main-thread MCP proxy

- **coding-agent** tools are all local — `bashTool`, `readTool` etc. execute in-process with unrestricted access to the host Node environment.
- **web-agent** has **two tool origins**:
  1. **Worker-local vault tools** — `createVaultTools` runs inside the Worker against ZenFS.
  2. **MCP proxy tools** — descriptors are registered in the Worker via `set_mcp_tools`, but when the agent invokes one the Worker emits a `tool_call_request` event up to the main thread, the host runs the actual MCP call (where the `bodhiClient` + auth context lives), and pipes the result back via `tool_call_response`. This is web-agent only — coding-agent has no equivalent RPC round-trip inside a tool call.

    **Why:** MCP clients in a browser need the fetch credential + OAuth context, which is host-owned; sending the live client across `postMessage` would require serialising functions.

### 3.6 Interactive UX: pi-tui TUI vs React host

- **coding-agent** ships three run modes — `InteractiveMode` (pi-tui TUI with model selector, theme picker, slash commands, extension widgets), `runPrintMode` (one-shot stdout), `runRpcMode` (embed-in-another-app). The TUI is the primary UX.
- **web-agent** has no shipped TUI and no print mode. The worker-agent library *is* the RPC surface; rendering is up to the host. The reference React app (`packages/web-agent/src/`) is one host; `@bodhiapp/bodhi-web-agent` consumers could build their own.

### 3.7 AgentSession sizing

- **coding-agent** `AgentSession` is the centre of gravity — scoped models, thinking level cycling, steering/follow-up queues, bash queue, retry/overflow recovery, extension lifecycle, tool registry, system-prompt composition, skill parsing, `navigateTree`, `fork`, branch summarisation, session-stats.
- **web-agent** `AgentSession` deliberately stays tiny (plain-data surface only); all orchestration moves to `WorkerAgentHost`. This is because the Worker boundary already forces a clean "plain data ↔ non-serialisable state" split, so `AgentSession` exposes only what the RPC server needs and `WorkerAgentHost` does the wiring.

## 4. Features in coding-agent missing from web-agent

Loosely ordered by how likely each is to land in web-agent.

### 4.1 Likely future ports

| Feature | coding-agent surface | web-agent status |
| --- | --- | --- |
| **Thinking level** (`off` / `minimal` / `low` / `medium` / `high` / `xhigh`) | `set_thinking_level`, `cycle_thinking_level`, `ThinkingLevelChangeEntry` persistence | Entry type is ported; runtime is not. No `thinkingLevel` on `RpcSessionState`. |
| **Steering / follow-up queues** (queue messages mid-stream with `all` or `one-at-a-time` modes) | `set_steering_mode`, `set_follow_up_mode`, `steer`, `follow_up`, `queue_update` event | Not implemented. `prompt` is serial — sending a second `prompt` mid-stream is rejected. |
| **Auto-compaction toggle** | `set_auto_compaction { enabled }`, `autoCompactionEnabled` on state | Threshold-driven auto compaction is always on; no runtime toggle. |
| **Auto-retry on provider error** | `set_auto_retry`, `abort_retry`, `auto_retry_start` / `auto_retry_end` events, overflow-recovery loop | Not implemented; errors surface as `errorMessage` and stop. |
| **Scoped models + cycleModel** (`--models a,b,c` cycles with Ctrl+P) | `cycle_model` command, `ModelCycleResult`, scoped vs global cycle | Not implemented — single `set_model` only. |
| **Branch-summary generation on tree navigation** | `navigateTree` collects old-branch entries, summarises, writes `BranchSummaryEntry` | `navigate_to_leaf` exists but does **not** summarise or write a `BranchSummaryEntry`. Entry type is ported for forward compat. |
| **Labels** (`LabelEntry`, user bookmarks on entries) | Read/write labels, expose in tree UI | Entry type ported; no runtime or RPC. |
| **Session stats** (`get_session_stats` — message/tool/token/cost counts, `contextUsage`) | `SessionStats`, `ContextUsage`, `getLastAssistantUsage` | Not exposed. |
| **Export HTML** | `export_html { outputPath }` renders the session to a standalone HTML file | Not implemented. |

### 4.2 Unlikely to port (runtime mismatch)

| Feature | Why web-agent doesn't have it |
| --- | --- |
| **Bash tool + bash executor** (`bashTool`, `bash`, `abort_bash`, `BashExecutionMessage`, `BashSpawnHook`) | No `child_process` in a browser worker. The web-agent's "shell" is the set of MCP tools the host proxies. |
| **Extension runtime** (full `ExtensionRunner`, `ExtensionRuntime`, command registration, slash-commands, keybindings, widgets, `pi-tui` editors) | Depends on `jiti` + dynamic `require` + TUI primitives. Only the **types** are ported under `worker-agent/core/extensions/types.ts` as scaffolding; no runtime yet. The eventual browser extension host will need its own sandboxing story (separate milestone per `CLAUDE.md`). |
| **Slash commands, skills, prompt templates** (`slash-commands.ts`, `skills.ts`, `prompt-templates.ts`, `/` loading from disk) | File-system driven — coding-agent loads `.md` skill files, `<file>` prompt templates, project context files from disk. A browser equivalent would need vault-sourced loading + a UI for invocation. |
| **Settings manager** (theme, package sources, retry settings, image settings persisted to `~/.pi/settings.json`) | No disk; web-agent settings live in React state / `localStorage` at the host. |
| **OAuth credential flows + `AuthStorage`** (file-backed rotating credentials, `OAuthCredential`, built-in Anthropic / Google / Codex flows) | Browser OAuth is host-owned (popup redirect + cookie / PKCE flows on the main thread). Worker just receives rotated credentials through `set_auth_token`. |
| **`ModelRegistry`** (JSON-defined providers/models, `~/.pi/providers.json`, schema validation, custom OAuth provider registration) | Replaced by the `LlmProvider` seam — the concrete provider decides what the catalog is. Bodhi's impl is the "registry" for web-agent. |
| **Interactive TUI** (`InteractiveMode`, `ModelSelectorComponent`, `SessionSelectorComponent`, theme engine, footer provider, keybindings) | pi-tui is Node-only. The web-agent host renders React; selector components are host code under `packages/web-agent/src/components/`. |
| **Clipboard / shell utilities** (`copyToClipboard`, `getShellConfig`) | No shell to configure; the browser clipboard is host-owned. |
| **Print mode** (`runPrintMode`) | One-shot CLI use-case doesn't apply to a browser runtime. |
| **Package manager abstraction** (`PackageManager`, `DefaultPackageManager`, resource loading from disk) | File-system driven. |

## 5. Features in web-agent missing from coding-agent

### 5.1 Structural / runtime

| Feature | Why it exists in web-agent |
| --- | --- |
| **Worker boot protocol + transport pairs** (`AGENT_WORKER_INIT_TYPE`, `createInProcessTransportPair`, `createWorkerTransportPair`, `agentPort` + `vfsPort` transfer) | Required because main ↔ worker is the transport. Coding-agent has no equivalent — its "transport" is stdout. |
| **ZenFS vault mount + FSA handle forwarding** (`mount_vault { handle }`, `resolveVaultPath`, `VaultPathError`, dev-seed fallback) | Browser filesystem access is opt-in via FSA; the Worker can't open files without a handle forwarded from the main thread. |
| **MCP tool upcall protocol** (`set_mcp_tools`, `tool_call_request` / `tool_call_response` round-trip) | Tool closures can't cross `postMessage`, so the Worker announces descriptors and asks the host to execute. Coding-agent runs MCP clients in-process. |
| **Structured `RpcSessionLoadedEvent` with pre-populated model + messageMeta** | Main thread drives combobox + UI state directly off this envelope — no follow-up `get_state`. Coding-agent's CLI redraws from in-process state; no equivalent event. |
| **In-process transport fallback** (`createInProcessTransportPair` used in tests and `bootInProcess`) | Enables Vitest + Playwright smoke tests without spinning up a real Worker, and a non-Worker fallback for environments that disallow Workers. Coding-agent tests just call `AgentSession` directly. |
| **Dexie-backed session store + memory fallback** (`DexieSessionStore`, `MemorySessionStore`, `WebAgentDB`) | See §3.3. |

### 5.2 Smaller affordances

- `set_system_prompt` as a first-class RPC (coding-agent composes the system prompt internally from resources).
- `new_session` response returns the `sessionId` explicitly (web-agent consumers need it to drive URL state).
- `RpcCompactionEvent` with `tokensBefore` telemetry piggy-backed on the end event.
- Error serialisation helper (`rpc/error.ts`) so thrown errors round-trip cleanly across `postMessage` with stack + cause.
- `RpcToolCallRequest` separates "tool that needs main-thread execution" from "tool executed in-worker", which simplifies the MCP story.

## 6. Shared vocabulary

For readers who know one side and are porting to the other, these are the name-level aliases to carry in your head:

| Concept | coding-agent | web-agent |
| --- | --- | --- |
| Central session class | `AgentSession` (`core/agent-session.ts`) | `AgentSession` (`core/agent-session.ts`) + `WorkerAgentHost` (`worker/worker-host.ts`) |
| Session persistence | `SessionManager` (`core/session-manager.ts`) | `SessionManager` + `SessionStore` (`core/session/`) |
| Tree navigation | `navigateTree(targetId, { summarize, label })` | `navigate_to_leaf { entryId }` (no summary yet) |
| Fork | `fork(entryId)` — new file on disk | `fork_session { fromEntryId }` — new row in Dexie |
| Model catalog | `ModelRegistry.getAvailable()` / `getApiKeyAndHeaders()` | `LlmProvider.getAvailableModels()` / `getApiKeyAndHeaders()` |
| Auth rotation | `AuthStorage.set()` on disk | `set_auth_token { credential }` RPC → `LlmProvider.setAuthToken?()` |
| Switch active session | `switch_session { sessionPath }` | `load_session { sessionId }` |
| Compaction trigger | `compact { customInstructions? }` | `compact_now` |
| Context replay on load | `buildSessionContext` | `buildSessionContext` (ported) |
| Extension types | `core/extensions/types.ts` (wired via `ExtensionRunner`) | `core/extensions/types.ts` (scaffolding only) |
| Tool operations | `ReadOperations` etc. (Node `fs`) | same interfaces (ZenFS) |

## 7. Practical guidance

### 7.1 Adding a feature to web-agent

If coding-agent already has it and it is **not runtime-bound** (no `fs`, `child_process`, `jiti`, `pi-tui`):

1. Copy the source into `worker-agent/` — **do not import from coding-agent**.
2. Strip Node-only deps; replace disk IO with `SessionStore` writes or host RPC.
3. Add the RPC command / response / event wire shapes next to the coding-agent ones — keep naming parity where practical.
4. Update the matching spec in `ai-docs/specs/worker-agent/` in the same change (hard rule, see `CLAUDE.md § Functional specs`).
5. Port the tests.

### 7.2 Adding a feature to coding-agent

Treat it as an independent upstream. The "hard rule" is one-directional (web-agent can't import coding-agent); coding-agent never imports from web-agent either, but that is by convention rather than constraint. If the feature should eventually exist on both sides, **name it the same** so the port stays mechanical.

### 7.3 Cross-cutting invariants to preserve

- **Session format compatibility.** Do not mutate any existing `SessionEntry` variant in either harness without bumping `CURRENT_SESSION_VERSION` and writing a migration (coding-agent: `migrateSessionEntries`; web-agent: `dexie-store.ts` version hook).
- **Structured-clone safety (web-agent only).** Every new RPC command / response / event must survive `postMessage` — no functions, no class instances with methods, no live MCP client objects.
- **No coding-agent import in web-agent.** Enforced by convention + `grep` at review time.
- **Spec update in the same change (web-agent only).** Any edit under `worker-agent/` or `worker-bodhi/` updates its matching topic file in `ai-docs/specs/`.

## 8. Open questions / known gaps

- Extension runtime in web-agent: types are ported; the browser-side runtime, sandboxing, and UI surface are a separate future milestone. Until it lands, there is no way to register slash commands, skills, or extension widgets from host code.
- Branch-summary generation on navigate is present in coding-agent but deferred in web-agent — the entry type is already on the wire so the upgrade won't break replay.
- Web-agent has no `get_session_stats` equivalent yet; the main-thread React app computes stats locally from messages + usage.
- Thinking level is persisted through `ThinkingLevelChangeEntry` in the ported types but there is no RPC to set / cycle it. When adding, keep `cycle_thinking_level` naming.

## Change procedure

This document compares the *shape* of both harnesses, not their individual implementations. Update it when:

- A feature listed in §4 (missing from web-agent) is ported — move it out of §4 into §2 (alignment).
- A feature listed in §5 (web-agent only) lands in coding-agent too — same move.
- One of the divergence axes in §3 is changed (e.g. the transport, the session store, the auth seam) — update the relevant row and the "Why" below it.
- A new architectural axis appears that neither §2 nor §3 covers.

Small implementation-level drift (new RPC commands, new session entry variants) only needs an update here if the *architecture* shifted — otherwise it belongs in the per-module spec under `worker-agent/` or `worker-bodhi/`.
