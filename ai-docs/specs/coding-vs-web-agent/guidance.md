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
| Extension types | `core/extensions/types.ts` (wired via `ExtensionRunner`) | `core/extensions/types.ts` (scaffolding only) |
| Tool operations | `ReadOperations` etc. (Node `fs`) | same interfaces (ZenFS) |

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

- **Extension runtime in web-agent.** Types are ported; the browser-side runtime, sandboxing, and UI surface are a separate future milestone. Until it lands, there is no way to register slash commands, skills, or extension widgets from host code, and no `extension_ui_request` / `extension_ui_response` channel exists on the wire.
- **Branch-summary generation on navigate** is present in coding-agent but deferred in web-agent — the entry type is already on the wire so the upgrade won't break replay.
- **Session stats**. Web-agent has no `get_session_stats` equivalent yet; the main-thread React app computes stats locally from messages + usage.
- **Thinking level** is persisted through `ThinkingLevelChangeEntry` in the ported types but there is no RPC to set / cycle it. When adding, keep `cycle_thinking_level` naming.
- **Multimodal input.** coding-agent's `prompt` accepts `ImageContent[]`; web-agent's `prompt` is text-only. Extending the RPC needs a structured-clone-safe representation for images.
- **Auto-retry / overflow recovery.** coding-agent has a full retry loop with `auto_retry_start` / `auto_retry_end` events and an `abort_retry` command; web-agent currently surfaces errors via `errorMessage` and stops.
