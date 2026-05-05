# M6 — Extensions

**Status:** planned. **First priority** after M5 extraction + compliance
digest.

**Host scope.** Agent-primary. A `web-acp` host addendum lands in
this same file (§ "Browser host addendum") rather than as a sibling
file; the host work is small enough to inline.

## ACP compliance header

**Posture.** Fully ACP-canonical on the wire. Extensions are an
**agent-side** concern — they register tools, lifecycle hooks,
commands, templates, skills, and custom providers inside the
agent. The ACP client is not aware that a tool came from an
extension vs. being built-in; all tools ride the same
`session/update (tool_call)` surface.

No new ACP methods are required in the default path. An extension
that wants to participate in a lifecycle event the ACP spec
doesn't already define uses a `_bodhi/*` extension method per
principle § 15.

## What this milestone delivers

A third party can drop a JavaScript module into
`<mount>/.pi/extensions/<name>/` and, on next session boot, have
it extend the agent:

- Register additional LLM-facing tools alongside `bash` and MCP
  tools.
- Hook into session lifecycle (`session_loaded`, `turn_start`,
  `turn_end`, `tool_call_pre`, `tool_call_post`).
- Register slash commands / prompt templates / skills from code
  (augmenting the vault-sourced set from M4 and M7).
- Register custom model providers with `pi-ai` at startup.

**Trust model: fully trusted**, unchanged from web-agent's Phase 3
decision. Installing an extension means the user put it in the
vault. Rationale at
`ai-docs/web-agent/milestones/deferred.md` § Extension sandboxing.

## Why extensions before fork / compaction / permission bridge

- **Session fork (M8)** inherits extension state per branch — the
  extension runtime must exist so the fork story has a clear
  piece of state to copy.
- **Compaction (M9)** is a hook surface — extensions want
  `before_compact` / `after_compact` to edit or tag summaries.
- **Permission bridge (M10)** shares a code path with extension
  tool-call pre-hooks (`tool_call_pre`). Landing extensions
  first means the permission bridge plugs into a stable hook
  registry rather than inventing one.

Inverting any of these orderings means re-shaping the extension
runtime once the dependent milestone churns its state model.

## Depends on

- **M1** — session persistence; extension activation state
  persists on the session row.
- **M2** — agent-owned filesystem; extensions read their own
  files via the agent's `IFileSystem`, share it with `bash`.
- **M3** — unified tool registry (`bash` + MCP, both addressed by
  name through `InlineAgent.setModel({ tools })`);
  extension-registered tools slot into the same registry.
- **M4** — vault commands + built-ins pipeline; extension
  commands merge into the same advertised list.
- **M5** — engine split + agent-package extraction. The
  extension API targets `AcpSessionRuntime` + `PromptTurnDriver`
  + the ext-method host bag, not the adapter class.

## ACP surface touched

- Extension-registered tools appear on the normal ACP tool
  surface (`session/update (tool_call)`). The client does not
  know they came from an extension; they look like first-party
  tools.
- Extension-registered commands / templates / skills merge into
  the `available_commands_update` notification alongside vault
  and built-in entries. `AvailableCommand` wire shape is
  unchanged.
- Custom providers — extension registers a model adapter with
  the agent's `LlmProvider` registry (not pi-ai directly,
  because pi-ai is an implementation detail behind `LlmProvider`
  now). Catalog rebuild on auth triggers a re-listing that
  includes extension-contributed models. No new client-side ACP
  surface.
- Lifecycle hooks run **inside the agent**. Some hooks
  (`before_compact` / `after_compact` — see M9) may need an
  ACP-visible notification if an extension wants to edit the
  transcript client-side; that specific affordance is decided at
  M9 unless it blocks M6.
- `_bodhi/extensions/list` (agent → client, new). Lists loaded
  extensions with `{ name, version, displayName, author?,
  capabilities: { tools, commands, skills, providers, hooks } }`
  so the host can render an Extensions panel. Principle § 15.
- `_bodhi/extensions/reload` (client → agent, new). Takes
  `{ mountName? }` (or no args for "reload everything"). Re-reads
  the vault, diffs active vs. discovered, calls
  `deactivate` + `activate` as needed. Useful for a dev loop
  that edits an extension and wants the agent to pick it up
  without `session/new`.

## Extension loading

- Extensions live at `<mount>/.pi/extensions/<name>/index.js` plus
  an optional `<mount>/.pi/extensions/<name>/manifest.json`
  declaring permissions-sensitive metadata (display name, author,
  intended hooks, declared tool names).
- The worker reads extension files via the agent's
  `commandsFs` / `IFileSystem` at session boot, then
  dynamic-`import`s each extension from a blob URL — same
  pattern as the frozen `web-agent` Phase 3 implementation at
  `packages/web-agent/src/extensions/loader.ts` (cross-read only;
  not imported per CLAUDE.md hard constraints).
- Load order: lexicographic by path. First-wins on command /
  tool / skill name conflict, with a structured error logged for
  the loser. Mount boundaries are **not** a tiebreaker — a
  user mounting two vaults with overlapping extension names must
  resolve the collision themselves (rename the folder).
