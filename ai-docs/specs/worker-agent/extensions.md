# extensions

**Source of truth:**
`packages/web-agent/src/worker-agent/core/extensions/`,
`packages/web-agent/src/worker-agent/core/commands/registry.ts` (extension source),
`packages/web-agent/src/worker-agent/core/agent-session.ts` (tool-call hooks),
`packages/web-agent/src/worker-agent/worker/extension-host.ts` (extension lifecycle controller),
`packages/web-agent/src/worker-agent/worker/worker-host.ts` (vault lifecycle + RPC plumbing),
`packages/web-agent/src/worker-agent/worker/init-protocol.ts` (boot-time enabled-map plumbing),
`packages/web-agent/src/worker-agent/rpc/rpc-types.ts`,
`packages/web-agent/src/worker-agent/rpc/rpc-server.ts`,
`packages/web-agent/src/worker-agent/rpc/rpc-client.ts`,
`packages/web-agent/src/extension-store/ExtensionStore.ts`,
`packages/web-agent/src/hooks/useExtensionState.ts`,
`packages/web-agent/src/providers/WebAgentProvider.tsx` (pre-boot hydration),
`packages/web-agent/src/components/extensions/ExtensionsPanel.tsx`.

**Parent:** [`./index.md`](./index.md)

## Functional scope

Extensions (M8 — Phase 1) let users drop small JavaScript packages into
`<vaultMount>/.pi/extensions/<name>/index.js` to shape prompts, transform
tool results, register LLM-callable tools, and register slash commands
without modifying the web-agent source. They are the web-agent port of
`packages/coding-agent`'s extension system, adapted to the
Worker-as-source-of-truth architecture.

- **Discovery.** The worker scans `<vaultMount>/.pi/extensions/` on
  every mount, dev-seed, and `/reload`. Each direct subdirectory with
  an `index.js` (optionally alongside `package.json`) is considered an
  extension.
- **Loading.** The worker reads `index.js` from ZenFS, wraps the string
  in a `Blob` with `type: text/javascript`, `URL.createObjectURL`s it,
  and dynamic-`import()`s the blob URL inside the Worker realm. The
  default export is invoked with a fresh `ExtensionAPI` object; the
  factory uses it to register hooks / tools / commands.
- **Lifecycle hooks (Phase 1).**
  - `before_agent_start` — fires after slash-command expansion and
    before the agent's stream starts for a user prompt. Handlers can
    return a new `systemPrompt` to shape what the LLM sees this turn.
  - `tool_result` — fires after a tool executes and before the result
    is committed to the transcript. Handlers can override `content`,
    `details`, and `isError`.
- **LLM-callable tools.** `pi.registerTool(def)` contributes a tool to
  the agent's tool-list for every subsequent turn. The LLM-visible
  triple (`name` / `description` / `parameters`) propagates to the
  main-thread palette; the `execute` closure stays in the Worker.
- **Slash commands.** `pi.registerCommand(name, { handler })` adds a
  command with `source: 'extension'` to `CommandRegistry`. When the
  user types `/<name> …`, the worker dispatches the handler directly
  rather than sending the message to the LLM.
- **Per-extension enable toggle + global disable-all.** The
  `ExtensionsPanel` surfaces every discovered extension with a
  checkbox; the global "Disable all" button satisfies the M8 gate
  (one click must silence every extension without a reload).
- **Error surfacing.** Discovery and factory errors populate
  `ExtensionDescriptor.error`. Hook / command / tool throws surface as
  `ExtensionError` RPC events and render inline in the panel's runtime
  errors block — the agent itself never crashes.

Explicit non-responsibilities:

- **No arbitrary UI API.** There is no `pi.ui.*` surface in Phase 1
  (no notifications, no widgets, no viewport access). That lands in
  Phase 2 together with the extension-UI RPC channel.
- **No out-of-worker code.** Extensions run in the same Worker as the
  agent. There is no iframe or separate Worker per extension — the
  isolation story deferred to Phase 3.
- **No TypeScript sources.** Only single-file `index.js` with ESM
  `export default` is accepted. TS transpilation lands in Phase 3.
- **No bare-specifier imports.** Extension code sees the host Worker's
  globals; there is no bundler-style resolver for `@mariozechner/...`
  or `@sinclair/typebox`. The `pi` argument re-exports everything an
  extension needs.

## Technical reference

### Types — `core/extensions/types.ts`

