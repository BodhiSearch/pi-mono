# M5 — Extensions

## ACP compliance header

**Posture.** Fully ACP-canonical on the wire. Extensions are an
**agent-side** concern — they register tools, lifecycle hooks,
commands, templates, skills, and custom providers inside the
agent. The ACP client is not aware that a tool came from an
extension vs. being built-in; all tools ride the same
`session/update (tool_call)` surface.

No new ACP methods are required in the default path. An extension
that wants to participate in a lifecycle event the ACP spec
doesn't already define (e.g. compaction hooks) uses a `_bodhi/*`
extension method per principle 15.

## What this milestone delivers

A third party can drop a JavaScript module into
`/vault/.bodhi/extensions/<name>/` and, on next session, have it
extend the agent:

- Register additional LLM-facing tools alongside `bash` and MCP
  tools.
- Hook into session lifecycle (`session_loaded`, `turn_start`,
  `turn_end`, `tool_call_pre`, `tool_call_post`).
- Register slash commands / prompt templates / skills from code
  (augmenting the vault-sourced set from M4).
- Register custom model providers with `pi-ai` at startup.

Trust model: **fully trusted**, unchanged from web-agent's Phase 3
decision. Installing an extension means the user put it in the
vault. Rationale at `ai-docs/web-agent/milestones/deferred.md` §
Extension sandboxing.

## ACP surface touched

- Extension-registered tools appear on the normal ACP tool
  surface (`session/update (tool_call)` +
  `session/request_permission`). The client does not know they
  came from an extension; they look like first-party tools.
- Custom providers — extension registers a model adapter with
  `pi-ai` at agent startup. No client-side ACP surface; the new
  provider's models show up in the existing
  `bodhi/listModels` catalog.
- Lifecycle hooks run inside the agent. Some hooks
  (`before_compact`, `after_compact` — see M7) eventually need an
  ACP-visible notification if an extension wants to edit the
  transcript client-side; that specific affordance is deferred to
  M7 unless it blocks M5.

## Extension loading

- Extensions live at `/vault/.bodhi/extensions/<name>/index.js`
  plus an optional `manifest.json` declaring permissions-sensitive
  metadata (display name, author, intended hooks).
- The worker reads extension files via the agent's
  `IFileSystem` at session boot, then dynamic-`import`s each
  extension from a blob URL (same pattern as web-agent).
- Load order: lexicographic. First-wins on tool name conflict
  with a structured error logged for the loser.
- Extensions run inside the worker — same thread / same VM as the
  agent. A misbehaving extension can take the agent down. This is
  the cost of the fully-trusted posture.

## Extension API (starting shape — plan-time locked)

```ts
export interface WebAcpExtension {
  name: string;
  version: string;
  activate(ctx: ExtensionContext): Promise<void> | void;
  deactivate?(ctx: ExtensionContext): Promise<void> | void;
}

export interface ExtensionContext {
  registerTool(tool: ToolDescriptor): void;
  registerCommand(cmd: CommandDescriptor): void;
  registerSkill(skill: SkillDescriptor): void;
  registerProvider(provider: LlmProvider): void;
  on<E extends keyof LifecycleEvents>(event: E, handler: LifecycleEvents[E]): Disposable;
  fs: IFileSystem; // same MountableFs the bash tool sees
  emit: (update: SessionNotification) => void;
}
```

The shape is a starting point, not the locked public API — the
extraction milestone (M8) locks it.

## Depends on

- **M1** — session persistence.
- **M2** — the agent-owned filesystem; extensions read their own
  files via `IFileSystem`, share it with `bash`.
- **M3** — the unified tool registry (built-in + MCP + native);
  extension-registered tools slot into the same registry.
- **M4** — commands / templates / skills pipeline;
  extension-registered entries merge into the same list.

## Out of scope

- Third-party marketplace / discovery / updater. Manual install
  only.
- Sandboxed execution / manifest permission system. Fully trusted,
  period.
- Backwards-compatible loading of web-agent extensions. Different
  runtime shape. Extension authors re-port; we do not maintain
  compatibility shims.
- Multi-extension dependency resolution beyond "load in
  lexicographic order, first-wins on name conflict".
- Extension-provided UI widgets beyond what `tool_call` permission
  prompts already support. Custom extension UI is post-v1.

## Why this ordering

Extensions are the **last capability milestone**. They multiply
every preceding surface — a bug in extension lifecycle can corrupt
any prior feature. Landing them after M2+M3+M4 means:

- The tool registry is stable (extensions register into it).
- The command / template / skill pipeline is stable
  (extensions register into it).
- The session lifecycle is stable (extensions hook into it).

Any earlier, extensions would be chasing a moving target.

**Before M6 (session tree) / M7 (compaction)** — but only just.
The fork operation in M6 and the compaction hooks in M7 both
benefit from knowing which extensions are registered. Landing
extensions right before M6 means the fork story has a clear answer
for "what happens to extension state on fork?" (the child branch
re-loads the same extension set; state is per-branch unless the
extension opts into cross-branch persistence via the vault).

Flag: extensions are the most likely milestone to expose a real
gap in ACP's extensibility story. If the plan finds that ACP
simply cannot carry our extension model without a sibling
protocol, that's a product decision — escalate.
