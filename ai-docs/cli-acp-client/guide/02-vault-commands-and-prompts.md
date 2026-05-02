# 02. Prompts, slash commands, vault commands

The CLI accepts three kinds of input. They look similar at the
prompt but are routed very differently.

## Plain prompts

Anything that does **not** start with `/` is a prompt. The CLI sends
it straight to the agent, which streams the LLM response back as
`assistant_message_chunk` notifications. The renderer accumulates
those chunks under a stable id so the final message appears as one
coherent paragraph rather than a sequence of fragments.

```
> Reply with the single word: pong.
[bot] pong
```

Prompts require a model. Run `/models` then `/model <id>` first if
you haven't.

## CLI-shell slash commands

These are handled by the CLI itself — not the agent. They never
touch the LLM and never spawn a session/update notification.

| Command | What it does |
| --- | --- |
| `/host <url>` | Set the BodhiApp host + start OAuth. |
| `/login` / `/logout` | Re-run / drop the OAuth flow. |
| `/models` / `/model <id>` | List registered models / pick one. |
| `/session list\|new\|load <id>\|delete <id>` | Manage agent sessions. |
| `/mcp list\|add <url>\|remove <url>\|on <slug>[:<tools>]\|off <slug>[:<tools>]` | Manage MCP wishlist + per-session toggles. |
| `/volume list\|add <path> [<mountName>]\|remove <mountName>` | Mount / unmount filesystem volumes. |
| `/feature list\|<key> on\|off` | Toggle per-session feature flags. |
| `/help` / `/quit` | Show commands / exit. |

A CLI-shell command never crosses the duplex boundary; the agent
sees nothing.

## Agent-side slash commands (built-ins + vault commands)

Any `/cmd` the CLI does not recognise **falls through** to the
agent. There the dispatcher matches it against:

- **Built-ins** — `/help`, `/version`, `/info`, `/copy`, `/mcp`. The
  agent runs these without consulting the LLM and tags the resulting
  turn with `_meta.bodhi.builtin` so `/copy` can later filter them
  out of the transcript.
- **Vault commands** — files at `<volume>/.commands/<name>.md`. They
  are namespaced by mount: `/cwd:greet alice` runs the
  `<cwd>/.commands/greet.md` template with `<args>` expanded.

The autocomplete picker merges the static CLI-shell list with the
agent's `available_commands_update` payload, so once you've logged
in and a session is open every command appears in suggestions.

## /info vs /session

The CLI owns `/session` (list / new / load / delete). The agent's
old `/session` builtin was renamed to `/info` so they don't collide
— see [`packages/web-acp/TECHDEBT.md`](../../../packages/web-acp/TECHDEBT.md)
for the back-story. The `web-acp` browser host still calls the
builtin `/session` because its embedded agent copy is independent.

## Tagging built-in turns: `_builtin`

Built-in turns ride on `_meta.bodhi.builtin = { command, action? }`.
The streamingReducer copies that tag into the assistant
`AgentMessage` so:

- `/copy` filters the turns when it builds the transcript;
- the `bash`/MCP tool renderer can omit decoration on built-in
  turns;
- future UI surfaces (a "muted" badge, etc.) can find them without
  a heuristic.
