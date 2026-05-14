# Code Review — M6 Engine Layer Integration

**Commit:** `067bed6a` (M6 extensions, aggregated squash)
**Reviewer:** Claude Code / engine-integration pass
**Date:** 2026-05-07
**Focus:** How extensions hook into the agent's core loop.

---

## Files reviewed

- `packages/web-acp-agent/src/acp/engine/extensions-host-bridge.ts`
- `packages/web-acp-agent/src/acp/engine/prompt-driver.ts`
- `packages/web-acp-agent/src/acp/engine/session-runtime.ts`
- `packages/web-acp-agent/src/acp/engine/services.ts`
- `packages/web-acp-agent/src/acp/engine/types.ts`
- `packages/web-acp-agent/src/acp/engine/replay.ts`
- `packages/web-acp-agent/src/acp/engine/builtin-dispatch.ts`
- `packages/web-acp-agent/src/acp/handlers/session-crud.ts`
- `packages/web-acp-agent/src/api/start-agent.ts`
- `packages/web-acp-agent/src/api/types.ts`
- `packages/web-acp-agent/src/agent/inline-agent.ts`
- `packages/web-acp-agent/src/agent/stream-fn.ts`
- `packages/web-acp-agent/src/acp/agent-adapter.ts` (for wiring context)
- `packages/web-acp/src/agent/agent-worker.ts` (for host wiring context)
- `packages/web-acp-agent/src/agent/extensions/registry.ts` (for dispatch context)
- `packages/web-acp-agent/src/agent/extensions/runner.ts` (for dispatch context)

---

## Summary of architecture (as implemented)

Extensions load at worker boot (before `startAgent` is called). The host
constructs an `ExtensionRegistry`, calls `loadAll(...)`, then passes the
populated registry into `startAgent`. Inside `startAgent`, the registry is
threaded through `assembleServices` into `AcpAdapterServices.extensions`.
`AcpAgentAdapter` constructor calls
`services.extensions.setSessionBridge(createExtensionsHostBridge({ services }))`
to wire the host-storage bridge. Extensions are dispatched at six points in
the turn loop: `session_start`, `before_agent_start`, `input`,
`beforeToolCall` / `afterToolCall` (via `InlineAgent.setModel` hooks),
`before_provider_request`, and `after_provider_response`.

---

## Findings

### 1. `forceToolCall` lacks the `isDev` gate in the prompt-driver — spec/impl drift

**Severity: High**

**File:** `packages/web-acp-agent/src/acp/engine/prompt-driver.ts:234`

The spec (`acp.md` and the inline comment in `agent-adapter.ts` at `:59`)
explicitly states that `forceToolCall` is a DEV-only toggle and that the
agent should throw JSON-RPC error `-32004` when a non-DEV host tries to
enable it via `setSessionConfigOption`. However the prompt-driver applies
`forceToolCall` unconditionally:

```ts
// prompt-driver.ts:234
const toolChoice = featureSnapshot.forceToolCall && tools.length > 0 ? 'required' : undefined;
```

There is no `isDev` check here. The `AcpAgentAdapterOptions.isDev` field
exists (it is threaded into `AcpAdapterContext`) but the prompt-driver
constructor does not receive it, so even if a user manages to persist
`forceToolCall: true` via the preference store in a production build, the
next turn will honour it. The `-32004` guard in `handleSetSessionConfigOption`
that is described in the spec is also absent — `configIdToFeatureKey`
simply accepts the `forceToolCall` config id without any dev-mode check.

**Fix:** Either (a) pass `isDev` into `PromptTurnDriver` and gate the
`toolChoice = 'required'` branch on it, or (b) add the `-32004` guard in
`handleSetSessionConfigOption` so the preference can never be written in
production, making the prompt-driver check redundant. The spec's model
leans toward option (b) because it fails early at the write site.

---

### 2. `dispatchInput` fires after slash-command expansion but skips extension commands — ordering quirk

**Severity: Medium**

**File:** `packages/web-acp-agent/src/acp/engine/prompt-driver.ts:102–143`

The turn sequence is:

1. `tryHandleExtensionCommand(rawText)` — checks registered extension slash
   commands first, returns early if matched.
2. `tryHandleBuiltin(rawText)` — built-in `/help`, `/version`, etc.
3. `#applySlashCommandExpansion(params)` — expands vault prompt templates.
4. `dispatchInput({ text, source: 'user' })` — fires the `input` event.

