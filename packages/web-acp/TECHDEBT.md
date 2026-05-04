# web-acp — known tech debt

Living log of issues uncovered by the suite or by exploration that
have not been addressed yet. Each entry: what, where, why it
matters, and a hint at the fix. Add an entry the moment you trip on
something — leaving it implicit always costs more later.

## Builtin name divergence: web-acp keeps `/session`, web-acp-agent renamed to `/info`

**What.** As part of the cli-acp-client parity bridge the agent
runtime in `@bodhiapp/web-acp-agent` renamed its built-in slash
command from `/session` to `/info` so the CLI host's
session-management slash command (`/session list|new|load|delete`)
no longer collides with the agent-introspection built-in. web-acp
was intentionally left untouched in that round; its embedded copy
of the same command set still publishes `/session` because web-acp
maintains its own copy of the builtins under
`packages/web-acp/src/agent/commands/builtins/` rather than
importing from `@bodhiapp/web-acp-agent`.

**Where.**
- `packages/web-acp/src/agent/commands/builtins/session.ts`
  (still exports `sessionCommand` with `name: "session"`)
- `packages/web-acp/src/agent/commands/builtins/index.ts:5`
  imports `sessionCommand`
- `packages/web-acp/src/acp/agent-adapter.test.ts:285`
  asserts `['copy', 'help', 'mcp', 'session', 'version']`
- `packages/web-acp/e2e/builtins.spec.ts:53,67`
  type and assert `/session`

**Why it matters.** The two ACP agents now publish divergent
`available_commands_update` payloads. A user moving between the
browser host and the CLI host learns different command names for
the same affordance. Snapshots and integration tests that assume
both agents publish the same builtin list will diverge.

**Fix sketch.** When this is addressed, mirror the rename in
web-acp: `session.ts` → `info.ts`, update
`BUILTIN_COMMANDS`, the `agent-adapter.test.ts` assertion, and
the e2e suite. Because web-acp persists `_builtin: { command }`
metadata in IndexedDB on every reply, also bump the schema version
or write a migration so historical `/session` reply rows continue
to render with the muted-builtin badge.

## ~~MCP per-server toggle off→on after `/mcp add` re-auth doesn't disconnect the pool~~ — fixed (Phase 7, reviews-2)

Resolved by the explicit-release path in
[`packages/web-acp-agent/src/acp/engine/ext-methods/mcp-toggles-set.ts`](../web-acp-agent/src/acp/engine/ext-methods/mcp-toggles-set.ts):
when a server-level toggle flips to `false`, the handler now calls
`McpConnectionPool.evictBySlug(serverSlug, deriveSlugFromUrl)`,
which drops every pool entry whose URL slugifies to that slug
regardless of refcount. Forgotten sessions from the `/mcp add`
re-auth lineage no longer keep the connection alive.

**Trade-off (documented).** Other live sessions sharing the same
pool entry will lose their connection until they issue a fresh
`acquire` (typically the next `session/load`). This is acceptable
for the same reason the original review-2 plan recommends option
(a) over option (b): lower invasiveness and no session-lineage
rewrite, at the cost of cross-session connection coupling on
toggle-off. If/when sessions need true per-session pool isolation,
revisit.

## MCP per-tool toggle does not round-trip across reload after `/mcp add` (deferred — Phase 7 split)

**What.** Setting a per-tool toggle (e.g. `get-sum` off, `echo` on)
on a session whose MCP server was added via `/mcp add` and then
reloading the page, then clicking the persisted session row, does
not restore the per-tool toggle state. The tool reads `on` again.

**Where.** Likely in the path between `_bodhi/mcp/toggles/set` writing
to the session record and `loadSession` rehydrating from the stored
snapshot. The old test
(`mcp-toggles.spec.ts`, removed) using `installRequestedMcps` did
preserve toggle state across reload — so the storage write itself
works in *that* path. Something specific to the `/mcp add` re-auth
flow's session shape causes the toggle to be lost on reload.

**Why it matters.** Per-tool selection is a primary user-facing
mechanism for narrowing what the model can call. If it doesn't
survive reload through the `/mcp add` flow, the affordance is
unreliable for any user who configured MCPs via the chat command
rather than via pre-seeded environment.

