# `hello-tool`

Registers an LLM-callable `hello` tool. When the agent decides to
greet someone, it invokes the tool with `{ name }` and the tool
returns a fixed greeting string. Demonstrates Phase 5 of the M6
Extensions plan: end-to-end `pi.registerTool` plumbing from
factory through `inline.setModel({ tools })` to the `tool_call`
session-update wire.

## Origin

Ported from `packages/coding-agent/examples/extensions/hello.ts`.

## Diff vs upstream

- Upstream imports `Type` from `@mariozechner/pi-ai` and
  `defineTool` from `@mariozechner/pi-coding-agent`. The
  factory-arg-only contract forbids those imports, so this port
  uses `pi.types` (the agent's TypeBox singleton) and inlines
  the tool object literal directly into `pi.registerTool({...})`.
- Description is tightened so the LLM is more likely to invoke
  the tool when the e2e prompt asks for a greeting (the e2e
  treats tool execution itself as the assertion — we want the
  bubble to render).
- Adds a `(from hello-tool extension)` sentinel inside the
  greeting so the e2e can match an unambiguous string.

## What it demonstrates

- `pi.types` returns the agent's `@sinclair/typebox` `Type`
  builder. Schemas built with it round-trip through `inline`
  + `pi-ai`'s `streamSimple` without the extension having to
  import TypeBox itself.
- `pi.registerTool` returns a `Disposable`. The registration
  surfaces on `_bodhi/extensions/list[].capabilities.tools`.
- The prompt-driver merges extension tools into the per-turn
  `tools` array alongside `bash` + MCP tools and wraps each in
  `bindAbortSignal` so `session/cancel` short-circuits in-flight
  executes.
- Browser e2e (`extensions.spec.ts`) prompts the LLM to greet
  someone; the test asserts both that the assistant's reply
  includes the greeting and that a tool-call bubble was
  rendered.