The `input` event fires on the already-expanded text (post vault-template
expansion), which is correct for the case where the user types a vault
command that gets expanded. However, extension commands are handled
*before* step 3 and *before* `dispatchInput`. This means an `input`
handler that transforms text can only intercept plain prompts and
vault-expanded prompts — it cannot intercept extension command invocations.
This is arguably by design (extension commands are structural, not text),
but is not documented in `extensions.md`. A user writing an `input`
handler expecting to observe all text entering the LLM pipeline will be
surprised to find extension command results bypass it entirely.

Additionally, extension commands are not in `#availableCommands` (the
`this.#availableCommands` field is populated from vault commands + prompts).
`#applySlashCommandExpansion` only expands against `#availableCommands`,
so it will never attempt to expand an extension command. This means a user
typing `/ext-cmd` sees extension command resolution succeed even though the
vault-template expander would not recognise it. That is correct behaviour,
but it implies extension command names should not shadow vault prompt-template
names — there is no warning when they do (see finding 4).

**Fix:** Document in `extensions.md` § "Lifecycle event inventory — `input`"
that the event does not fire for extension command invocations. No code
change needed if the behaviour is intentional.

---

### 3. Extension command persistence uses `recordBuiltin` — asymmetry in replay

**Severity: Medium**

**File:** `packages/web-acp-agent/src/acp/engine/builtin-dispatch.ts:97–108`

Extension command replies are persisted via `services.store.recordBuiltin`:

```ts
await services.store.recordBuiltin(sessionId, {
  command: parsed.name,
  userText: rawText,
  replyText,
});
```

This stores a `'builtin'` entry (no `action` field). On replay
(`reconstructMessages` in `replay.ts`), `'builtin'` entries are reconstructed
as a user+assistant pair via `makeBuiltinUserMessage` / `makeBuiltinAssistantMessage`,
tagged with `_meta.bodhi.builtin.command = <name>`. This is the same path
as built-in commands, which is intentional per the spec.

However, there is an asymmetry: the live emission also uses
`conn.sessionUpdate` with a matching `_meta.bodhi.builtin.command` tag, but
the notification is emitted raw (via `conn.sessionUpdate`, not
`runtime.emit`). This means the notification is NOT persisted as a
`'notification'` entry, which is correct — the `'builtin'` entry is the
source of truth. But the entry does not include a `seq` or `messageId` that
the host's streaming reducer can use to give the reply a stable bubble ID.
Built-in command replies from `tryHandleBuiltin` have the same limitation,
so this is not a regression introduced by M6 extension commands specifically.
However, it means extension command replies in the streaming view will
always appear with auto-generated IDs (no `messageId` in the
`agent_message_chunk` notification). Worth noting for when the `messageId`
gap is closed for built-ins.

**Fix:** No action needed now; track alongside the built-in `messageId`
gap in `deferred.md`.

---

### 4. Extension commands not checked against vault command names during `refreshAvailableCommands`

**Severity: Medium**

**File:** `packages/web-acp-agent/src/acp/engine/session-runtime.ts:320–335`

`refreshAvailableCommands` deduplicates vault commands against prompt
templates (commands win), but extension commands are appended without any
collision check:

```ts
// session-runtime.ts:332-336
const availableCommands: AvailableCommand[] = [
  ...builtinAvailableCommands(),
  ...merged.map(toAvailableCommand),
  ...extensionCommands,           // no dedup against vault commands
];
```

Meanwhile, `tryHandleExtensionCommand` (in `prompt-driver.ts`) is called
*before* vault command expansion, so if an extension registers `/foo` and a
vault template is named `foo`, the extension wins at dispatch time, but the
`available_commands_update` notification advertises both. The client's
command picker will show duplicate names, leading to user confusion.

The spec (`extensions.md` § "Conflict resolution — Commands") says
extension command conflict resolution is **last-write-wins**, but that
resolution is applied between extensions only. The question of extension
commands colliding with vault commands is unspecified.

**Fix:** In `refreshAvailableCommands`, after building `merged`,
filter `extensionCommands` to exclude any name already in
`new Set(merged.map(c => c.name))`, and log a warning for collisions.
Alternatively, define the priority order in `extensions.md` and enforce
it here.

---

### 5. `setActiveSession` in `tryHandleExtensionCommand` uses a synchronous guard that does not protect against concurrent calls

**Severity: Low**

**File:** `packages/web-acp-agent/src/acp/engine/builtin-dispatch.ts:73–81`

