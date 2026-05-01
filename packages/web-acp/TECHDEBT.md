# web-acp — known tech debt

Living log of issues uncovered by the suite or by exploration that
have not been addressed yet. Each entry: what, where, why it
matters, and a hint at the fix. Add an entry the moment you trip on
something — leaving it implicit always costs more later.

## MCP per-server toggle off→on after `/mcp add` re-auth doesn't disconnect the pool

**What.** When the user adds an MCP server via the `/mcp add <url>`
chat command (which triggers OAuth re-auth), the `/mcp add` flow
leaves multiple ACP sessions referencing the same worker MCP pool
entry — at minimum the session that handled the `/mcp` and `/mcp add`
built-ins, plus any session auto-created by the
`currentSessionId == null` useEffect during re-auth. Toggling the
server **off** in the active session issues `session/load` with
`mcpServers=[]` for *that one session*, but the worker pool's
refcount is still ≥1 from the other sessions, so the row stays in
the `connected` state.

**Where.** Worker pool refcounting around `setMcpToggle` →
`session/load`. Test surface that surfaces the issue: previously
covered by `mcp-toggles.spec.ts`, removed in the e2e Phase 2
consolidation. The new `mcp.spec.ts` documents the gap and skips
the toggle-cycle assertion.

**Why it matters.** A user who adds an MCP via the chat command
and then tries to disable it for a single session can't — the toggle
appears to do nothing. The old `mcp-toggles.spec.ts` only worked
because `installRequestedMcps` seeded the requested-MCPs IDB list
*before* login, so the test session was the sole reference holder.

**Fix sketch.** Either (a) make `setMcpToggle(server, false)` issue
an explicit pool-release on the worker side independent of session
refcount, or (b) make the `/mcp add` re-auth path land on a single
canonical session instead of fragmenting across the pre-re-auth
session + auto-create + the in-flight built-in.

## MCP per-tool toggle does not round-trip across reload after `/mcp add`

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

**Fix sketch.** Audit `getSession`/`loadSession` snapshot serialisation
on the worker side for the `/mcp add` lineage of sessions; specifically
verify the `mcpToggles` field in the snapshot is being persisted at
the moment of `_bodhi/mcp/toggles/set` (not just held in memory).
