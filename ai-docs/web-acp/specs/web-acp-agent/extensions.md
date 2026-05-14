# Extensions — vault-sourced runtime

**Source of truth (agent package):**
`packages/web-acp-agent/src/agent/extensions/`.

**Status:** in progress (M6). This spec is **the** living contract
for the extension surface. Each phase of M6 extends a section
below; Phase 0 lays down the skeleton + locked decisions, and
subsequent phases fill in callback inventories, wire shapes,
and worked examples as they ship. **Phases that have not landed
are explicitly marked as such** so a reader can tell what is
implemented from what is planned.

## Purpose

A user drops a JS module at
`<mount>/.pi/extensions/<name>/index.js`. On next session boot,
the agent loads it, calls its default-export factory with a
`pi: ExtensionAPI` argument, and dispatches lifecycle / tool /
provider / command callbacks against the registered handlers.

Extensions are an **agent-side** concern. The ACP wire stays
canonical: extension-registered tools ride
`session/update (tool_call)`, extension commands merge into
`available_commands_update`, extension-contributed models flow
through `unstable_setSessionModel`. The only new wire surface is
the `_bodhi/extensions/{list, reload, add}` ext-method family
(per-phase delivery — see [Wire methods](#wire-methods)).

## Hard constraints

1. **Loader is host-neutral.**
   `packages/web-acp-agent/src/agent/extensions/` MUST NOT
   import `@zenfs/dom`, `node:*`, or any browser/Node-specific
   module. Browser fetch / Blob / URL access lives in
   `packages/web-acp/src/`.
2. **No UI primitives in callbacks.** No `ctx.ui.*`, no
   `pi.registerShortcut`, no `pi.registerFlag`, no
   `pi.registerMessageRenderer`, no custom tool rendering.
   Anything that requires user-interaction primitives is out of
   scope for M6 (see
   [`../../milestones/deferred.md`](../../milestones/deferred.md)
   for the carve-out registry, populated at M6 exit).
3. **Trust model: fully trusted.** A misbehaving extension can
   take the agent down. Sandboxing is post-v1.
4. **Per-host scope: `packages/web-acp/` only** in M6.
   `cli-acp-client` and any future host can pick up the loader
   without churn because the loader stays host-neutral.

## File shape

Extensions live at
`<mount>/.pi/extensions/<name>/index.js`. Multi-file extensions
ship sibling `.js` files alongside `index.js` and use **relative
imports only** (e.g. `import { X } from "./util.js"`). No
`package.json`, no `node_modules`, no TypeScript, no
nested directory structure for the entry point.

Discovery is per-mount. The same extension name in two mounts
is a conflict — the first mount wins, the second logs a warning
and is skipped. Resolution is for the user (rename the folder).

## Default-export contract

```ts
// <mount>/.pi/extensions/<name>/index.js
//
// The default export is a factory called once per session boot
// (and again on every `_bodhi/extensions/reload`). The factory
// receives the `pi: ExtensionAPI` object as its only argument,
// registers callbacks / tools / commands / providers, and either
// returns void (sync registration) or a Promise (async). It must
// not block on long-running work — boot is gated on every
// extension's factory completing.
export default function activate(pi) {
  pi.on("before_agent_start", (event) => {
    event.systemPrompt = "You are a pirate.\n\n" + (event.systemPrompt ?? "");
  });
}
```

The factory has **no other arguments**. Module identity for
shared symbols (e.g. TypeBox, zod) is provided exclusively
through `pi: ExtensionAPI` — extensions do not import from
`@bodhiapp/web-acp-agent`. See [Module identity](#module-identity)
for rationale.

## Module identity

**Strategy: factory-arg only.** Extensions receive `pi:
ExtensionAPI` and that's it. Anything an extension needs is
exposed through `pi.*`. No shared imports across extensions, no
import-map shim, no `es-module-shims`. Aligns with the locked
"single ES module, no `package.json`, no TypeScript, no jiti"
posture.

Consequences:

- Two extensions cannot share a class instance and use
  `instanceof` against it. They communicate via `pi.events`
  (an inter-extension event bus, M6 phase 10) or by
  exchanging plain JSON.
- Tool / command schemas are declared via `pi.types` (the agent's
  TypeBox singleton, exposed at runtime) when an extension
  registers a typed tool. The exact shape lands at Phase 5.

## Loader

**Pattern: data URL + dynamic import.** Phase 2 lands at
`packages/web-acp-agent/src/agent/extensions/loader.ts`. Source
of inspiration: the frozen-spike loader at
`packages/web-agent/src/worker-agent/core/extensions/loader.ts`
(cross-read only — never imported, per `CLAUDE.md`); Phase 2
diverged on the URL scheme (data instead of blob) so the loader
runs in browser/worker hosts AND in Node test environments
without a separate code path.

For each `<mount>/.pi/extensions/<name>/index.js`:

1. Read bytes via a narrow `ExtensionsFs` injection (the
   parallel of the M4 `CommandsFs` — see
   [`commands.md`](commands.md)). Production wiring is
   `createZenfsExtensionsFs()`; tests inject in-memory fakes.
2. Encode source bytes as
   `data:text/javascript;base64,<base64>`.
3. `await import(/* @vite-ignore */ dataUrl)` (the
   `@vite-ignore` keeps Vite from trying to statically resolve
   the URL at build time).
4. Validate `module.default` is a function; otherwise log + skip.
5. Construct the `pi: ExtensionAPI` for this extension; call
   `module.default(pi)`; await if returned promise.

The browser worker is the consumer in M6; CLI / future Node
hosts pick up the loader without a code change because data
URLs work in every JavaScript runtime that supports dynamic
`import()`.

## Discovery cadence

- **Boot** — every session boot walks every mounted volume's
  `<mount>/.pi/extensions/` directory and instantiates each
  extension once.
- **Reload** — `_bodhi/extensions/reload` (and the
  `/extension on|off` built-in) calls
  `ExtensionRegistry.reload()`, which disposes every active
  extension, clears the tool / command / provider / event-bus
  state, and re-walks the mounts captured at boot, skipping
  anything in the persisted `extensions:disabled` set. Phase 12 ✓.
- **Watcher** — none in M6. Adding fs watching is post-M6.

## Conflict resolution

- **Tools** (`pi.registerTool`): last-write-wins. Two extensions
  registering the same `name` → the second wins; a structured
  warning logs against the first. Mirrors
  [`packages/coding-agent/src/core/extensions/runner.ts`](../../../packages/coding-agent/src/core/extensions/runner.ts).
- **Commands** (`pi.registerCommand`): last-write-wins among
  extensions. Two extensions registering the same `name` → the
  second wins and the first's entry is removed; a structured
  warning logs against the displaced owner. Consistent with tools
  and providers. (The original design called for a load-order
  suffix scheme, but the implementation adopted last-write-wins
  for consistency across all resource types; this spec entry
  reflects the shipped behavior as of M6.)
  - **Cross-source collision** (vault command/prompt vs. extension
    command with the same canonical name): vault wins, the
    extension command is dropped from `available_commands_update`
    and a warning logs against the displaced extension. Picker
    shows exactly one entry. The same precedence applies in
    dispatch — vault commands intercept first.
- **Providers** (`pi.registerProvider`): last-write-wins on
  provider name; same warning shape as tools.
- **Cross-mount name collision (extension folder name)**: first
  mount wins; second logs a warning and is skipped. User
  resolves by renaming.

## ExtensionAPI surface

The `pi` object's surface grows phase-by-phase. Every phase that
adds a method or callback updates this section.

> **Phase 3 status:** `session_start` and `before_agent_start` now
> dispatch live. `pi.fs` (read-only ZenFS view scoped to
> `/mnt/<volume>` paths) and `pi.volumes` (read-only snapshot of
> currently mounted volumes) ship as part of the same phase so
> rule/persona-style extensions can read vault content without
> waiting on later capability surfaces. Phase 2's recording-only
> `pi.on` registry is preserved; the recorded subscriptions are
> what the runner walks at dispatch time.

| Surface | Phase | Status |
| --- | --- | --- |
| `pi.on(event, handler) -> Disposable` | various | Phase 2 ✓ recording-only; Phase 3 ✓ dispatches `session_start` + `before_agent_start`; Phase 4 ✓ dispatches `input`; Phase 6 ✓ dispatches `tool_call` + `tool_result`; Phase 9 ✓ dispatches `before_provider_request` + `after_provider_response`; per-phase dispatch wires the rest later. |
| `pi.fs.readdir / pi.fs.readFile` (read-only `/mnt/<volume>` view) | Phase 3 | Phase 3 ✓ |
| `pi.volumes.list()` (read-only `VolumeSnapshot[]`) | Phase 3 | Phase 3 ✓ |
| `pi.registerTool(tool) -> Disposable` | Phase 5 | Phase 5 ✓ |
| `pi.types` (TypeBox singleton) | Phase 5 | Phase 5 ✓ |
| `pi.registerCommand(name, def) -> Disposable` | Phase 7 | Phase 7 ✓ |
| `pi.registerProvider(name, config) -> Disposable` | Phase 11 | Phase 11 ✓ apiKey + custom `streamSimple`; OAuth scaffolding type-fixed but not host-bridged |
| `pi.events.on / pi.events.emit` | Phase 10 | Phase 10 ✓ |
| `pi.session.getId()` | Phase 8 | Phase 8 ✓ |
| `pi.session.appendEntry(customType, data)` | Phase 8 | Phase 8 ✓ |
| `pi.session.setName(name) / pi.session.getName()` | Phase 8 | Phase 8 ✓ |
| `pi.session.setLabel(entryId, label)` | Phase 8 | Phase 8 ✓ (best-effort) |
| `pi.session.sendMessage(text)` | Phase 8 | Phase 8 ✓ |
| `pi.session.sendUserMessage(text)` | Phase 8 | (stub — emits warning, no-op until prompt-driver re-entry lands) |

### `pi.session` (Phase 8)

```ts
interface ExtensionSessionView {
  getId(): string | null;
  appendEntry(customType: string, data: unknown): Promise<void>;
  setName(name: string): Promise<void>;
  getName(): string | null;
  setLabel(entryId: string, label: string | undefined): Promise<void>;
  sendMessage(text: string): Promise<void>;
  sendUserMessage(text: string): Promise<void>;
}
```

The view is bound at extension load time; method calls capture
the registry's **active session id** at invocation time
(`getId()` returns `null` outside a dispatch). Calls outside an
active dispatch throw with a clear error so misconfigured
extensions fail loudly. Concretely:

- **`appendEntry(customType, data)`** persists a typed
  `'extension'` `SessionEntry` (`{ extensionName, customType, data }`)
  via `SessionStore.recordExtension`. On `session/load` the entry
  is rebuilt by `reconstructMessages` as a muted assistant
  message tagged `_meta.bodhi.builtin.command =
  'extension:<name>:<customType>'`, which the host renders with
  the same muted-bubble shape as built-in command replies. The
  Phase 8 contract is **survives reload**; live rendering during
  the emitting turn is intentionally deferred so the streaming
  reducer's single `streamingMessage` slot does not have to
  juggle out-of-band chunks. Add a dedicated wire seam later if
  a use case needs it.
- **`setName(name)`** writes through to
  `SessionStore.setTitle(sessionId, name)`. Trimmed empty string
  clears the title (host falls back to the auto-derived
  first-prompt title).
- **`getName()`** returns `null` for now — the bridge does not
  cache the title host-side. Extensions that care should track
  what they last wrote.
- **`setLabel(entryId, label)`** is best-effort: extensions
  receive `entryId` from a future `appendEntry` return value
  (planned for the same phase that lands the label-bubble UI in
  M7); Phase 8 wires the host bridge but the Dexie / in-memory
  stores apply the label only when the row is an `'extension'`
  kind, no-op otherwise. Pass `undefined` to clear.
- **`sendMessage(text)`** persists an `'extension'` row with
  `customType: 'message'` so the message survives reload as a
  muted bubble. Same live-rendering caveat as `appendEntry`.
- **`sendUserMessage(text)`** is a Phase 8 **stub**: it emits a
  warning and no-ops. Wiring is gated on prompt-driver re-entry
  semantics that need careful coordination with the
  inflight-mutex guard. Lands in a follow-up phase.

The host bridge implementation lives at
[`acp/engine/extensions-host-bridge.ts`](../../../packages/web-acp-agent/src/acp/engine/extensions-host-bridge.ts);
the registry calls it through the typed `SessionBridge`
interface so the agent runtime stays agnostic of the host's
storage choice.

### `pi.events` (Phase 10)

```ts
interface ExtensionEventsView {
  emit(channel: string, data: unknown): Promise<void>;
  on(channel: string, handler: (data: unknown) => void | Promise<void>): Disposable;
}
```

Inter-extension pub/sub. One bus instance per
`ExtensionRegistry`; every loaded extension shares it. Channel
names are free-form strings; payloads are `unknown` (extensions
agree on a shape out-of-band — there is no schema validation).

`emit` returns a `Promise<void>` that resolves once **every
subscriber for that channel** has settled (handlers run in
subscription order, not parallel). This is intentionally
different from the coding-agent reference's fire-and-forget
node `EventEmitter` semantics: web-acp slash commands and
lifecycle handlers rely on the active-session context being
preserved across async listeners, so awaiting the chain
guarantees `pi.session.*` calls inside listeners see the right
sessionId. Fire-and-forget callers that drop the returned promise
still work — every listener runs, errors still get logged.

A handler that throws is caught at the bus and logged with the
channel name; peer handlers in the same emit pass continue. A
listener whose owning extension has been disposed is removed
from the channel set automatically (the registry's per-extension
`unsubs` array is unwound during teardown).

Implementation lives at
[`agent/extensions/event-bus.ts`](../../../packages/web-acp-agent/src/agent/extensions/event-bus.ts).

### Provider hooks (Phase 9)

```ts
pi.on('before_provider_request', (event) => {
  return { ...event.payload, temperature: 0 };
});

pi.on('after_provider_response', (event) => {
  console.log(event.status, event.headers['x-ratelimit-remaining']);
});
```

`before_provider_request` and `after_provider_response` are routed
through `pi-ai`'s `StreamOptions.onPayload` / `onResponse`
callbacks by `agent/stream-fn.ts:createStreamFn(provider,
consumeOverrides, getProviderHooks)`. The hooks fire **once per
LLM round-trip** — multi-step turns with tool calls fire them
multiple times (once per `streamSimple` call inside
`pi-agent-core`'s loop).

Wire path:

1. `start-agent.ts` constructs an `ActiveSessionRef` and a
   `getProviderHooks: () => StreamProviderHooks | undefined`
   callback. The callback returns `undefined` when no extension
   subscribed or when no session is active.
2. The `PromptTurnDriver` writes
   `services.activeSession.current = params.sessionId` before
   each `inline.prompt(text)` and clears it in `finally`.
3. Each `streamSimple` call reads the ref via `getProviderHooks`
   and forwards `onPayload` / `onResponse` to
   `extensions.dispatchBeforeProviderRequest` /
   `extensions.dispatchAfterProviderResponse`.

`before_provider_request` chains payload replacements in load
order. Each handler receives `event.payload` set to the previous
handler's return value (or the original payload for the first
handler); `undefined` / `void` keeps the prior value. The final
payload is what reaches the provider's HTTP request.

`after_provider_response` is observation-only. Thrown errors are
caught and logged so a buggy listener cannot poison the LLM
round-trip — the catch sits inside the dispatcher
(`runner.ts::dispatchAfterProviderResponse`), not inside the
extension code. Headers are typed as `Record<string, string>`
(matching `pi-ai`'s `ProviderResponse`); the dispatcher does not
clone or normalise.

The example ports for Phase 9
(`provider-payload`, `rate-limit-watch`) write each observation
through `pi.session.appendEntry` so they survive reload (browser
hosts cannot use the coding-agent reference's
`fs.appendFileSync`).

### `pi.registerCommand` (Phase 7)

```ts
pi.registerCommand('volumes', {
  description: 'List mounted volumes',
  handler: async (args: string) => `Mounted volumes:\n- /mnt/wiki`,
}) -> Disposable;
```

The handler signature is text-only:
`(args: string) => string | Promise<string>`. The returned text is
emitted as a single muted assistant reply tagged
`_meta.bodhi.builtin.command = '<name>'` and persisted as a
`'builtin'` store entry — replay reproduces the output verbatim
without consulting the LLM. Extension commands surface in
`available_commands_update` alongside built-ins and vault
commands; lookup runs ahead of `tryHandleBuiltin` so an extension
command and a vault command sharing a name resolve to the
extension. Conflict resolution is **last-write-wins**.

UI primitives (`ctx.ui.notify` / `ctx.ui.select` /
`ctx.ui.confirm`) are explicitly out of scope for Phase 7 — when
a host-side notification surface lands, this signature can grow a
`ctx` parameter without breaking existing extensions.

### `pi.registerTool` (Phase 5)

```ts
pi.registerTool({
  name: 'hello',
  label: 'Hello',
  description: '...',
  parameters: pi.types.Object({ name: pi.types.String() }),
  async execute(toolCallId, params, signal) {
    return { content: [{ type: 'text', text: `Hello, ${params.name}!` }], details: {} };
  },
}) -> Disposable;
```

The tool object matches `AgentTool<TSchema, TDetails>` from
`@mariozechner/pi-agent-core`. The registry passes accepted tools
into `inline.setModel({ tools })` per turn (after `bash` and MCP
tools); `bindAbortSignal` wraps each so `session/cancel` aborts
in-flight executes. Schema construction goes through `pi.types`
so the agent's `@sinclair/typebox` instance owns the `TSchema`
(no module-identity drift). Tools surface on
`ExtensionInfo.capabilities.tools`. Conflict resolution is
**last-write-wins** — a second extension registering the same
tool name evicts the first owner (warned via `warn(...)` and
removed from the prior owner's capability list).

### `pi.registerProvider` (Phase 11)

```ts
pi.registerProvider('custom-anthropic', {
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'CUSTOM_ANTHROPIC_API_KEY',
  api: 'anthropic-messages',
  authHeader: false,
  headers: { 'anthropic-version': '2023-06-01' },
  models: [
    {
      id: 'claude-opus-4-5',
      name: 'Claude Opus 4.5 (Custom)',
      reasoning: true,
      input: ['text', 'image'],
      cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      contextWindow: 200000,
      maxTokens: 64000,
    },
  ],
  oauth: { name: 'Custom Anthropic', login, refreshToken, getApiKey },
  // Optional: streamSimple(model, context, options) when no built-in API matches.
}) -> Disposable;
```

Provider models flow into `NewSessionResponse.models.availableModels`
via `AcpSessionRuntime.ensureModelsLoaded`, which merges
extension-contributed models with the host's catalog (extension
entries override host entries on `id` collision).
`AcpSessionRuntime.getModels` re-merges on every read so newly
registered providers show up without a re-auth.

Routing happens in `agent/stream-fn.ts:createStreamFn`:

1. The fourth argument, `getExtensionProvider`, resolves
   `(model) => ExtensionProviderResolution | null`. The default
   `start-agent.ts` wires it to `extensions.findProviderForModel`.
2. When a model belongs to an extension provider the stream fn
   reads `apiKey` / `headers` / `authHeader` from the resolution
   instead of `LlmProvider.getApiKeyAndHeaders`. With
   `authHeader: true` the agent injects `Authorization: Bearer
   <apiKey>`; otherwise headers go through verbatim and the
   provider implementation owns auth (Anthropic uses `x-api-key`).
3. When the resolution sets `streamSimple` the stream fn calls
   the extension's implementation in place of `pi-ai`'s built-in.
   This is the seam for non-built-in API formats; ports that
   target a built-in API (`openai-completions`,
   `anthropic-messages`, etc.) leave it `undefined`.

Conflict resolution is **last-write-wins** on provider name
(same shape as `pi.registerTool`). Disposing the registration
removes the provider from `listProviderModels` so the next
session-creation snapshot drops the contributed models.

OAuth scaffolding (`oauth: ProviderOAuthConfig`) is type-fixed
but not host-bridged in M6 — extensions that register `oauth`
can survive the M6 cut, but `_bodhi/auth/*` to drive
`login`/`refreshToken`/`getApiKey` is a post-M6 RFD.

### `pi.fs` (Phase 3)

A narrow facade re-exporting the same `ExtensionsFs` instance the
loader uses. Extensions read vault content with absolute paths
under `/mnt/<mountName>/...`:

```js
const entries = await pi.fs.readdir('/mnt/wiki/.claude/rules');
const text = await pi.fs.readFile('/mnt/wiki/marker.txt');
```

`readdir` returns `{ name, isFile, isDirectory }[]` and resolves
to `[]` for missing paths; `readFile` returns UTF-8 string content
and throws `ENOENT` for missing files. Writes are out of scope —
extensions that need to persist state use `pi.appendEntry` (Phase
8) instead of touching the filesystem directly.

**Trust model.** Extension code is fully trusted (see
[`../../steering/04-principles.md`](../../steering/04-principles.md)
§ 13). `pi.fs` accepts any absolute worker-visible path; there is
no sandbox restricting reads to `/mnt/<mount>/.pi/extensions/...`.
The convention is for extensions to read vault data under their
own mount, but the API does not enforce it.

### `pi.volumes` (Phase 3)

```ts
interface ExtensionVolumesView {
  list(): VolumeSnapshot[]; // { mountName, description?, tags }
}
```

Snapshot is captured at `loadAll(...)` time and stays stable for
the lifetime of the extension. Mount/unmount churn does not
re-fire factory functions; if an extension cares it should re-scan
on `session_start`. `claude-rules` does exactly this.

## Lifecycle event inventory

Each event is wired in a specific phase. Until that phase ships,
the event name is reserved but `pi.on(event, handler)` calls
record the subscription without firing.

> **Phase 0 status: nothing fires.** All entries are **(planned)**
> until their phase ships.

| Event | Phase | Semantics | Status |
| --- | --- | --- | --- |
| `session_start` | Phase 3 | Fires once per `session/new` and `session/load`, after MCP attach + commands refresh, before model resolution. Handler payload: `{ type, sessionId }`. Return value ignored. | Phase 3 ✓ |
| `before_agent_start` | Phase 3 | Per-turn, immediately before `inline.setModel`. Handler payload: `{ type, sessionId, prompt, systemPrompt }`. Returning `{ systemPrompt }` replaces the value the next handler sees and ultimately reaches the LLM; `void`/`undefined` leaves it untouched. | Phase 3 ✓ |
| `input` | Phase 4 | Per-turn, after `#extractPromptText` + slash expansion, before `inline.prompt`. Handler payload: `{ type, sessionId, text, source }` (`source` is `'user'` until Phase 8 introduces extension-injected input). Returning `{ action: 'transform', text }` replaces the text the next handler sees and the LLM ultimately gets; `{ action: 'handled' }` short-circuits the turn (no LLM call, returns `stopReason: 'end_turn'`); `{ action: 'continue' }`/`undefined` passes through. First `handled` wins and stops the chain. | Phase 4 ✓ |
| `tool_call` | Phase 6 | Per tool invocation, after pi-agent-core validates arguments and before `tool.execute(...)`. Handler payload: `{ type, sessionId, toolName, input }`. Returning `{ block: true, reason }` synthesizes an error tool result with the reason text — the LLM sees the refusal and adapts. First `block` wins and stops the chain. Mutating `event.input` in place (e.g. rewriting a path argument) is allowed but Phase 6 has no e2e for the rewrite path. | Phase 6 ✓ |
| `tool_result` | Phase 6 | Per tool invocation, after `tool.execute(...)` returns, before the result is folded into the assistant transcript. Handler payload: `{ type, sessionId, toolName, input, content, details, isError }`. Returning a partial patch (`{ content?, details?, isError? }`) merges field-by-field into pi-agent-core's `AfterToolCallResult` — `content` replaces the array verbatim, `details` replaces the structured payload verbatim, `isError` flips the flag. Patches chain across handlers (each handler sees prior accumulated values). Returning `undefined` leaves the result untouched. | Phase 6 ✓ |
| `tool_call` | Phase 6 | Mutate `event.input` in place; or return `{ block, reason }` to refuse. First `block: true` wins. | (planned) |
| `tool_result` | Phase 6 | Return partial patch (`{ content?, details?, isError? }`) to amend the result before it reaches the LLM. | (planned) |
| `before_provider_request` | Phase 9 | Per LLM round-trip, after the provider serialises the wire payload but before the HTTP request fires. Bridged into `streamSimple`'s `onPayload` hook from `pi-ai`. Handler payload: `{ type, sessionId, payload }` where `payload` is the **provider-specific JSON** about to be sent (OpenAI completions / Anthropic messages / etc.) — the agent does **not** structurally validate it. Returning a value replaces the payload that the next handler (and ultimately the provider) sees; returning `undefined` / `void` leaves it untouched. Replacements chain across handlers in load order. Mirror of the coding-agent semantics so ports drop in cleanly. | Phase 9 ✓ |
| `after_provider_response` | Phase 9 | Per LLM round-trip, after HTTP response headers arrive and before the body stream is consumed. Bridged into `streamSimple`'s `onResponse` hook. Handler payload: `{ type, sessionId, status, headers }`. Observation-only — return value is ignored, thrown errors are caught and logged so a buggy listener cannot poison the round-trip. | Phase 9 ✓ |
| `resources_discover` | Phase 2 | Placeholder. Reserved in `ExtensionEvent`; subscriptions record but no consumer fires the event yet. M7 consumes. | Phase 2 ✓ reserved |

Note: there is no per-session `session_shutdown` event. End-of-life
cleanup happens via `ExtensionRunner.disposeAll()` on registry
reload (drops every subscription); per-session cleanup is not a
runtime concern because the registry is process-wide. If a future
use case appears (per-session resources extensions need to release),
re-add as a deliberate spec change.

Out-of-scope events for M6 (UI-bound or session-fork / compaction
hooks) are documented in
[`../../milestones/deferred.md`](../../milestones/deferred.md)
at exit (Phase 14).

## Wire methods

`_bodhi/extensions/*` ext-methods land per-phase. Constants
in [`../../../../packages/web-acp-agent/src/wire/index.ts`](../../../../packages/web-acp-agent/src/wire/index.ts);
handlers in
`packages/web-acp-agent/src/acp/engine/ext-methods/`.

| Method | Phase | Purpose | Status |
| --- | --- | --- | --- |
| `_bodhi/extensions/list` | Phase 2 | Returns `{ extensions: BodhiExtensionDescriptor[], disabled: string[], knownNames: string[] }` for the host's read-only Extensions panel. | Phase 2 ✓ (Phase 12 added `disabled` + `knownNames`) |
| `_bodhi/extensions/reload` | Phase 12 | Re-runs discovery; tears down disabled, instantiates newly-enabled. Accepts optional `{ disabled?: string[] }` to atomically persist + apply a new toggle list. Returns the same shape as `_bodhi/extensions/list`. | Phase 12 ✓ |
| `_bodhi/extensions/state` (notification) | Phase 12 | Broadcast on every registry change (`/extension on\|off`, `_bodhi/extensions/reload`). Same payload as `_bodhi/extensions/list`. Hosts subscribe via `onExtNotification` to refresh their Extensions panel without polling. | Phase 12 ✓ |
| `_bodhi/extensions/add` | Phase 13 | Resolves an npm spec (`<name>[@<version>]`, optional `npm:` prefix), fetches the tarball, parses it via `nanotar`, writes `index.js` + `package.json` under `<agent-wd>/.pi/extensions/<safe-name>@<version>/`, then runs the same reload path as `_bodhi/extensions/reload`. Optional `registryUrl` overrides the default `https://registry.npmjs.org`. Returns `{ installed: { name, version, extensionName, installPath }, extensions, disabled, knownNames }`. | Phase 13 ✓ |

The exact request / response shapes land per-phase. Each phase
appends its `BodhiExtensions*` request / response interface to
`packages/web-acp-agent/src/wire/index.ts` and re-exports it
from the public barrel.

## Persistence

- **Disabled extensions list.** Stored under `PreferenceStore`
  via `EXTENSIONS_DISABLED_SCOPE` (`'__global__'` sentinel
  session id) + `EXTENSIONS_DISABLED_KEY` (`'extensions:disabled'`,
  JSON-encoded `string[]`). Read on agent boot via
  `readDisabledExtensions(prefs)` and applied to
  `ExtensionRegistry.setDisabled(...)` before `loadAll()` so the
  toggle survives a hard refresh. Mutations write through
  `writeDisabledExtensions(prefs, names)` from the `/extension`
  built-in and `_bodhi/extensions/reload`. Avoids extending the
  strict `FeatureKey` registry in
  [`../../../../packages/web-acp-agent/src/storage/feature-defaults.ts`](../../../../packages/web-acp-agent/src/storage/feature-defaults.ts).
  Phase 12 ✓.
- **Extension-owned state.** `pi.session.appendEntry(customType,
  data)` writes an `'extension'` `SessionEntry` carrying
  `{ extensionName, customType, data }`. The entry survives
  `session/load` because `reconstructMessages` rebuilds it as a
  muted assistant message; the host renders it with the same
  shape as built-in command replies (`_meta.bodhi.builtin.command
  = 'extension:<name>:<customType>'`). Phase 8 ✓.
- **Extension-contributed models.** Live alongside built-in
  models in the agent's catalog; no separate persistence layer.
  Phase 11.

## Reload semantics

- **Per-extension reload.** Each `Extension` exposes a
  `dispose()` method; any subscription created via `pi.on(...)`,
  `pi.events.on(...)`, `pi.registerTool(...)`,
  `pi.registerCommand(...)`, or `pi.registerProvider(...)` is
  auto-disposed by the runner when the extension is torn down.
- `ExtensionRegistry.reload()` (and the
  `_bodhi/extensions/reload` ext-method that wraps it) walks the
  registry:
  - Disposes every active extension and clears the registry's
    tool / command / provider maps + the `pi.events` bus.
  - Re-discovers from the same mounts captured by the last
    `loadAll(...)` call; extensions whose name appears in
    `#disabled` are skipped.
  - For every still-enabled extension: re-load + re-factory. The
    factory runs from scratch, so each reload is the canonical
    way to bring fresh extension bytes online (the loader
    re-reads from disk).
  - Re-emits `available_commands_update` for the active session
    so the picker reflects new / dropped commands.
  - Broadcasts `_bodhi/extensions/state` so hosts can refresh
    their Extensions panel without polling.
- **`/extension on <name>` / `/extension off <name>`** is the
  user-facing path: the built-in handler computes the new
  disabled set, writes it through `writeDisabledExtensions`, then
  calls `extensions.reload()` and broadcasts the new state. The
  `_bodhi/extensions/reload` ext-method is the host-facing path
  for the same operation; it accepts an optional `disabled`
  array which (when present) is persisted before the reload.
- **No live re-import.** Editing an extension file at runtime is
  not supported; the user must reload the page or call
  `_bodhi/extensions/reload` to pick up the new bytes.

## Install (`_bodhi/extensions/add`)

Phase 13. Browser-first npm install path with no native
dependencies — fetches both the registry metadata document and
the package tarball via plain `fetch()` (the npm registry has
served CORS-permissive `Access-Control-Allow-Origin` headers on
both endpoints since April 2022, so direct browser fetches
work).

- **Tarball parser:** [`nanotar`](https://github.com/unjs/nanotar)
  via `parseTarGzip(...)`. Web-standard
  `DecompressionStream`-based gzip + a tiny tar walker; ESM,
  ~1 KB minified. No `pako` dependency.
- **Entry resolution.** The install reads `package/package.json`
  from the tarball and prefers, in order:
  1. `pi.extensions[0]` (the published convention on `pi.dev`).
  2. `module`.
  3. `main`.
  4. `exports['.']` (string or `import` / `default` / `module`
     conditional inside the dot subpath).
  Tarballs with no usable hint are rejected — the loader's
  data-URL `import()` has no module-resolution base, so the
  install copies the entry's contents verbatim to
  `<install>/index.js` rather than re-exporting.
- **Layout written.** For a package `@scope/foo@1.2.3` the
  install writes:
  - `/mnt/<agent-wd>/.pi/extensions/scope__foo@1.2.3/index.js`
    — entry contents copied verbatim.
  - `/mnt/<agent-wd>/.pi/extensions/scope__foo@1.2.3/package.json`
    — verbatim copy of the manifest, useful for diagnostics and
    future `add`-without-reload paths.
  Plain (non-scoped) packages drop the `__` and use the bare
  name (`pi-greet@1.0.0/`).
- **Reload semantics.** The handler runs
  `ExtensionRegistry.reload()` synchronously after the write,
  re-emits `available_commands_update`, and broadcasts
  `_bodhi/extensions/state`. The newly installed extension
  appears in `_bodhi/extensions/list` without a page refresh.
- **Failure modes.** All install errors surface back to the
  caller as the rejected promise body; the `/extension add`
  built-in renders them as `Install failed: <message>` so the
  user can retry. Errors are namespaced (`extensions:bad-request`,
  `extensions:no-agent-wd-volume`, `extensions:write-fs-missing`,
  `extensions:registry-missing`) for hosts that want to switch
  on them.
- **Constraints (M6).** Single-file extensions only — relative
  imports from the entry are not currently resolved (we copy a
  single `index.js`, not the whole `package/` tree). Multi-file
  packages are tracked in `deferred.md` and will land alongside
  loader changes that swap the data-URL trick for a blob URL +
  base.

The `/extension add <pkg>` built-in (Phase 13) drives the same
ext-method via `BuiltinExtensionsHandle.add(spec, options?)`. It
parses an optional `--registry <url>` (or `--registry=<url>`)
flag from the user's input and forwards it through. Tests use a
Playwright `BrowserContext.route` mock at a fake registry origin
to keep the e2e self-contained — no real network round-trip to
`registry.npmjs.org` is required.

## Volume tag taxonomy (forward link)

`<mount>/.pi/extensions/...` is discovered on every mounted
volume. Some operations need a specific volume — the install
path (`_bodhi/extensions/add`, Phase 13) writes into the volume
tagged `agent-wd`; future skill discovery may want a `data`
volume.

`packages/web-acp-agent/src/agent/volume-registry.ts` exposes
`tags?: string[]` on `VolumeInit` / `VolumeSnapshot` and a
`findByTag` helper. Well-known constants (`AGENT_WD`, `CWD`,
`DATA`) ship at
`packages/web-acp-agent/src/agent/extensions/well-known-volume-tags.ts`
(re-exported from the public barrel). See
[`volumes.md`](volumes.md) for the canonical taxonomy. Phase 1.

## Examples (ports)

Ported example extensions live at
`packages/web-acp-agent/examples/extensions/<name>/`. Each port
includes:

- `index.js` — the ported extension code.
- `README.md` — origin (which `coding-agent` example or pi.dev
  package), diff vs original (what dropped on the floor and
  why), and what callback(s) the extension exercises.

The e2e fixture loader at
`packages/web-acp/e2e/helpers/install-extensions.ts` reads these
files and folds them into the per-test seeded volume. Phases
2-12 each port one extension.

| Phase | Extension | Origin | Demonstrates |
| --- | --- | --- | --- |
| 2 → 5 | `hello-passive` | synth no-op (renamed from `hello` in Phase 5) | factory contract, recording-only `pi.on` |
| 3 | `pirate` | `coding-agent/examples/extensions/pirate.ts` | `before_agent_start` system-prompt mutator (toggle stripped — Phase 7 reintroduces commands) |
| 3 | `claude-rules` | `coding-agent/examples/extensions/claude-rules.ts` | `session_start` vault scan via `pi.fs` + `pi.volumes`, then `before_agent_start` patch chained with peers |
| 4 | `input-transform` | `coding-agent/examples/extensions/input-transform.ts` | `input` callback rewriting `?quick foo` → `Respond briefly... QUICK: ...` (UI-bound `ping`/`time` branches stripped) |
| 5 | `hello-tool` | `coding-agent/examples/extensions/hello.ts` | `pi.registerTool` + `pi.types`; LLM-callable greeting tool with last-write-wins conflict resolution |
| 6 | `protected-paths` | `coding-agent/examples/extensions/protected-paths.ts` | `tool_call` block (write/edit branches re-targeted onto `bash` script scanning) |
| 6 | `redact-secrets` | synth | `tool_result` content patch; regex-scrubs API-key shapes from any tool's text blocks |
| 7 | `commands` | `coding-agent/examples/extensions/commands.ts` | `pi.registerCommand` text-only; `/volumes` muted reply listing mounts (UI primitives stripped) |
| 8 | `session-counter` | synth | `pi.session.appendEntry`; turn counter survives reload via `reconstructMessages` |
| 9 | `provider-payload` | `coding-agent/examples/extensions/provider-payload.ts` | `before_provider_request` + `after_provider_response`; node `fs.appendFileSync` log replaced with `pi.session.appendEntry` so observations survive reload in the browser host |
| 9 | `rate-limit-watch` | synth | `after_provider_response` only; pulls remaining-requests counter from well-known rate-limit headers and persists per-turn observations |
| 10 | `event-bus-ping` | `coding-agent/examples/extensions/event-bus.ts` | ping side of a two-extension `pi.events` round-trip; registers `/ping` slash command, emits on `ping`, listens on `pong`, persists each receipt via `pi.session.appendEntry`. `ctx.ui.notify` stripped (UI primitives out of scope for M6); upstream's single-extension self-ping split into ping + pong so the e2e proves cross-extension delivery. |
| 10 | `event-bus-pong` | synth | pong side of the round-trip; listens on `ping`, persists, emits on `pong`. |
| 11 | `custom-provider-anthropic` | `coding-agent/examples/extensions/custom-provider-anthropic` | `pi.registerProvider` apiKey path; registers two Claude models against the built-in `anthropic-messages` API (no custom `streamSimple` needed) and a typed-but-unwired OAuth stub. The bundled `@anthropic-ai/sdk` import + custom `streamSimple` from the upstream port is dropped because the built-in API covers the same wire shape; the upstream's `streamCustomAnthropic` is referenced from `extensions.md` for hosts that need a non-built-in API. |

## Cross-references

- Loader sibling: [`commands.md`](commands.md) (the
  `commandsFs` injection the extensions loader reuses).
- Volume tags: [`volumes.md`](volumes.md).
- ACP surface: [`acp.md`](acp.md) (`_bodhi/extensions/*`
  methods join the existing ext-method registry).
- Trust posture:
  [`../../steering/04-principles.md`](../../steering/04-principles.md)
  § 9 (pluggable interfaces) + § 13 (extensions are a late
  milestone).
- Plan: [`../../plans/m6-extensions.md`](../../plans/m6-extensions.md).
- Milestone: [`../../milestones/m6-extensions.md`](../../milestones/m6-extensions.md)
  — older hypothesis; re-shaped at Phase 14 to match what
  actually shipped.