```ts
extensions.setActiveSession(sessionId);
try {
  replyText = await found.definition.handler(parsed.args);
} finally {
  extensions.setActiveSession(null);
}
```

`ExtensionRegistry.#activeSessionId` is a simple property. If two
concurrent extension command handlers ran (which the `#inflightBySession`
mutex in the prompt-driver prevents for the same session, but could
theoretically happen with different sessions on the same worker), the
second `setActiveSession` call would clobber the first, and `pi.session.*`
calls in the first handler would see the wrong session id.

In practice the prompt-driver's per-session inflight guard serialises all
`prompt` calls for a given session, and the worker currently processes one
`prompt` at a time per the single-agent design. So the race cannot occur in
the current architecture. However, the comment in `registry.ts` says the
guard is a per-session mutex, not a global one — a future multi-session
worker would be vulnerable.

**Fix:** Low urgency. Add a comment in `registry.ts` explaining that
`#activeSessionId` is single-valued because the worker is single-session
at a time. If multi-session concurrency ever lands, replace it with a
per-dispatch context variable.

---

### 6. `buildProviderHooks` in `start-agent.ts` captures `activeSession.current` at hook-build time, not at call time

**Severity: Low**

**File:** `packages/web-acp-agent/src/api/start-agent.ts:70–94`

```ts
function buildProviderHooks(
  extensions: ExtensionRegistry | undefined,
  activeSession: ActiveSessionRef
): StreamProviderHooks | undefined {
  if (!extensions) return undefined;
  const sessionId = activeSession.current;   // captured here
  if (!sessionId) return undefined;
  return {
    async onPayload(payload) {
      return extensions.dispatchBeforeProviderRequest({
        type: 'before_provider_request',
        sessionId,                            // stale if session changed
        ...
      });
    },
    ...
  };
}
```

`buildProviderHooks` is called once per `streamSimple` invocation (via the
`getProviderHooks` callback in `createStreamFn`). The `sessionId` captured
at the top of `buildProviderHooks` is the value of `activeSession.current`
at the instant the stream function is entered, which is the correct prompt
session. If the session never changes between the start of a prompt turn
and the LLM round-trip (which it doesn't, since the inflight mutex
serialises prompts), this is fine. But the capture pattern is fragile: if
`buildProviderHooks` were ever called outside of a prompt turn (e.g. a
background model ping), it would return `undefined` (no `sessionId`), which
is also fine. The real risk is that the reader might expect `sessionId`
inside the closures to track live changes, but it is a snapshot. The
pattern is actually correct; the concern is readability.

**Fix (Nit):** Rename the local to `sessionIdSnapshot` or add a comment
explaining that the snapshot is intentional and is stable for the lifetime
of the LLM round-trip it was built for.

---

### 7. `replay.ts::reconstructMessages` renders extension entries as muted assistant messages — no user-turn counterpart

**Severity: Low**

**File:** `packages/web-acp-agent/src/acp/engine/replay.ts:67–76`

```ts
} else if (entry.kind === 'extension') {
  const payload = entry.payload as ExtensionPayload;
  const text = renderExtensionEntry(payload);
  const tag = {
    command: `extension:${payload.extensionName}:${payload.customType}`,
  };
  messages.push(makeBuiltinAssistantMessage(text, tag));
}
```

Extension entries produce a single assistant message in the transcript,
unlike `'builtin'` entries which produce a user+assistant pair. This is
intentional for `appendEntry` / `sendMessage` (which are extension-internal
signals, not user-initiated prompts). However, the single-entry path means
there is no corresponding user turn in the message history, which could
confuse LLMs that expect alternating user/assistant pairs. If an extension
emits multiple `appendEntry` calls in sequence, the LLM context will have
consecutive assistant messages with no intervening user message.

Whether this is a problem in practice depends on how providers handle
consecutive assistant messages. Some providers reject such sequences.
Anthropic's API merges them. OpenAI's API rejects them.

The spec acknowledges this in `extensions.md` § `pi.session.appendEntry`:
"Live rendering during the emitting turn is intentionally deferred". But it
does not address the LLM-history-fold implication.

**Fix:** Document the limitation in `extensions.md`. For production
correctness, either (a) suppress extension entries from the LLM-visible
history reconstruction entirely (they already ride `_meta` tagged messages
visible to the client but not necessarily to the LLM), or (b) ensure they
are always preceded by a synthetic user message. Option (a) is likely
safest since extension entries are side-effects, not conversational turns.

