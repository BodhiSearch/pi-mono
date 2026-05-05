# claude-rules

Lists every `<mount>/.claude/rules/*.md` file in the system prompt so
the agent can reference them in the bash tool. Demonstrates Phase 3 of
the M6 Extensions plan combined with `pi.fs` + `pi.volumes`.

## Origin

Ported from `packages/coding-agent/examples/extensions/claude-rules.ts`.

## Diff vs upstream

- Replaces `node:fs` + `path.join` with `pi.fs.readdir` /
  `pi.fs.readFile` so the same code runs in ZenFS-backed browsers and
  Node CLI hosts.
- Replaces `ctx.cwd` (Node-only) with `pi.volumes.list()` — the
  extension now scans every mounted volume rather than a single cwd.
- Drops `ctx.ui.notify` (no UI surface in M6).
- Generates absolute `/mnt/<volume>/.claude/rules/...` paths in the
  system prompt so the agent's `bash` tool can `cat` them straight up.

## What it demonstrates

- `session_start` is the right hook for one-shot vault scans —
  filesystem state is captured once per session.
- `before_agent_start` chains cleanly with peers (e.g. `pirate`); the
  rule list is appended on top of any other patches.
- Browser e2e asserts the listed file path text surfaces in the
  assistant's response when prompted to mention the rules.