- Extensions run inside the worker — same thread / same VM as
  the agent. A misbehaving extension can take the agent down.
  This is the cost of the fully-trusted posture; principle § 9.

## Extension API (starting shape — plan-time locked)

```ts
// @bodhiapp/web-acp-agent exports this type so extension authors
// can import it directly. Subject to API iteration during M6
// phase A; frozen at M11 publish time.
export interface WebAcpExtension {
  name: string;
  version: string;
  activate(ctx: ExtensionContext): Promise<void> | void;
  deactivate?(ctx: ExtensionContext): Promise<void> | void;
}

export interface ExtensionContext {
  registerTool(tool: AgentTool<TSchema>): Disposable;
  registerCommand(cmd: CommandDef): Disposable;
  registerSkill(skill: SkillDef): Disposable;     // requires M7
  registerPromptTemplate(t: CommandDef): Disposable;
  registerProvider(provider: LlmProvider): Disposable;
  on<E extends keyof LifecycleEvents>(
    event: E,
    handler: LifecycleEvents[E]
  ): Disposable;
  fs: IFileSystem;     // same MountableFs the bash tool sees
  emit(update: SessionNotification): Promise<void>;
  // Session-scoped state helpers — persisted through PreferenceStore
  // under a namespaced key so extensions get cheap persistence
  // without owning a Dexie store.
  readState<T>(sessionId: string, key: string): Promise<T | undefined>;
  writeState<T>(sessionId: string, key: string, value: T): Promise<void>;
}

export interface LifecycleEvents {
  session_loaded: (sessionId: string) => void | Promise<void>;
  turn_start: (sessionId: string, prompt: string) => void | Promise<void>;
  turn_end: (sessionId: string, stopReason: StopReason) => void | Promise<void>;
  tool_call_pre: (
    sessionId: string,
    call: { toolCallId: string; toolName: string; args: unknown }
  ) => void | Promise<void>;
  tool_call_post: (
    sessionId: string,
    call: { toolCallId: string; toolName: string; result: unknown }
  ) => void | Promise<void>;
}
```

The shape is a starting point for M6 phase A. The extraction
milestone (M11) re-asserts the surface as part of the npm
publish story; any shape change between M6 phase A exit and M11
lands as an additive migration.

## Sub-milestones

M6 ships in three phases. Each is independently gate-checkable
(`npm run check` + matching e2e green) and each is allowed to
land as a separate PR.

### M6.1 — Extension runtime + discovery + tool contribution

Deliverables:

- `agent/extensions/` subtree in `packages/web-acp-agent/src/`
  with:
  - `loader.ts` — vault scan + blob-URL dynamic import +
    manifest parse.
  - `registry.ts` — tracks active `WebAcpExtension`
    instances + disposables.
  - `context.ts` — `ExtensionContext` construction per
    extension activation.
  - `events.ts` — `LifecycleEvents` bus wired into
    `AcpSessionRuntime` hooks (`session_loaded`,
    `turn_start`, `turn_end`, `tool_call_pre`,
    `tool_call_post`).
- `session-runtime.ts` gains an `onSessionLoaded(sessionId)`
  entry point that calls `extensions.handleSessionLoaded`
  before command refresh so the extension can pre-register
  its contributions for that session.
- `prompt-driver.ts` fires `turn_start` / `turn_end` /
  `tool_call_*` against the extension bus. Extension
  handlers run sequentially in registration order; a thrown
  handler logs and does not block the turn (principle § 9).
- `_bodhi/extensions/list` handler under
  `acp/engine/ext-methods/extensions-list.ts`.
- `_bodhi/extensions/reload` handler under
  `acp/engine/ext-methods/extensions-reload.ts`.
- Initial tool-contribution path:
  `ExtensionContext.registerTool(tool)` registers through
  `AgentSessionRegistry` so the next turn's
  `InlineAgent.setModel({ tools })` picks it up. Extension
  tools are namespaced `<extName>__<toolName>` the same way
  MCP tools use `<serverName>__<toolName>`.

**Depends on:** M5 engine split (plugs into
`AcpSessionRuntime` + `PromptTurnDriver`).

**Gate items:**

- Unit: vault-mounted `demo-ext/index.js` with an `activate`
  that registers a `demo__ping` tool. After `session/new`,
  `_bodhi/extensions/list` shows the extension; a prompt
  invoking `demo__ping` round-trips.
- Unit: failing extension (`activate` throws) is skipped; the
  rest of the vault's extensions still load; an error is
  logged.
- Real-LLM e2e: seed a volume with a `/mnt/<name>/.pi/extensions/wc/`
  extension that registers a `wc__lines` tool; prompt
  "Use the wc__lines tool on this text: ...", assert the
  tool-call bubble reaches `completed` with the expected
  `exitCode: 0` in `rawOutput`.

### M6.2 — Commands / templates / provider contribution + reload

Deliverables:

- `ExtensionContext.registerCommand` and
  `.registerPromptTemplate` merge into the existing
  `AcpSessionRuntime.refreshAvailableCommands` path.
  Extension entries come after vault entries and before
  built-ins (principle § 11 — built-ins win).
