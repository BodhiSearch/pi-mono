# 03. The `bash` tool and `/mnt/cwd`

The agent ships a **just-bash** tool — a sandboxed bash interpreter
implemented entirely in TypeScript. It runs against ZenFS, so every
filesystem call (`cat`, `ls`, `head`, `>` redirects, etc.) is
mediated by the volume registry, not the host kernel.

## The `/mnt/cwd` mount

`cli-acp-client` automatically mounts your launch directory at
`/mnt/cwd` via `PassthroughFS`. So:

```
> Run the bash tool with: cat /mnt/cwd/README.md
```

reads `<cwd>/README.md` straight off your disk, streamed back into
the chat.

## Multiple mounts

Add more mounts with [`/volume`](./05-volumes.md):

```
> /volume add /Users/alice/notes notes
Mounted /Users/alice/notes at /mnt/notes.
```

The bash tool sees them all immediately. A new mount is picked up
at the start of the next agent turn — no restart required.

## Toggling the tool

Bash is on by default. To turn it off for the current session:

```
> /feature bashEnabled off
Feature 'bashEnabled' set to off.
```

When off, the agent strips the `bash` tool from its tool catalog
before the next prompt; the LLM physically cannot call it.

## Limitations of just-bash

just-bash is a **subset** of GNU bash — enough to read/write files,
chain pipelines, and run text utilities, but not:

- arbitrary process spawn (no `python3`, no `git`, no compilers);
- network calls (`curl`, `wget`);
- background jobs / `&`;
- signal handling.

Anything stateful that needs a real shell should be wrapped behind
an MCP server instead — see [04-mcp.md](./04-mcp.md).

## Tool-call rendering

The pi-tui renderer pretty-prints bash tool calls:

```
✓ done  bash: ls /mnt/cwd
  $ ls /mnt/cwd
  exit: 0
  stdout:
    README.md
    package.json
    src
```

In `--ci-line-mode` the same data is emitted as a single
`[tool] ...` line so e2e tests can pattern-match deterministically.
