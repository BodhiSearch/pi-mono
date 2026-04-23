# M2 — Filesystem Tools via ACP `fs/*` Delegation

## What this milestone delivers

The agent can read, write, edit, list, glob, and grep files in the
user's `/vault` — but every vault touch goes through ACP `fs/*`
delegation. The agent never sees ZenFS; the client is the vault's
gatekeeper.

Tools exposed to the LLM: `read`, `write`, `edit`, `ls`, `glob`,
`grep`. Six tools is the proven web-agent v1 surface; we do not
expand it.

## ACP surface touched

- `fs/read_text_file` (agent → client) — primary read primitive.
- `fs/write_text_file` (agent → client) — primary write primitive.
- `tool_call` — the permission / confirmation flow on destructive
  tools (write, edit). User allow/deny flows via ACP back to the
  agent.
- Tool schemas advertised to the LLM — these are agent-side, not
  ACP primitives, but must be declared against whatever schema
  library the ACP agent wraps (likely `@sinclair/typebox` matching
  `pi-agent-core`).

`ls`, `glob`, `grep` are implemented agent-side on top of repeated
`fs/*` primitives, or via a small ACP extension (`_meta` or
namespaced notification) if iterating is too chatty. The plan
decides.

## Depends on

- **M0.b** — transport + ACP framing.
- **M1** — persistence, so debugging tool loops is tractable.

## Out of scope

- `bash` / shell tool. Browsers have no shell. Not in v1.
- ACP `terminal/*` delegation. Same reason.
- Per-tool pre-approval policy UX beyond the M0.a default.
- Tool call tracing / debugging UI. That's M7 polish.

## Why this ordering

Tools after sessions because tool loops multiply turn complexity.
Debugging a broken tool call in an ephemeral session is painful;
the M1 persistence makes it tractable.

ACP `fs/*` delegation is the **structural fix** for web-agent's
dual-MessageChannel ZenFS tunnel. If we keep the vault ops inside
the agent's Worker, we rebuild the same mess. Pushing them out as
ACP requests means the client owns vault access, which is also
what makes a future remote-agent deployment coherent (the backend
agent literally cannot reach the user's disk; `fs/*` is the only
path).