| Export | Purpose |
| --- | --- |
| `ExtensionContext` | `{ cwd, isIdle(), abort() }` — narrow read-only view handed to every handler / tool invocation. Phase 2 widens this. |
| `BeforeAgentStartEvent` / `...Result` | `{ type, prompt, systemPrompt }` → `{ systemPrompt? }`. |
| `ToolResultEvent` / `...Result` | `{ type, toolCallId, toolName, input, content, details, isError }` → `{ content?, details?, isError? }`. No deep merge — supplied fields replace wholesale. |
| `ToolDefinition<TParams, TDetails>` | Thinner than coding-agent's: `name`, `description`, `parameters` (TypeBox), optional `prepareArguments` / `executionMode`, and `execute(toolCallId, params, signal, onUpdate, ctx)`. Intentionally no `renderCall` / `renderResult` / `label` — there is no TUI to render into. |
| `defineTool<TParams, TDetails>(tool)` | Passthrough helper that preserves parameter inference so `pi.registerTool(pi.defineTool({ … }))` type-checks even when the tool is stored in an intermediate variable. |
| `RegisteredTool` / `RegisteredCommand` | Runtime record for a tool / command contributed by an extension. Both carry `extensionPath` for diagnostic reporting. |
| `ExtensionCommandHandler` | `(args: string, ctx: ExtensionContext) => void \| Promise<void>`. |
| `ExtensionAPI` | Surface handed to the extension factory: `on(event, handler)` (both events), `registerTool`, `registerCommand`, plus the `Type` / `defineTool` helpers re-exported so extensions don't need external imports. |
| `ExtensionFactory` | `(pi: ExtensionAPI) => void \| Promise<void>`. |
| `ExtensionManifest` | `{ name, version?, description? }`; optionally provided by a sibling `package.json`. |
| `Extension` | Loaded-state record: `ExtensionManifest` + `path`, `entryPath`, and `Map`s keyed by name for `handlers`, `tools`, `commands`. |
| `ExtensionDescriptor` | Plain-data RPC payload: `{ name, description?, version?, path, enabled, loaded, error? }`. Carries both load state and error so the main thread doesn't need two streams. |
| `ExtensionError` | `{ extensionPath, event, error, stack? }`. Emitted via `extension_error` RPC. |
| `ContextSupplier` | `() => ExtensionContext`. The wrapper calls this on every tool invocation so the captured context is always live. |

### Loader — `core/extensions/loader.ts`

Structured around an injectable `ExtensionLoaderOps` (`ls.readdir`,
`ls.stat`, `read.readFile`) so it can be driven by `VaultOperations` in
the worker and by in-memory fakes in tests.

| Export | Purpose |
| --- | --- |
| `ModuleImporter` | `(code: string) => Promise<Record<string, unknown>>`. |
| `LoadExtensionsOptions` | `{ enabledState?, importModule? }`. Callers pass a snapshot of `{ name: enabled }`; extensions whose entry is missing from the map default to enabled (opt-out). |
| `LoadExtensionsResult` | `{ extensions: Extension[], descriptors: ExtensionDescriptor[] }`. Descriptors carry both loaded successes and broken entries with their `error` populated. |
| `loadExtensionsFromVault(ops, vaultMount, options?)` | Walks `<vaultMount>/.pi/extensions/`, reads each `index.js`, parses the optional `package.json`, dynamic-`import()`s via the supplied importer, and runs the default-export factory with a fresh `ExtensionAPI`. |
| `loadExtensionFromSource(code, name, { path?, manifest?, importModule? })` | Used by unit tests to exercise the factory path without needing a filesystem. |
| `importFromVault` | Default importer — builds a Blob URL and awaits `import(blobUrl)`. Node-only tests inject a data-URL importer because Node's dynamic `import()` doesn't resolve `blob:` URLs from the module loader. |

Validation is intentionally light in Phase 1: on duplicate extension
names the runner's `getAllRegisteredTools` / `getRegisteredCommands`
run a first-wins dedupe rather than flagging collisions. Missing root
(`/.pi/extensions/` does not exist) returns
`{ extensions: [], descriptors: [] }`. Explicit collision reporting
is Phase 2 work.

### Runner — `core/extensions/runner.ts`

`ExtensionRunner` owns the set of currently loaded `Extension` records
and exposes typed dispatchers the `WorkerAgentHost` calls from the
agent lifecycle.

