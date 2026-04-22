# Feature gaps

Symmetric tour of features that exist on one side only.

## Features in coding-agent missing from web-agent

Loosely ordered by how likely each is to land in web-agent.

### Likely future ports

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
| **Fork helpers** (`get_fork_messages`, `get_last_assistant_text`) | Introspection for the TUI's fork picker | Not implemented. |
| **Slash-command discovery** (`get_commands` → `RpcSlashCommand[]` with `source: extension|prompt|skill` and `sourceInfo`) | Enumerates registered extension / prompt / skill commands for the UI | Ported — `list_commands` RPC returns `SlashCommandInfo[]` with `source: 'builtin' \| 'prompt' \| 'skill' \| 'extension'`. `sourceInfo` is still not emitted. See [`alignment.md § Slash commands`](./alignment.md#slash-commands-prompt-templates-skills) and [`../worker-agent/extensions.md`](../worker-agent/extensions.md). |
| **Prompt images** (`ImageContent[]` on `prompt` / `steer` / `follow_up`) | Multimodal turn input | `prompt` takes a string only. |
| **Export HTML** | `export_html { outputPath }` renders the session to a standalone HTML file | Not implemented. |
| **Extension UI request / response channel** (`extension_ui_request` / `extension_ui_response` — select, confirm, input, editor, notify, setStatus, setWidget, setTitle, set_editor_text) | Back-channel for extensions to prompt the TUI | Phase 2a landed the modal subset: `notify` → sonner toast, `setStatus` → chip in `ChatInput` footer, `select` / `confirm` / `input` → `ExtensionUIRenderer` modal queue. `setWidget`, `setTitle`, `editor` / `set_editor_text` stay deferred to Phase 2b (see [`../worker-agent/extensions.md`](../worker-agent/extensions.md)). |

### Unlikely to port (runtime mismatch)

| Feature | Why web-agent doesn't have it |
| --- | --- |
| **Full bash executor** (`bashTool`, arbitrary shell, `abort_bash`, `BashExecutionMessage`, `BashSpawnHook`) | No `child_process` in a browser worker. Web-agent does ship a narrowly-scoped `bash` shim (`packages/web-agent/src/sandbox/bash-skill.ts`) that **only** accepts `node <path>.js` / `./<path>.js` invocations rooted at `<vault>/.pi/skills/` and runs them in an iframe + Worker sandbox — see [`divergence.md § Skill execution`](./divergence.md#skill-execution-local-bash-vs-sandboxed-iframe--worker). There is no PTY, no pipelines, no subprocess host. |
| **Extension runtime** (full `ExtensionRunner`, `ExtensionRuntime`, command registration, slash-commands, keybindings, widgets, `pi-tui` editors) | Phases 1 + 2a landed — `packages/web-agent/src/worker-agent/core/extensions/` ships a browser-native runner covering `before_agent_start`, `tool_result`, `context`, `tool_call`, `turn_start`, `message_end`, `session_loaded` (reload-only) hooks, `registerTool`, `registerCommand`, and a modal `pi.ui.*` channel (`notify`, `setStatus`, `select`, `confirm`, `input`). Everything loads via Blob-URL dynamic `import()` inside the Worker (see [`../worker-agent/extensions.md`](../worker-agent/extensions.md)). Widgets, editor, `setTitle`, `registerProvider`, `registerSkill`, session-manager access, compaction hooks, keybindings, `pi-tui` editors, and iframe-isolated extensions remain deferred (Phase 2b / Phase 3). |
| **Multi-tier skill/prompt discovery** (`~/.pi/agent/`, settings `skills` array, `--skill` CLI paths) | Coding-agent walks the user directory, project, and CLI flags. Web-agent's loader is vault-scoped only — see [`alignment.md § Slash commands, prompt templates, skills`](./alignment.md#slash-commands-prompt-templates-skills). User-level + CLI tiers are intentionally out of scope until an extension host can register them. |
| **Settings manager** (theme, package sources, retry settings, image settings persisted to `~/.pi/settings.json`) | No disk; web-agent settings live in React state / `localStorage` at the host. |
| **OAuth credential flows + `AuthStorage`** (file-backed rotating credentials, `OAuthCredential`, built-in Anthropic / Google / Codex flows) | Browser OAuth is host-owned (popup redirect + cookie / PKCE flows on the main thread). Worker just receives rotated credentials through `set_auth_token`. |
| **`ModelRegistry`** (JSON-defined providers/models, `~/.pi/providers.json`, schema validation, custom OAuth provider registration) | Replaced by the `LlmProvider` seam — the concrete provider decides what the catalog is. Bodhi's impl is the "registry" for web-agent. |
| **Interactive TUI** (`InteractiveMode`, `ModelSelectorComponent`, `SessionSelectorComponent`, theme engine, footer provider, keybindings) | pi-tui is Node-only. The web-agent host renders React; selector components are host code under `packages/web-agent/src/components/`. |
| **Clipboard / shell utilities** (`copyToClipboard`, `getShellConfig`) | No shell to configure; the browser clipboard is host-owned. |
| **Print mode** (`runPrintMode`) | One-shot CLI use-case doesn't apply to a browser runtime. |
| **Package manager abstraction** (`PackageManager`, `DefaultPackageManager`, resource loading from disk) | File-system driven. |

## Features in web-agent missing from coding-agent

### Structural / runtime

| Feature | Why it exists in web-agent |
| --- | --- |
| **Worker boot protocol + transport pairs** (`AGENT_WORKER_INIT_TYPE`, `createInProcessTransportPair`, `createWorkerTransportPair`, `agentPort` + `vfsPort` transfer) | Required because main ↔ worker is the transport. Coding-agent has no equivalent — its "transport" is stdout. |
| **ZenFS vault mount + FSA handle forwarding** (`mount_vault { handle }`, `resolveVaultPath`, `VaultPathError`, dev-seed fallback) | Browser filesystem access is opt-in via FSA; the Worker can't open files without a handle forwarded from the main thread. |
| **MCP tool upcall protocol** (`set_mcp_tools`, `tool_call_request` / `tool_call_response` round-trip) | Tool closures can't cross `postMessage`, so the Worker announces descriptors and asks the host to execute. Coding-agent runs MCP clients in-process. |
| **Structured `RpcSessionLoadedEvent` with pre-populated model + `messageMeta`** | Main thread drives combobox + UI state directly off this envelope — no follow-up `get_state`. Coding-agent's CLI redraws from in-process state; no equivalent event. |
| **In-process transport fallback** (`createInProcessTransportPair` used in tests and `bootInProcess`) | Enables Vitest + Playwright smoke tests without spinning up a real Worker, and a non-Worker fallback for environments that disallow Workers. Coding-agent tests just call `AgentSession` directly. |
| **Dexie-backed session store + memory fallback** (`DexieSessionStore`, `MemorySessionStore`, `WebAgentDB`) | See `divergence.md § Sessions`. |

### Smaller affordances

- `set_system_prompt` as a first-class RPC (coding-agent composes the system prompt internally from resources).
- `new_session` response returns the `sessionId` explicitly (web-agent consumers need it to drive URL state).
- `RpcCompactionEvent` with `tokensBefore` telemetry piggy-backed on the end event.
- Error serialisation helper (`packages/web-agent/src/worker-agent/rpc/error.ts`) so thrown errors round-trip cleanly across `postMessage` with stack + cause.
- `RpcToolCallRequest` separates "tool that needs main-thread execution" from "tool executed in-worker", which simplifies the MCP story.
- `delete_session` / `get_session_meta` — explicit row-level ops for the IndexedDB store.
