# `protected-paths`

Refuses any `bash` tool call whose script touches `.env`, `.git/`,
or `node_modules/`. Demonstrates Phase 6 of the M6 Extensions
plan: `pi.on('tool_call', ...)` returning `{ block: true, reason }`
to short-circuit the call before pi-agent-core executes the tool.

## Origin

Ported from
`packages/coding-agent/examples/extensions/protected-paths.ts`.

## Diff vs upstream

- Upstream watches the `write` and `edit` tools; web-acp ships
  only `bash` + MCP tools, so this port pivots to scanning the
  `bash` tool's `script` argument for path fragments. MCP tools
  could be added with a per-tool branch, but Phase 6 keeps the
  surface narrow.
- Drops `ctx.ui.notify` (no UI surface in M6). The block reason
  is sent back as the tool's error result; the host's tool-call
  bubble surfaces it.

## What it demonstrates

- `tool_call` runs **before** the tool's `execute` body. Returning
  `{ block: true, reason }` makes pi-agent-core synthesize an
  error tool result with the reason text — the LLM sees the
  refusal and adapts.
- The first `block` short-circuits the chain, so this extension
  must run before any sibling that depends on the same tool
  invocation. Load order is alphabetical (`pirate` then
  `protected-paths` then `redact-secrets`).
- Browser e2e (`extensions.spec.ts`) prompts the LLM to write a
  `.env` file via bash; the test asserts the bash bubble exits
  in `failed` state and the assistant reply mentions the
  refusal.