| Method | Behaviour |
| --- | --- |
| `setExtensions(list)` / `clear()` | Replace / reset the loaded set. |
| `getExtensions()` / `hasExtensions()` / `hasHandlers(event)` | Accessors used by the controller to decide whether to run the hook loop. |
| `onError(listener)` | Subscription surface. Errors caught during hook / tool dispatch are routed through these listeners; `ExtensionHostController` bridges them to the `extension_error` RPC event. |
| `getAllRegisteredTools()` / `getRegisteredCommands()` | Deduplicate by name across extensions (first wins). |
| `findCommand(name)` | O(n·m) lookup used by the controller before falling through to builtins. |
| `emitBeforeAgentStart(event, ctx)` | Chains handlers in load order. Each handler sees the running override; returns the final `systemPrompt` (or `undefined` when nobody asked to override). |
| `emitToolResult(event, ctx)` | Chains handlers; merges `content` / `details` / `isError` overrides with replace-not-merge semantics. Returns the merged override (or `undefined`). |

The runner does NOT own the enable/disable map or any pending-flush
bookkeeping — that lives on `ExtensionHostController` so the runner
stays a pure dispatcher over the currently-loaded set.

Per-extension error isolation is the defining rule: every handler call
site is wrapped in `try/catch`; caught errors become `ExtensionError`
records routed through `reportError`.

### Wrapper — `core/extensions/wrapper.ts`

Converts `RegisteredTool` records into `pi-agent-core` `AgentTool`
instances. The wrapper carries a `ContextSupplier` (not a captured
snapshot) so every invocation sees live `isIdle` / `cwd` state.

| Export | Behaviour |
| --- | --- |
| `wrapRegisteredTool(reg, ctxSupplier)` | Builds `AgentTool` with the extension's `description` / `parameters`, forwarding `prepareArguments` / `executionMode`, and routing `execute` through `(toolCallId, params, signal, onUpdate) => reg.definition.execute(…, ctxSupplier())`. |
| `wrapRegisteredTools(list, ctxSupplier)` | Array passthrough preserving order. |

### Registry integration — `core/commands/registry.ts`

`SlashCommandSource` gained an `'extension'` entry. `CommandRegistry`
tracks extension commands alongside builtins, prompt templates, and
skills:

- `setExtensionCommands(list)` / `clearExtensionCommands()` / `clearAll()`
  — replace or drop the extension-contributed set.
- `list()` appends `/<name>` entries with `source: 'extension'`, the
  description carried from `RegisteredCommand`, and
  `argumentHint` when the extension supplied one.
- `findExtensionCommand(name)` — used by the worker-host before any
  other routing so extensions can override builtins.

Skills and extensions share no storage — the two loaders are
independent.

### Agent-session hooks — `core/agent-session.ts`

`AgentSession` exposes:

- `getSystemPrompt()` — read-only accessor used by the worker-host to
  compose the `BeforeAgentStartEvent`.
- `setAfterToolCall(fn)` / `setBeforeToolCall(fn)` — minimal
  pass-throughs into `pi-agent-core`'s native hooks. The worker-host
  installs `setAfterToolCall` the first time it loads any extension
  with a `tool_result` handler and leaves it installed for the
  session's lifetime (the callback short-circuits when the runner has
  no handlers).

### Host controller — `worker/extension-host.ts`

`ExtensionHostController` owns every piece of per-extension state:
the runner, the descriptor cache, the authoritative enable-state map,
a single `pendingFlush` boolean, and the lazily-installed
`setAfterToolCall` hook. `WorkerAgentHost` delegates through a narrow
`ExtensionHostDeps` surface (`session`, `commands`, `getVaultOps`,
`getVaultMount`, `isVaultAttached`, `refreshTools`, `emitEvent`) so
the controller can be exercised without standing up a full host.

| Method | Behaviour |
| --- | --- |
| `loadFromVault()` | Discover, import, and factory-invoke every enabled extension; populate descriptors + commands; reconcile the enabled map against the scan (prunes removed entries so the map cannot grow monotonically); ensure the `afterToolCall` hook is installed. |
| `setStates(states)` | Merge into the enable map. If streaming, set `pendingFlush = true` and return the current descriptors; otherwise reload + refresh tools + emit `extension_states`. |
| `flushIfPending()` | Called at `agent_end`. If `pendingFlush` is set, runs the reload + refresh + emit sequence. |
| `emitBeforeAgentStart(prompt, systemPrompt)` | Compose the event and dispatch through the runner. |
| `tryRunCommand(message)` | Dispatch an `/ext-cmd` handler inline on the worker side and return `true` when handled. |
| `getWrappedTools()` | Produce `AgentTool[]` on demand (via the wrapper + context supplier). |
| `buildContext()` | Fresh `ExtensionContext` on every call so handlers see live `isIdle` / `cwd`. |
| `emitStates()` / `list()` / `clear()` | Broadcast, snapshot, and teardown. |

