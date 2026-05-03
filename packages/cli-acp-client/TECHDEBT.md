# cli-acp-client — known tech debt

Living log of issues uncovered by the suite or by exploration that
have not been addressed yet. Each entry: what, where, why it
matters, and a hint at the fix. Add an entry the moment you trip on
something that doesn't fit the milestone you're in.

## ACP 0.21 migration: agent wire surface no longer matches the CLI

**What.** `packages/web-acp-agent/` shipped its M1–M7 ACP 0.21
migration without porting the CLI host. Six wire surfaces the CLI
still depends on were either deleted or repurposed:

| Old shape (CLI still uses) | New shape (agent ships) | Lands at |
| --- | --- | --- |
| `extMethod('bodhi/listModels')` → `BodhiListModelsResponse` | Catalog rides on `NewSessionResponse.models` / `LoadSessionResponse.models` (`SessionModelState`) | M4 |
| `extMethod('bodhi/listSessions')` | `Agent.listSessions()` (stable) | M2 |
| `extMethod('_bodhi/features/list')` / `_bodhi/features/set` | `Agent.setSessionConfigOption({type: 'boolean', value})` + `config_option_update` notification | M3 |
| `extMethod('bodhi/getSession')` (still live, not yet collapsed) | Pre-load round-trip; M5 deferred — see `packages/web-acp/TECHDEBT.md` § "M5 deferred" | M5 (deferred) |
| `prompt(sessionId, text, modelId)` carrying `_meta.bodhi.modelId` | `prompt(sessionId, text)` resolves `currentModelId` from `SessionState`; mutate via `Agent.unstable_setSessionModel` | M4 |
| `_meta.bodhi.mcp` ride on empty `agent_message_chunk` | `extNotification('_bodhi/mcp/state', { sessionId, server, state, error?, tools? })` | M6 |
| `_meta.bodhi.builtin.action` ride on builtin chunk | Tag (`command`) stays on chunk; action moves to `extNotification('_bodhi/builtin/action', { sessionId, command, action })` | M6 |

**Where.**
- `src/acp/client.ts:22-26` — `BODHI_FEATURES_LIST_METHOD`,
  `BODHI_FEATURES_SET_METHOD`, `BODHI_LIST_MODELS_METHOD`,
  `BODHI_LIST_SESSIONS_METHOD` re-exports of constants the agent
  package no longer exports.
- `src/acp/client.ts:84` — `listModels()` calls
  `extMethod(BODHI_LIST_MODELS_METHOD, {})`.
- `src/acp/client.ts:90` — `listSessions()` calls
  `extMethod(BODHI_LIST_SESSIONS_METHOD, {})` instead of the SDK's
  native `listSessions()`.
- `src/acp/client.ts:139` — `listFeatures(sessionId)` calls
  `extMethod(BODHI_FEATURES_LIST_METHOD, ...)`.
- `src/acp/client.ts:148` — `setFeature(sessionId, key, value)`
  calls `extMethod(BODHI_FEATURES_SET_METHOD, ...)`.
- `src/acp/client.ts:prompt()` — still passes
  `_meta: { bodhi: { modelId } }` on every prompt.
- `src/bootstrap.ts:294-302` — post-login `tryRefreshTokens` warm
  path calls `ctx.client.listModels()` to seed the agent's
  in-memory catalog. The agent now seeds it lazily on `newSession`
  / `loadSession` via the injected `LlmProvider.getAvailableModels`,
  so the explicit warm call is unnecessary; without it the next
  prompt triggers the lazy fetch.
- `src/commands/session.ts:52,182` — `/session list` and
  load-session lookup use `client.listSessions()` (the same wrapper
  that calls the deleted ext-method).
- `src/commands/models.ts:16` — `/models` uses
  `client.listModels()`.
- `src/commands/login.ts:83` — post-login warm.
- `src/commands/feature.ts:53,114` — `/feature` list + set uses
  the deleted ext-methods.
- `src/acp/stream-controller.ts` (and `stream-controller.test.ts:88`)
  — reads `_meta.bodhi.mcp` from `agent_message_chunk` notifications
  to render MCP lifecycle status lines. Now empty chunks no longer
  carry that meta; the lifecycle rides on
  `extNotification('_bodhi/mcp/state')` which the dispatcher
  doesn't subscribe to today.
- `src/auth/debug.test.ts:54` — fixture string
  `'No model selected: send session/prompt with _meta.bodhi.modelId'`
  references the old agent-side error message; the agent now
  throws `'No model selected: call session/setModel first'`.
- `src/acp/embedded-host.test.ts:40` — asserts `host.client.listModels()`
  rejects pre-init; the method has been deleted.
- Built-in action dispatch — the CLI's prompt handler reads
  `_meta.bodhi.builtin.action` off the assistant chunk to fire copy
  / mcp-add / mcp-remove client actions. M6 moved that to a
  dedicated `extNotification('_bodhi/builtin/action')` channel.
  The CLI's `ClientSideConnection` handler doesn't implement
  `extNotification`, so actions silently drop.

