# `redact-secrets`

Scrubs API-key-shaped substrings from any tool result before the
LLM sees it. Demonstrates Phase 6 of the M6 Extensions plan:
`pi.on('tool_result', ...)` returning a partial patch
(`{ content }`) that pi-agent-core merges into the executed tool
result.

## Origin

Synthesized for Phase 6. The coding-agent repo has no direct
counterpart; the extension exists to validate that
`afterToolCall` plumbing actually rewrites content the LLM
consumes.

## What it demonstrates

- `tool_result` runs **after** the tool's `execute` finishes,
  before the result is folded into the assistant transcript.
- Returning `{ content: [...] }` replaces the tool result's
  content array verbatim; field-by-field merge — `details` and
  `isError` stay untouched unless the patch sets them.
- Patches chain: each handler sees the prior accumulated values,
  so multiple redactors can layer regexes without coordinating.
- Browser e2e (`extensions.spec.ts`) prompts the LLM to print a
  fake API key string from bash; the test asserts the
  `[REDACTED]` sentinel appears in the tool-call bubble (the
  pre-redaction key string never reaches the rendered result).