**Phase 7 status.** Per the reviews-2 plan stop-condition
("If Phase 7 cannot be fixed cleanly within reasonable diff, ship
the explicit-release path only and split the per-tool round-trip
into a follow-up branch"), the per-tool round-trip is deferred. The
Dexie store *does* persist the per-tool patch on every
`_bodhi/mcp/toggles/set` (verified in
`mcp-toggle-store.ts:setTool` — `db.mcpToggles.put(next)` with the
new tool map). The remaining bug is on the load side: the reloaded
session row whose lineage came from `/mcp add` does not surface
those toggles back to the host. Reproducing it requires the live
OAuth re-auth flow, which the e2e suite covers via
`tools-and-volumes.spec.ts` for the bash toggle but not for MCP
per-tool toggles.

**Fix sketch.** Audit `getSession`/`loadSession` snapshot serialisation
on the worker side for the `/mcp add` lineage of sessions; specifically
verify the `mcpToggles` field on the LOADED session matches what the
store returns, and that the host's `setMcpToggles(toggles)` call in
`useAcpSession.loadSession` actually sees the per-tool patch (not
just the server-level patch).

## ~~`Agent.listSessions` returns the full list~~ — fixed (post-2026-05-04 sweep)

Cursor pagination shipped. Cursor encoding is base64(`page=N&per_page=10&sort_by=updated_at&sort_seq=desc`); see `packages/web-acp-agent/src/acp/handlers/list-sessions-cursor.ts`. `SessionStore` grew `listSummariesPage({page, perPage}): {rows, total}` (Dexie + in-memory impls). Host's `AcpClient.listSessions(cursor?)` returns `{sessions, nextCursor}`; `useAcpSession` exposes `loadMoreSessions` and `nextSessionsCursor`; `SessionPicker` shows a "Load more" button while `nextCursor !== null`.

## ~~M5 deferred: `bodhi/getSession` round-trip~~ — fixed (post-2026-05-04 sweep)

Migrated to the **envelope-ride** path (Option A from the prior fix-sketch). Agent's `handleLoadSession` calls `reconstructMessages(entries)` (lifted from the deleted `get-session.ts`) and stamps the rebuilt transcript on `LoadSessionResponse._meta.bodhi.messages` alongside the already-present `title` and `mcpToggles`. Host's `useAcpSession.loadSession` reads that field directly — no pre-pass `getSession` round-trip. The `_bodhi/session/get` ext-method, its un-prefixed legacy alias `bodhi/getSession`, the `BodhiGetSessionRequest`/`BodhiGetSessionResponse` types, and the `AcpClient.getSession` host wrapper were all deleted. Server-level MCP toggle filtering also moved agent-side: `handleLoadSession` reads stored toggles before `acquireMcpConnections` and drops disabled servers from the request's `mcpServers` list.

## Future: chunk-stream replay (Option B)

**What.** A purer alternative to the envelope ride above: have the agent emit synthetic `user_message_chunk` + `agent_message_chunk` notifications during `loadSession` replay, and drop the host reducer's `isReplaying` early-return guard. The reducer becomes the single source of truth for transcript reconstruction; `_meta.bodhi.messages` retires.

**Why it matters.** Cleaner ACP-canonical posture — `session/update` notifications already carry the rendered transcript shape, and a replay that emits them folds naturally into the existing reducer arms. Eliminates the `messages: unknown[]` ride on the load response.

**Why not now.** Five non-trivial correctness gates: ordering between `'turn'` rows (which arrive AFTER their constituent notifications) and a synthetic user-message chunk that needs to arrive BEFORE; unique `messageId` selection across replayed turns; per-turn boundary flushes (without one, only the last replayed turn lands in `messages`); cancelled-turn handling (orphan `'notification'` chunks with no closing `'turn'` row leave tool calls stuck on `in_progress`); builtin synthesis (live builtins emit chunks without `messageId`, so synthetic ones need unique ids). Each is solvable but the bundle is medium risk and ~3-5 days of careful work.

**When to revisit.** If/when the reducer needs a deeper refactor anyway (e.g. for true streamed multi-modal content), fold this in. Until then the envelope ride is correct and small.

## model-fallback when `lastModelId` disappears — no e2e harness

**What.** The agent's `loadSession` calls
`#resolveSeededModelId(models, row.lastModelId)` and falls back to
`models[0].id` when the stored `lastModelId` is no longer in the
catalog (e.g. upstream renamed or removed the model). The host then
runs `hydrateFromSessionResponse(...)` and the picker reflects the
fallback. Reachable in production but not exercised by any e2e.

**Where.**
- `packages/web-acp-agent/src/acp/agent-adapter.ts` — `loadSession`
  call site + the `#resolveSeededModelId` helper.
- `packages/web-acp/src/hooks/useAcpModels.ts` —
  `hydrateFromSessionResponse`.
- `packages/web-acp/src/hooks/useAcpSession.ts:loadSession` — call
  site that funnels the agent response into the host hook.

**Why it matters.** Real production scenario when an upstream
provider renames or removes a model the user's last session was
bound to. A regression that drops the fallback would surface as
"no model selected" errors on every load of the affected session.
Agent-side unit coverage of `#resolveSeededModelId` exists; the
gap is purely the host-rendering side.

**Why no e2e today.** Two harness-shaped paths, neither cheap:

1. **IDB seed.** Pre-populate Dexie with a session whose
   `lastModelId` is not in the live catalog. Requires
   `page.evaluate` writes which violates the suite's blackbox
   guardrail (no internal-state pokes from the test runner).
2. **Catalog-mutation harness.** Stand up a route stub or
   env-driven `LlmProvider` mock that omits a model the agent
   previously persisted. Several days of fixture work to extend
   `tests/global-setup.ts` for catalog mutation between two
   navigations of the same browser context.

**Manual recipe (regression trap).** DevTools → Application →
IndexedDB → `bodhi-acp-sessions` → edit a row's `lastModelId` to
a string the catalog doesn't contain → reload → click the row →
verify the picker shows the catalog's first model and a follow-up
prompt succeeds.

**Fix sketch.** Pick path (2) above when there is appetite for a
catalog-mutation harness. Until then, the manual recipe + the
agent-side unit test are the safety net.