### Worker host wiring — `worker/worker-host.ts`

`WorkerAgentHost` holds one `ExtensionHostController` and delegates
all extension concerns to it. Lifecycle:

| Event | Host behaviour |
| --- | --- |
| constructor(…, `{ initialExtensionEnabledState }`) | Instantiate `ExtensionHostController` pre-seeded with the persisted enabled map forwarded through the init protocol; hook `agent_end` to `extensions.flushIfPending()`. |
| `mountVault(handle)` / `mountDevSeed(seed)` | `extensions.loadFromVault()`, `refreshTools()`, rebuild system prompt, `extensions.emitStates()`. |
| `reloadCommands()` | Reload prompts / skills / extensions, `refreshTools()`, `extensions.emitStates()`. |
| `unmountVault()` | `extensions.clear()`, drop vault tools, emit an empty `extension_states`. |
| `listExtensions()` RPC | `extensions.list()`. |
| `setExtensionStates(next)` RPC | `extensions.setStates(next)`. |
| `prompt(message)` | 1) `extensions.tryRunCommand(message)` — if handled, short-circuit. 2) `commands.expandAsync(…)` for skill + template expansion. 3) `extensions.emitBeforeAgentStart(…)`; when an override is produced, swap it onto the session and restore the previous prompt in a `finally`. |
| `agent_end` (via `session.subscribe`) | `extensions.flushIfPending()` — reload extensions with the buffered enable-state, refresh tools, emit `extension_states`. |

`refreshTools()` merges vault tools + upcalled MCP tools + the wrapped
extension tools into the single tool list `AgentSession` sees.

### RPC — `rpc/rpc-types.ts`, `rpc-server.ts`, `rpc-client.ts`

- Commands: `list_extensions` → `ExtensionDescriptor[]`,
  `set_extension_states({ [name]: boolean })` → `ExtensionDescriptor[]`.
- Events: `extension_states` (`{ type, extensions }`),
  `extension_error` (`{ type, extensionPath, event, error, stack? }`).
- Known-commands map on the server and `isEnvelope` on the client were
  both extended so the types are authoritative at wire level.

### Main-thread state — `src/providers/WebAgentProvider.tsx`, `src/extension-store/ExtensionStore.ts`, `src/hooks/useExtensionState.ts`

`WebAgentProvider` hydrates the persisted enabled map from IDB
**before** calling `getAgentWorker`; the map is forwarded through the
worker init message (`WebAgentOptions.initialExtensionEnabledState`)
so the Worker's very first `mountVault` / `mountDevSeed` load already
honours the user's choices. There is no load-then-unload churn at
boot.

`ExtensionStore` is an `idb-keyval`-backed map keyed by extension name
(`web-agent.extensions.enabled`). It serializes writes behind a
`writeChain` promise and notifies subscribers. Methods:

- `load()` / `snapshot()` / `isLoaded()`
- `setEnabled(name, enabled)` / `setMany(entries)` / `disableAll(names)`
- `subscribe(listener)` returning a disposer.

`useExtensionState()` composes the store and the RPC surface:

1. On mount, hydrates the persisted map for UI display and fetches
   the descriptor list via `list_extensions` once to catch up on any
   `extension_states` pushes that fired before the subscriber
   attached. No `set_extension_states` push is issued here — the
   worker already received the map via its init message.
2. Subscribes to `extension_states` — each push reconciles the
   descriptor list with the persisted map; any discovered extension
   not already tracked is added at `enabled = true` (opt-out) and
   written back both to IDB and the worker.
3. Subscribes to `extension_error`, buffering the most-recent 20
   entries so toggling another extension doesn't drop them.
4. Exposes `{ extensions, errors, enabledMap, setEnabled, disableAll,
   clearErrors }`.

### ExtensionsPanel — `src/components/extensions/ExtensionsPanel.tsx`

Popover-trigger component with:

- `data-testid="extensions-popover-trigger"` carrying
  `data-test-state="active" | "idle" | "error"`.
- A badge (`extensions-badge`) showing the loaded+enabled count.
- A runtime-errors block (`extensions-runtime-errors`) rendering the
  last 20 `ExtensionError`s, dismissible via
  `extensions-clear-errors`.
