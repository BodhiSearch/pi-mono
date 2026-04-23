# Shared vocabulary and practical guidance

## Shared vocabulary

For readers who know one side and are porting to the other, these are the name-level aliases to carry in your head:

| Concept | coding-agent | web-agent |
| --- | --- | --- |
| Central session class | `AgentSession` (`packages/coding-agent/src/core/agent-session.ts`) | `AgentSession` (`packages/web-agent/src/worker-agent/core/agent-session.ts`) + `WorkerAgentHost` (`packages/web-agent/src/worker-agent/worker/worker-host.ts`) |
| Session persistence | `SessionManager` (`packages/coding-agent/src/core/session-manager.ts`) | `SessionManager` + `SessionStore` (`packages/web-agent/src/worker-agent/core/session/`) |
| Tree navigation | `AgentSession.navigateTree(targetId, { summarize, label })` | `navigate_to_leaf { entryId }` (no summary yet) |
| Fork | `AgentSession.fork(entryId)` — new file on disk | `fork_session { fromEntryId }` — new row in Dexie |
| Model catalog | `ModelRegistry.getAvailable()` / `ModelRegistry.getApiKeyAndHeaders()` | `LlmProvider.getAvailableModels()` / `LlmProvider.getApiKeyAndHeaders()` |
| Auth rotation | `AuthStorage.set()` on disk | `set_auth_token { credential }` RPC → `LlmProvider.setAuthToken?()` |
| Switch active session | `switch_session { sessionPath }` | `load_session { sessionId }` |
| Compaction trigger | `compact { customInstructions? }` | `compact_now` |
| Context replay on load | `buildSessionContext` | `buildSessionContext` (ported) |
| Extension runtime | `core/extensions/types.ts` (wired via `ExtensionRunner` + TUI) | `core/extensions/{types,loader,runner,wrapper,session-forwarder}.ts` + `worker/extension-host.ts` + `worker/extension-ui-controller.ts` + `worker/extension-provider-controller.ts` + `worker/extension-skill-controller.ts` + `ExtensionsPanel` / `ExtensionUIRenderer` / `ExtensionTitleSlot` / `ExtensionWidgetSlot` / `ExtensionStatusChips` + `ExtensionStore` + `useExtensionUI`. Phases 1 + 2a + 2b: full hook surface (`before_agent_start`, `tool_result`, `context`, `tool_call`, `turn_start`, `message_end`, `session_loaded` with `mount \| reload \| switch \| fork \| new \| navigate`, `before_compact`, `after_compact`), full registration surface (`registerTool`, `registerCommand`, `registerProvider`, `registerSkill`), full `pi.ui.*` channel (`notify`, `setStatus`, `setTitle`, `setWidget`, `editor`, `setEditorText`, `select`, `confirm`, `input`), and read-only `ctx.session` via `ReadonlySessionForwarder`. |
| Tool operations | `ReadOperations` etc. (Node `fs`) | same interfaces (ZenFS) |
| Slash-command registry | in-process property on `AgentSession` | `CommandRegistry` (`core/commands/registry.ts`) exposed via `list_commands` RPC |
| Prompt template loader | `prompt-templates.ts` (user + project + CLI) | `prompt-templates.ts` (vault-only: `<vaultMount>/.pi/prompts/`) |
| Skill loader | `skills.ts` + `skill.ts` (user + project + CLI) | `skills.ts` (vault-only: `<vaultMount>/.pi/skills/`) |
| System prompt assembly | `system-prompt.ts` (cwd + skills + tool snippets + extensions) | `core/system-prompt.ts` (cwd + skills only; built by `WorkerAgentHost`; Phase 1 extensions additionally override `systemPrompt` per turn via `before_agent_start`) |
| Skill script execution | `bash` tool → Node `child_process` | restricted `bash` shim → `SandboxHost` → sandbox iframe + Worker (`packages/web-agent/src/sandbox/`) |

## Practical guidance

### Adding a feature to web-agent

If coding-agent already has it and it is **not runtime-bound** (no `fs`, `child_process`, `jiti`, `pi-tui`):

1. Copy the source into `worker-agent/` — **do not import from coding-agent**.
2. Strip Node-only deps; replace disk IO with `SessionStore` writes or host RPC.
3. Add the RPC command / response / event wire shapes next to the coding-agent ones — keep naming parity where practical.
4. Update the matching spec in `ai-docs/specs/worker-agent/` in the same change (hard rule, see `CLAUDE.md § Functional specs`).
5. Port the tests.

### Adding a feature to coding-agent

Treat it as an independent upstream. The "hard rule" is one-directional (web-agent can't import coding-agent); coding-agent never imports from web-agent either, but that is by convention rather than constraint. If the feature should eventually exist on both sides, **name it the same** so the port stays mechanical.

## Cross-cutting invariants to preserve

- **Session format compatibility.** Do not mutate any existing `SessionEntry` variant in either harness without bumping `CURRENT_SESSION_VERSION` and writing a migration (coding-agent: `migrateSessionEntries`; web-agent: `dexie-store.ts` version hook).
- **Structured-clone safety (web-agent only).** Every new RPC command / response / event must survive `postMessage` — no functions, no class instances with methods, no live MCP client objects.
- **No coding-agent import in web-agent.** Enforced by convention + `grep` at review time.
- **Spec update in the same change (web-agent only).** Any edit under `worker-agent/` or `worker-bodhi/` updates its matching topic file in `ai-docs/specs/`.

## Open questions / known gaps

- **Extension runtime in web-agent.** Phases 1 + 2a + 2b landed — `.pi/extensions/<name>/index.js` is discovered, Blob-URL imported inside the Worker, and the surface now matches the coding-agent feature envelope apart from the isolation model: full hook set (including `before_compact` / `after_compact`), full registration surface (`registerTool` / `registerCommand` / `registerProvider` / `registerSkill`), full `pi.ui.*` channel (including `setTitle`, `setWidget` with closed `progress | info | choice` kinds, modal `editor`, and `setEditorText`), read-only `ctx.session` forwarder, and `session_loaded` with the six-value `mount | reload | switch | fork | new | navigate` discriminator. `extension_providers_changed` is emitted on provider churn. **Deferred to Phase 3:** TypeScript sources, bare-specifier imports, iframe / Worker-per-extension isolation, the keybinding hook, and the marketplace story. See [`../worker-agent/extensions.md`](../worker-agent/extensions.md) and [`../../extension-impl/phase-2b-report.md`](../../extension-impl/phase-2b-report.md).
- **Branch-summary generation on navigate** is present in coding-agent but deferred in web-agent — the entry type is already on the wire so the upgrade won't break replay.
- **Session stats**. Web-agent has no `get_session_stats` equivalent yet; the main-thread React app computes stats locally from messages + usage.
- **Thinking level** is persisted through `ThinkingLevelChangeEntry` in the ported types but there is no RPC to set / cycle it. When adding, keep `cycle_thinking_level` naming.
- **Multimodal input.** coding-agent's `prompt` accepts `ImageContent[]`; web-agent's `prompt` is text-only. Extending the RPC needs a structured-clone-safe representation for images.
- **Auto-retry / overflow recovery.** coding-agent has a full retry loop with `auto_retry_start` / `auto_retry_end` events and an `abort_retry` command; web-agent currently surfaces errors via `errorMessage` and stops.
