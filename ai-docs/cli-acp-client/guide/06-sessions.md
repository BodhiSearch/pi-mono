# 06. Sessions

A session is the agent's per-turn memory + transcript store. Every
prompt lands in a session (created on demand on the first prompt);
sessions are durable across CLI restarts because they live in the
sqlite database at `<cwd>/.cli-acp-client/state.db`.

## Listing

```
> /session list
Sessions (3):
  bf7a3c1d2e9f… turns=4   Refactor parser
  4e1d…          turns=12  (untitled)
  91ab…          turns=2   Bug repro
```

The id column is truncated to 12 characters for readability; full
ids are printed by `/info` (the agent-side builtin) and emitted in
every `_meta.bodhi.session` envelope.

## Creating

The first prompt creates a session implicitly. Force-create with:

```
> /session new
Created session 91ab23cd4e5f...
```

`session/new` carries a `_meta.bodhi = { requestedMcpUrls, mcpInstances }`
payload so the agent can spin up the right MCP pool from turn 1.

## Loading (replay)

```
> /session load <id>
Loaded session bf7a3c1d2e9f (12 message(s), model=oai/gpt-4.1-nano).
```

`/session load` is multi-step:

1. **Cancel** any in-flight turn on the previous session (auth-loss
   safety).
2. **Snapshot** — fetch `getSession(id)` to get `messages`,
   `lastModelId`, and `mcpToggles`.
3. **Compose** `mcpServers` with the snapshot's per-session toggles
   (so a server you turned off stays off).
4. **Dispatch** `load-start` through the streamingReducer (clears
   transcript), `loadSession(id, ...)` over the duplex, then
   `load-end` with the snapshot's messages.
5. **Restore** `lastModelId` so the next prompt uses the same
   model.

The renderer redraws the transcript from `load-end.messages`. Tool
calls and intermediate `agent_message_chunk` events are *not*
replayed — the agent only stores final messages, not chunks.

## Deleting

```
> /session delete <id>
Deleted session bf7a3c1d…
```

If you delete the active session, the CLI dispatches `reset` so the
transcript clears and the next prompt creates a new session.

## `/info` — the renamed builtin

The agent's old `/session` builtin is now `/info`:

```
> /info
**Session**

- Id: `91ab23cd…`
- Turns: 4
- Messages (LLM-visible): 8
- Model: `oai/gpt-4.1-nano`
- MCP servers (2):
  - `deepwiki`
  - `my-mcp`
```

It bypasses the model gate (built-ins always do), so you can run
`/info` without picking a model first.

## /copy — clipboard transcript

`/copy` builds a markdown transcript of the current session,
**filtering out** any turn tagged with `_builtin`, then writes it
to your clipboard:

- On TTY-capable terminals, the CLI emits an OSC 52 escape
  (`\x1b]52;c;<base64>\x07`). Most modern terminals (iTerm2,
  Kitty, WezTerm, Alacritty with `clipboard.enabled = true`)
  forward this to the system clipboard.
- On non-TTY stdouts (CI, piped output, some tmux sessions
  without `set-option -g set-clipboard on`), the dispatcher prints
  a `Copy from above:` banner followed by the raw transcript so
  you can copy it manually.

If clipboard support fails silently, see
[07-troubleshooting.md](./07-troubleshooting.md).