- Per-extension rows stamped `extensions-row-<name>` with
  `data-test-state="enabled" | "disabled" | "broken"`, checkbox
  `extensions-toggle-<name>`, and an inline error paragraph
  `extensions-error-<name>` for broken entries.
- `extensions-disable-all` — the M8 trip switch.

`ChatDemo.tsx` instantiates `useExtensionState` alongside
`useSkillSandbox` and `useMcpAgentTools`, threading the derived props
into `ChatInput` which renders the panel next to `McpPopover`.

### Fixtures — `e2e/data/sample-with-extensions/.pi/extensions/`

Four fixture extensions, documented in the per-folder `README.md`:

| Extension | Origin | Notes |
| --- | --- | --- |
| `fancy-prompt/` | `packages/coding-agent/examples/extensions/pirate.ts` | Toggles a pirate-style `systemPrompt` override via a `before_agent_start` handler; `/fancy-prompt` command flips the internal flag. `ctx.ui.notify` removed (no UI API in Phase 1). |
| `hello-tool/` | `packages/coding-agent/examples/extensions/hello.ts` | Uses `pi.Type` / `pi.defineTool` instead of external imports; `label` dropped (no TUI). |
| `broken/` | Intentionally malformed JS | Verifies the loader captures syntax errors without taking the rest of the scan down. |
| `thrower/` | Throws synchronously in `before_agent_start` | Verifies per-extension error isolation and `extension_error` surfacing. |

## Tests

- `core/extensions/loader.test.ts` — empty dir, happy-path factory
  execution, syntax-error capture, disabled skip, missing default
  export, manifest fields via `package.json`.
- `core/extensions/runner.test.ts` — `before_agent_start` chaining +
  error isolation, `tool_result` overrides (content / details /
  isError), tool + command deduplication, `findCommand`, pending
  enable-state buffering, `clear()`.
- `core/extensions/wrapper.test.ts` — execute-signature adaptation,
  live context supplier, order preservation,
  `prepareArguments` / `executionMode` forwarding.
- `core/commands/registry.test.ts` — `setExtensionCommands`, listing
  order, `findExtensionCommand`, `clearExtensionCommands`, `clearAll`.
- `worker/worker-host.test.ts` — extension lifecycle across mount /
  reload / unmount, `list_extensions` / `set_extension_states`
  handling, `extension_states` / `extension_error` event emission.
- `e2e/extensions.spec.ts` — palette surfacing, prompt-shaping toggle
  via `/fancy-prompt`, `hello` tool happy path, per-extension toggle,
  global disable-all, broken-extension error path, thrower hook error
  surfacing.

## Constraints

1. **Single-file ESM entry.** Only `index.js` with a default export is
   loaded. Multi-file extensions, TypeScript sources, and CJS shims
   are deferred.
2. **No bare-specifier imports.** Extensions interact with the host
   exclusively through the `pi` argument.
3. **Structured-clone safe RPC.** Descriptors and error payloads must
   serialize over `postMessage`; anything that doesn't (functions,
   DOM refs) stays inside the worker.
4. **Worker is source of truth.** Main-thread UI mutates state
   exclusively via `set_extension_states`; the worker's `extension_states`
   broadcast is what the UI renders. Optimistic updates are forbidden.
5. **Per-extension isolation.** Every handler dispatch and tool
   invocation site wraps the user function in `try/catch`; failures
   surface as `ExtensionError` events and never propagate into the
   agent.
6. **Disable-all is the M8 gate.** The UI must expose a single-click
   way to silence every loaded extension without requiring a reload.

## Change procedure

Any plan that edits `core/extensions/*`, `core/commands/registry.ts`
(extension paths), `core/agent-session.ts` (tool-call hooks),
`worker/worker-host.ts` (extension lifecycle or RPC dispatch),
`rpc/rpc-types.ts` / `rpc-server.ts` / `rpc-client.ts` (extension
commands or events), `src/extension-store/ExtensionStore.ts`,
`src/hooks/useExtensionState.ts`, or `src/components/extensions/*`
must update this file in the same PR. Cross-links to update whenever
this file changes:
[`./index.md`](./index.md),
[`./skills.md`](./skills.md) (when the two loaders grow shared
infrastructure), and
[`../../coding-vs-web-agent/feature-gaps.md`](../../coding-vs-web-agent/feature-gaps.md).
See [`./index.md` § Change procedure](./index.md#change-procedure).
