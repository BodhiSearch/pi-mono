# engine-split — wire vs engine separation, ACP-invisible

## Headline

The engine-split refactor (`acp/engine/` sub-tree, see
[`../web-acp-vs-coding-agent/engine-split.md`](../web-acp-vs-coding-agent/engine-split.md)
for the full mapping) is **invisible to ACP-compliant clients**.

Same protocol methods. Same notification shapes. Same `_bodhi/*`
extension namespace. Same auth method. Same capabilities. No new wire
verbs, no shape changes to existing ones, no migration required for
any client.

If your client speaks ACP and worked against web-acp before the
refactor, it works after the refactor — bytes-on-the-wire identical.

## Why this matters for the spec

The refactor introduced new internal vocabulary (`engine`, `runtime`,
`driver`, `services`) which a maintainer reading the code will see
before they touch the wire. None of these terms have ACP wire
implications — they exist purely to keep the agent-side
implementation maintainable.

Specifically:

- `AcpAgentAdapter` (the ACP `Agent`-interface implementer) still
  delegates wire methods to internal layers, but its public surface
  matches ACP exactly. A client cannot tell where method bodies live
  inside the worker.
- `AcpSessionRuntime` owns per-session in-worker state (session map,
  MCP pool subscription, vault commands cache). None of this state
  travels on the wire — it's regenerated from `session/load` replay
  + ACP request fields on reconnect.
- `PromptTurnDriver` runs one `session/prompt` turn end-to-end. The
  notifications it emits (`agent_message_chunk`, `tool_call`,
  `tool_call_update`) are byte-identical to what the god-object
  emitted before.
- `engine/builtin-dispatch.ts` — `_meta.bodhi.builtin` envelope on
  the existing `agent_message_chunk` notification, exactly as before
  (M4 phase B contract).
- `engine/ext-methods/*` — each handler maps 1:1 to a `_bodhi/*` ext
  method that already existed.

## Why the split is what makes the wire stay swappable

This connects to a structural property the steering doc cares about:
the ACP wire is a swappable transport (steering §3 — transport
swappable). Today we frame ACP JSON-RPC 2.0 over `MessageChannel`
between the host React app and a Web Worker. Tomorrow we may frame
the same protocol over HTTP/SSE for a remote-agent deployment.

The wire/engine split is what makes that future cheap. When the
HTTP/SSE transport lands, **nothing in `acp/engine/` moves**. The
engine layer talks to the conn-side `AgentSideConnection` via the
ACP SDK's abstract surface; whether that connection rides over a
`MessagePort` or an HTTP request body is the SDK's problem, not the
engine's. Only `agent-worker.ts` (the wire shim's bootstrap) gets
replaced with an HTTP entry point.

This was structurally true *before* the refactor too — the
`Agent`-interface contract abstracted it — but in practice the
god-object had grown to read directly from worker globals (`crypto`,
`__WEB_ACP_DEV__`) and to assume single-process state ownership.
Pulling those reads into clearly-scoped engine layers makes the
"transport-agnostic" claim auditable.

## Compliance posture

Per [`../milestones/index.md`](../milestones/index.md)'s "ACP
compliance at a glance" table, web-acp is compliant on tool
execution, tool reporting, MCP, slash commands, extension methods,
and session fork; divergent (with documentation) on filesystem
delegation; deferred on permission and provider-native tools. The
engine-split refactor changes none of these compliance positions.
The only spec-relevant doc edits are file:line references
re-pointing into the new sub-tree.

## Cross-references

- coding-agent comparison: [`../web-acp-vs-coding-agent/engine-split.md`](../web-acp-vs-coding-agent/engine-split.md)
- Layer cake: [`../steering/02-architecture.md`](../steering/02-architecture.md)
- Transport swappability principle: [`../steering/04-principles.md`](../steering/04-principles.md) § 3
- Compliance table: [`../milestones/index.md`](../milestones/index.md) § "ACP compliance at a glance"
