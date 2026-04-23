# M2 — Filesystem Tools via ACP `fs/*` Delegation

## What this milestone delivers

The agent can read, write, edit, list, glob, and grep files in
the user's `/vault` — but every vault touch goes through ACP
`fs/*` delegation. The agent never sees ZenFS; the client is the
vault's gatekeeper. MCP proxy tools re-enter alongside the
built-in tool surface so external tool catalogs ride the same
ACP boundary.

Tools exposed to the LLM: `read`, `write`, `edit`, `ls`, `glob`,
`grep`. Six built-in tools is the proven web-agent v1 surface;
we do not expand it. External tools arrive through MCP.

## Sub-milestones

M2 ships in three slices. Each is independently gate-checkable
(tests + `npm run check` green) and each is allowed to land as a
separate PR.

### M2.1 — Vault mount (FSA + ZenFS + dev seed)

**Was part of the original M0 scope; deferred out of M0 when the
M0 rework dropped vault plumbing to keep the first ACP pivot
small. See [`m0-foundation.md`](m0-foundation.md).**

Deliverables:

- Directory-picker UI to acquire a `FileSystemDirectoryHandle`;
  persist it across reloads (IDBFS handle store, same pattern
  as `packages/web-agent/`).
- ZenFS `WebAccess` backend mounted at `/vault` on the main
  thread.
- Port-backed VFS channel to the worker (second `MessageChannel`
  transferred inside the `init` payload; see
  [`../specs/web-acp/agent.md § agent-worker.ts`](../specs/web-acp/agent.md#agent-workerts)).
- In-memory dev seed (`InMemoryVaultSeed = {files, name}`) for
  Playwright and dev loops, mounted when no FSA handle is
  available.
- `installVault(page, seed)` test helper for
  `packages/web-acp/e2e/`, carrying the web-agent pattern.

**Depends on:** M0 shipped. No ACP surface change; the vault is
a local main-thread facility at this slice.

**ACP surface touched:** none in M2.1. The vault comes alive;
`fs/*` turns it into an ACP surface in M2.2.

**Gate items:**

- Playwright `installVault` seeds a folder; the UI reflects it.
- Vault survives reload via the persisted FSA handle.
- `chat.spec.ts` still green (the vault is not yet used in the
  prompt path).

### M2.2 — `fs/*` delegation + built-in tools

Deliverables:

- `fs/read_text_file` (agent → client) — primary read primitive.
- `fs/write_text_file` (agent → client) — primary write primitive.
- Main-thread `Client` handler answers both against the ZenFS
  mount from M2.1.
- `tool_call` — permission / confirmation flow on destructive
  tools (write, edit). User allow/deny flows via ACP back to
  the agent.
- Six LLM-callable tools on the agent side: `read`, `write`,
  `edit`, `ls`, `glob`, `grep`. `ls`, `glob`, `grep` are
  implemented agent-side on top of repeated `fs/*` primitives,
  or via a small ACP extension (`_meta` or namespaced
  notification) if iteration is too chatty — the plan decides.
- Tool schemas advertised to the LLM must use whatever schema
  library the adapter wraps (likely `@sinclair/typebox` matching
  `pi-agent-core`).

**Depends on:** M2.1 (vault mount), M1 (persistence, so
debugging tool loops is tractable).

**ACP surface touched:**

- `fs/read_text_file`, `fs/write_text_file`.
- `tool_call` + the permission handshake.
- `clientCapabilities.fs.readTextFile` / `writeTextFile` flip
  from `false` → `true` in `AcpClient.initialize()` — the
  adapter's advertised `agentCapabilities` stays unchanged.

**Gate items:**

- Real-LLM tool round-trip: the agent issues `fs/read_text_file`;
  the client answers; the agent integrates the content into
  its next turn.
- Permission prompt blocks a `write` until the user accepts;
  an explicit deny surfaces a graceful error to the LLM.
- All six tool descriptors declared and exercised in the e2e.

### M2.3 — MCP proxy tools over ACP

**Was removed from the pre-rework web-acp runtime in Phase A of
the M0 rework; re-enters here because MCP is a tool-call
concern and naturally rides the same boundary as the built-in
`fs/*` tools.**

Deliverables:

- Main-thread MCP client registry: user configures MCP servers
  (stdio / HTTP) in settings, the registry holds their tool
  descriptors.
- Descriptor push to the worker: a new ACP extension method
  (working name: `bodhi/setMcpTools`) replaces the bespoke
  `set_mcp_tools` command the old runtime had. The worker
  registers these descriptors as additional `Tool`s on
  `pi-agent-core`'s `Agent`.
- Upcall protocol: the adapter invokes MCP tools via a new
  client-direction call (e.g. `bodhi/toolCall` as a request, or
  an ACP `tool_call` with an `_meta.source: 'mcp'` tag — the
  plan picks). The main thread dispatches to the matching MCP
  client, returns the result or error.
- Error surfacing: structured MCP errors travel as ACP error
  envelopes so the adapter can re-throw them into
  `pi-agent-core`'s tool-loop error path.

**Depends on:** M2.2 (the ACP tool-call surface must be stable
before MCP rides on it).

**ACP surface touched:** at least two new extension methods (or
namespaced notifications). Principle 6 (ACP extensibility before
sub-protocols) applies — the plan evaluates whether upstream
ACP has shaped a native MCP channel by then and prefers that
route if so.

**Gate items:**

- Register a stdio MCP server (e.g. a dev calculator tool),
  see it advertised through the catalog, invoke it from a
  prompt, render the result.
- The adapter's built-in `read/write/...` tools still work
  alongside the MCP tools — one tool catalog, two sources.
- Disconnecting an MCP server during a turn produces a clean
  error, not a hung prompt.

## Overall depends on

- **M0.b** — transport + ACP framing (shipped as part of M0).
- **M1** — persistence, so debugging tool loops is tractable.

## Out of scope

- `bash` / shell tool. Browsers have no shell. Not in v1.
- ACP `terminal/*` delegation. Same reason.
- Per-tool pre-approval policy UX beyond the M2.2 default.
- Tool call tracing / debugging UI. That's M7 polish.
- Non-text file types (binary read/write). M2 is text-only; the
  ACP primitives are `read_text_file` / `write_text_file`.

## Why this ordering

Tools after sessions because tool loops multiply turn
complexity. Debugging a broken tool call in an ephemeral
session is painful; the M1 persistence makes it tractable.

ACP `fs/*` delegation is the **structural fix** for web-agent's
dual-`MessageChannel` ZenFS tunnel. If we keep the vault ops
inside the agent's Worker, we rebuild the same mess. Pushing
them out as ACP requests means the client owns vault access,
which is also what makes a future remote-agent deployment
coherent (the backend agent literally cannot reach the user's
disk; `fs/*` is the only path).

MCP re-enters here (M2.3) rather than with extensions (M6)
because MCP is a **tool catalog extension**, not a **lifecycle
extension**. Both the built-in `fs/*` tools and MCP-provided
tools share the same agent-side tool registry and the same
ACP `tool_call` permission surface; separating them into
different milestones would force a rewrite of the permission
flow later.