- `ExtensionContext.registerProvider(provider: LlmProvider)`
  registers additional providers with the agent's provider
  registry. On `authenticate`, every registered provider's
  `setAuthToken` is called with credentials matching its
  declared provider tag; `ensureModelsLoaded` merges results.
- `_bodhi/extensions/reload` cycles `deactivate` +
  `activate` for the requested mount (or all mounts),
  re-invokes `refreshAvailableCommands` and `setModels`
  downstream, and emits a synthetic `available_commands_update`.
- Extension-contributed skills land in M7 (skills are a
  product feature that M6 depends on but doesn't ship
  itself — the hook exists but `SkillDef` is a placeholder
  type until M7).

**Depends on:** M6.1.

**Gate items:**

- Unit: `registerCommand` contributes `/lint-notes`; picker
  advertises it; `/lint-notes` prompt expands into the
  extension-provided template body.
- Unit: `registerProvider` contributes an Echo provider
  whose `getAvailableModels` returns `echo-1`. Catalog
  contains `echo-1`; `unstable_setSessionModel({ modelId:
  'echo-1' })` selects it.
- Unit: `_bodhi/extensions/reload` mutation: edit the
  extension file in the seed vault; call reload; the new
  command shape is advertised without `session/new`.

### M6.3 — Host-side affordances + Extensions panel + exit gate

See § "Browser host addendum" below. Gate items consolidate
the agent-side unit + integration tests from M6.1 + M6.2 plus
the host-side Extensions panel + reload affordance.

## Browser host addendum (`packages/web-acp/`)

**Scope.** Small. Three pieces:

1. **`useAcpExtensions` slice hook** under `src/hooks/` that
   calls `_bodhi/extensions/list` on `session_loaded` and
   `_bodhi/extensions/reload` on user-triggered reload. Read
   state surfaces through the existing `panelsReducer` (new
   arm: `extensions_update`).
2. **Extensions panel component** at
   `src/components/extensions/ExtensionsPanel.tsx`. Lists
   active extensions with name, version, author, declared
   capabilities (tools, commands, skills, providers, hook
   count). Per-row `[reload]` button invokes the reload
   extension method for that mount. `data-testid="extension-row-<name>"`
   + `data-test-state="active|failed"` hooks for Playwright.
3. **Settings-page integration.** The Extensions panel drops
   into the existing settings page alongside MCP + Volumes +
   Feature toggles. No new route.

**Host hard constraints.** Reuses the existing reducer + hook
pattern; no new runtime surface. The extension discovery
boundary stays agent-side; the host renders what `_bodhi/extensions/list`
says and does not re-scan the vault.

**Not in scope for M6 browser host work.**

- Visual capability editor (pick tools / hooks / providers
  from a form UI). Read-only list in v1.
- Marketplace / install button. Users drop files into the
  vault manually.
- Toast notifications for per-extension activation errors.
  Surfaces inline in the panel row; console error kept.

## Out of scope (M6 milestone-wide)

- Third-party marketplace / discovery / updater. Manual
  install only.
- Sandboxed execution / manifest permission system. Fully
  trusted, period.
- Backwards-compatible loading of frozen `web-agent` extensions.
  Different runtime shape. Extension authors re-port; we do
  not maintain compatibility shims.
- Multi-extension dependency resolution beyond "load in
  lexicographic order, first-wins on name conflict".
- Extension-provided UI widgets beyond what `tool_call`
  permission prompts already support. Custom extension UI is
  post-v1.
- Extension-contributed skills manifest shape (lands with
  M7 skills).
- Extension-contributed compaction hook payload shape
  (`before_compact` / `after_compact`) (lands with M9
  compaction).

## Risks

- **ACP extensibility gap.** Extensions are the most likely
  milestone to expose a real gap in ACP's extensibility story.
  If the plan finds that ACP simply cannot carry our extension
  model without a sibling protocol, that is a product decision
  — escalate at the milestone kickoff.
- **Blob-URL import compatibility.** Some Workers / CSP
  configurations may block `blob:` URLs. Fallback path
  (inline `importScripts` or text-eval) is an implementation
  risk the plan tracks explicitly — not a scope change.
- **Extension-as-attack-vector.** Fully-trusted posture means
  a malicious extension can exfiltrate vault contents, leak
  tokens, or send LLM traffic anywhere. Documented in the user
  setup guide at M6 exit; not addressed by additional gating.

## Cross-references

- Frozen-archive reference:
  [`../../web-agent/milestones/`](../../web-agent/milestones/)
  — the spike's Phase 3 extension work is pattern reference
  (not imported).
- Principle § 9 (pluggable interfaces) + § 15 (extension
  method naming):
  [`../steering/04-principles.md`](../steering/04-principles.md).
- Deferred items whose reshape intersects M6:
  [`deferred.md`](deferred.md) — nothing blocks M6; M10
  (permission bridge) reuses `tool_call_pre` so its own
  plan references this file.
- Engine split this milestone plugs into:
  [`m5-extraction-and-compliance.md`](m5-extraction-and-compliance.md).