---

### 8. `getName()` in `extensions-host-bridge.ts` is a synchronous no-op returning `null`

**Severity: Low**

**File:** `packages/web-acp-agent/src/acp/engine/extensions-host-bridge.ts:43–49`

```ts
getName(_sessionId: string): string | null {
  // The store is async; the host caches title elsewhere if it
  // needs synchronous access. For now this is best-effort and
  // returns null.
  return null;
},
```

The `SessionBridge.getName` is synchronous by interface contract (returns
`string | null`, not a `Promise`). This is documented as a known limitation.
An extension that calls `pi.session.getName()` immediately after
`pi.session.setName(x)` will receive `null` even though the write succeeded.

This is a footgun for extensions that pattern-match on "set name, read name
back to confirm". The spec (`extensions.md` § `pi.session.getName`) documents
this: "Extensions that care should track what they last wrote." The warning
is present, so the implementation is as-specced, but the `SessionBridge`
interface as declared suggests a contract where `getName` could return a
value. At minimum the JSDoc on the bridge interface should explain why this
returns `null`.

**Fix (Nit):** Add a JSDoc on `SessionBridge.getName` in `registry.ts`
explaining the synchronous limitation and the "track-what-you-wrote" pattern.

---

### 9. `session_start` fires after MCP acquisition but before model resolution — interaction with extension-contributed providers

**Severity: Low**

**File:** `packages/web-acp-agent/src/acp/handlers/session-crud.ts:54–70`

In `handleNewSession`:

```
acquireMcpConnections
refreshAvailableCommands
→ dispatchSessionStart     ← extensions fire here
tryEnsureModels            ← extension provider models merged here
setSessionModel(defaultModelId)
```

An extension registered via `pi.registerProvider` contributes models to
`listProviderModels()`. `ensureModelsLoaded` merges these via
`#mergeExtensionModels`. The ordering is correct: `session_start` runs
before model resolution, so a `session_start` handler could theoretically
call `pi.session.*` to set metadata, but it cannot influence which models
are offered (the model list is built after `session_start`). This is fine
for the current design.

However, a `session_start` handler that queries `pi.volumes.list()` to
select a model dynamically would need to store state and wait for a future
hook — there is no hook for "after model resolution". This is an API
limitation rather than a bug, but warrants a note in `extensions.md`.

**Fix (Nit):** Add a note in `extensions.md` § `session_start` that the
event fires before model resolution, so handlers that need to influence
model selection should use `before_agent_start` (which receives the resolved
model context indirectly via the prompt text) or configure the provider
statically via `pi.registerProvider`.

---

### 10. `dispatchToolCall` passes `input` as a frozen snapshot — in-place mutation spec is undocumented as non-functional on this path

**Severity: Nit**

**File:** `packages/web-acp-agent/src/acp/engine/prompt-driver.ts:192–203`

The spec (`extensions.md` § `tool_call`) says:

> "Mutating `event.input` in place (e.g. rewriting a path argument) is
> allowed but Phase 6 has no e2e for the rewrite path."

The prompt-driver builds the event object in-line:

```ts
const result = await extensions.dispatchToolCall({
  type: 'tool_call',
  sessionId,
  toolName: toolCtx.toolCall.name,
  input: argsRecord,   // argsRecord is a cast of toolCtx.args
});
```

`argsRecord` is `toolCtx.args as Record<string, unknown>` — the same object
that pi-agent-core uses when invoking `tool.execute`. If an extension
mutates `argsRecord` (the `event.input` object), those mutations will affect
the args pi-agent-core passes to the tool's `execute` call. This means
in-place mutation of `event.input` does work — but only because `argsRecord`
is a reference to the validated args object pi-agent-core already holds.
This is an undocumented aliasing dependency. If pi-agent-core ever clones
args between validation and tool execution, in-place mutation would silently
stop working.

**Fix (Nit):** Either document that `event.input` is a live reference to the
validated args object (making in-place mutation explicitly supported), or
clone `argsRecord` before passing it as `event.input` and note that
mutation has no effect (requiring extensions to use the return-value path).
The latter is safer and more explicit.

---

## Checklist assessment