**Why it matters.** Every CLI e2e spec that exercises models,
session listing, feature toggles, or MCP lifecycle is broken
post-merge. The CLI cannot recover model state on resume, cannot
list persisted sessions through the standard surface, cannot
toggle bash on/off, and silently swallows MCP add / remove
actions. The CLI was deliberately left out of the migration per
the user's "leave broken" direction so the host migration could
ship cleanly; this entry tracks the work needed to bring the CLI
back in line.

**Fix sketch.** Mirror the host changes file-for-file:

1. **`src/acp/client.ts`** — drop the four deleted constant imports.
   Replace `listModels()` body with returning the cached catalog
   from `SessionModelState` (or removing the method entirely;
   models flow into the `AppContext` via session-create/load).
   Replace `listSessions()` with `this.#conn.listSessions({})` and
   map the SDK shape into the CLI's `SessionInfoView`. Add
   `setSessionModel(sessionId, modelId)` calling
   `unstable_setSessionModel`. Drop `listFeatures` and `setFeature`
   in favour of the standard `setSessionConfigOption` flow plus a
   reducer/state slice over `configOptions`. Drop `_meta.bodhi.modelId`
   from `prompt()`.

2. **`src/bootstrap.ts:294-302`** — drop the post-login
   `client.listModels()` warm; the agent lazy-loads on next
   `newSession`. Capture `models` + `configOptions` from
   `NewSessionResponse` / `LoadSessionResponse` into the
   `AppContext`.

3. **`src/commands/{models,session,login}.ts`** — read models from
   `AppContext.models` (populated from the session response),
   read sessions via the new `listSessions()`, drop the warm path
   in login.

4. **`src/commands/feature.ts`** — rewrite over `configOptions` from
   the session response. `listFeatures` becomes a selector;
   `setFeature` calls `client.setSessionConfigOption(sessionId,
   '_bodhi/features/<key>', value)`.

5. **`src/acp/stream-controller.ts`** — register an
   `extNotification` handler on `ClientSideConnection`. Route
   `_bodhi/mcp/state` into the MCP lifecycle slice (the
   stream-controller's existing chip rendering); route
   `_bodhi/builtin/action` into the in-flight action dispatcher
   (copy / mcp-add / mcp-remove) — the CLI's ConfigurableShell
   already has the IDB-equivalent per-mount wishlist.

6. **`src/auth/debug.test.ts:54`** — update fixture error string to
   `'No model selected: call session/setModel first'`.

7. **`src/acp/embedded-host.test.ts:40`** — drop or rewrite. The
   `listModels` rejection assertion was a smoke test that the
   embedded host wires through to the agent; replace with an
   assertion against the new model surface (e.g. `newSession`
   returns models, or `setSessionModel` rejects pre-init).

8. **`src/acp/stream-controller.test.ts:88`** — rewrite the
   `_meta.bodhi.mcp` test against the new `extNotification` path.

The agent already exports the new method names, types, and
discriminator unions from `@bodhiapp/web-acp-agent` —
`BODHI_MCP_STATE_NOTIFICATION_METHOD`,
`BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD`,
`BodhiMcpStateNotificationParams`,
`BodhiBuiltinActionNotificationParams`, the
`BODHI_FEATURE_*_CONFIG_ID` constants — so the CLI's port is a
matter of consuming them.

After the port: re-enable `npm run test:e2e` in
`packages/cli-acp-client/` (currently expected to fail). The
parity guarantee documented in
`ai-docs/web-acp/specs/cli-acp-client/index.md` (the agent code
is byte-identical between the two host runtimes) requires both
hosts to track wire changes together; this entry exists because
that guarantee was temporarily suspended for the M1–M7
migration.

## `buildClientHandler` helper deleted from web-acp; CLI must wire `extNotification` directly

**What.** The dead-code sweep deleted `buildClientHandler` from
`packages/web-acp/src/acp/client.ts` (it only handled
`sessionUpdate` and would have silently dropped every M6
`extNotification`). The browser host hand-rolls its full `Client`
literal in `packages/web-acp/src/acp/runtime.ts` directly. There is
no shared helper to reach for.

**Where.** When porting per the entry above, the CLI's embedded host
(`packages/cli-acp-client/src/acp/embedded-host.ts`) should wire its
own `Client` literal that implements at minimum:

- `sessionUpdate` (already present)
- `extNotification` (missing — required to receive
  `_bodhi/mcp/state` and `_bodhi/builtin/action` notifications)
- `requestPermission` (already present)
- `readTextFile` / `writeTextFile` if the CLI exposes a `$cwd`
  volume (it does today via `PassthroughFS`)

**Why it matters.** The deleted helper was a single-method literal;
it was simpler to inline at the hand-rolled callsite. Don't add the
helper back to `@bodhiapp/web-acp-agent` for the CLI's benefit —
the CLI host has a different surface (TUI permission prompt,
node-native fs) and inlining keeps the two hosts evolving
independently.