| # | Checklist item | Assessment |
|---|---|---|
| 1 | SessionBridge correctly implements the interface | Pass — bridge methods match the `SessionBridge` interface declared in `registry.ts`; stateless design is sound. |
| 2 | Bridge wired by `AcpAgentAdapter` | Pass — `agent-adapter.ts:70` calls `setSessionBridge` after `AcpSessionRuntime` construction. |
| 3 | All bridge methods delegate correctly | Pass — all five methods delegate to `services.store`. `sendUserMessage` is a documented stub. |
| 4 | Prompt driver hooks called at right points | Mostly pass — ordering is correct (extension commands → built-ins → expansion → input → tools → system prompt → beforeAgentStart → beforeToolCall/afterToolCall). See Finding 2 (input bypass for extension commands). |
| 5 | Error isolation in prompt driver hooks | Pass — all six dispatch calls either swallow errors internally (runner.ts per-handler catch) or return `undefined` on failure. `beforeAgentStart` swallow is in `runner.ts`; `input` similarly; `beforeProviderRequest` and `afterProviderResponse` both catch per-extension. |
| 6 | Session lifecycle correctly manages extensions | Pass — `loadAll` is called at worker boot before `startAgent`; `dispatchSessionStart` fires in both `newSession` and `loadSession` after MCP attach; reload logic is in the registry. |
| 7 | `assembleServices` correctly threads extensions | Pass — both `extensions` and `extensionsWriteFs` are optional fields that flow from `StartAgentOptions` → `assembleServices` → `AcpAdapterServices` correctly. |
| 8 | Replay skips extension callbacks | Pass — `walkEntries` in `handleLoadSession` only provides `notification` and `turn` walkers; `extension` entries are handled by `reconstructMessages` (not re-dispatched to the registry). Extensions are not called during replay. |
| 9 | `StartAgentOptions` correctly typed | Pass — `extensions?: ExtensionRegistry` and `extensionsWriteFs?: ExtensionsWriteFs` are optional; backward compatible. |
| 10 | Inline agent correctly forwards extension tool registrations | Pass — `extensions.listTools()` is called per-turn in `#runTurn`; each tool is wrapped via `bindAbortSignal`; passed to `inline.setModel({ tools })`. |
| 11 | Tool name collisions between extension and bash/MCP tools | Low risk — bash tool is named `bash`; MCP tools use `<server>_<tool>` slugs; extension tools use whatever `pi.registerTool({ name })` provides. No runtime collision check exists. Two extensions registering the same name is handled (last-write-wins with warning in `registry.ts`). bash/MCP vs extension collision is unchecked but cosmetically harmless (last entry in the array passed to pi-agent-core wins). |
| 12 | Stream fn correctly implements provider hooks | Pass — `createStreamFn` receives `getProviderHooks` and wires it to `onPayload`/`onResponse`. See Finding 6 (low-severity readability note). |
| 13 | Builtin dispatch correctly handles `/extension` command | Pass — `buildExtensionsHandle` returns the handle iff `services.extensions` is defined; `/extension` handler in `mcp.ts` (or the extension builtin) delegates cleanly. |
| 14 | `beforeAgentStart` throw stops session | Pass — `runner.ts` catches per-extension `before_agent_start` throws; the error is logged, the next extension's handler still runs, and the driver continues with the (possibly partial) system prompt patch. A single failing extension does not prevent the session from starting. This is the correct behaviour given the fully-trusted model. |
| 15 | `forceToolCall` DEV gate | **Fail** — see Finding 1. The gate is described in the spec but not implemented. |

---

## Overall assessment

The engine integration for M6 is **architecturally sound and correctly
implements** the core extension dispatch chain (session_start,
before_agent_start, input, tool_call, tool_result, before_provider_request,
after_provider_response). Error isolation is consistent — no extension
failure can poison a turn. The `SessionBridge` wiring is clean and stateless.
Replay correctly skips extension callbacks. The `StartAgentOptions` API is
backward compatible.

Two issues warrant action before the next milestone:

1. **Finding 1 (High):** The `forceToolCall` toggle is not DEV-gated in the
   prompt-driver or in `handleSetSessionConfigOption`. The spec explicitly
   promises a `-32004` guard. A production user who somehow persists
   `forceToolCall: true` (e.g. by importing a session file with the toggle
   set) will have every subsequent LLM call forced into tool-call mode.
   This should be fixed before M7.

2. **Finding 4 (Medium):** Extension commands colliding with vault template
   names produce duplicate entries in `available_commands_update` without
   any warning. The client picker will show duplicates. Fix by adding the
   same dedup logic that vault commands use against prompts.

The remaining findings are low-severity documentation gaps and design
considerations that should be tracked in `extensions.md` or `deferred.md`
but do not block M7.
