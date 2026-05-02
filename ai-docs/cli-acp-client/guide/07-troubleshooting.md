# 07. Troubleshooting

## "No model selected. Run /models then /model <id>."

You haven't picked a model yet. Run `/models` to list available
models on the connected host, then `/model <id>`. Built-in commands
(`/info`, `/help`, `/version`, `/copy`, `/mcp`) skip this gate; only
prompts and vault commands require a model.

## "Not authenticated. Run /host <url> then /login first."

Either no host is configured, or the access token expired and
refresh failed. Re-run `/host <url>` — if a refresh token is on
disk and still valid, the CLI will silently rotate; otherwise the
OAuth flow runs again.

## OAuth review URL doesn't load

- Check that `--no-browser` is not silently swallowing the URL —
  some terminals strip ANSI link sequences. Run with
  `CLI_ECHO=1 npm run dev` to mirror everything to stderr.
- Verify the BodhiApp host is reachable (`curl <url>/bodhi/v1/info`).
- The CLI binds the OAuth callback to `localhost`; if your browser
  resolves `localhost` to IPv6 only and BodhiApp's allow-list is
  IPv4 you'll get an `Invalid parameter: redirect_uri` page.

## OSC 52 silent failure

`/copy` succeeds but nothing in the clipboard. Common causes:

- **tmux** — add `set-option -g set-clipboard on` to `~/.tmux.conf`.
- **screen** — does not forward OSC 52; use the print-fallback by
  piping `cli-acp` output (the dispatcher detects non-TTY stdout
  and prints the transcript verbatim).
- **WSL** — install `wsl.exe`-aware terminal (Windows Terminal,
  Alacritty WSL build) and ensure clipboard pass-through is on.
- **macOS Terminal.app** — disabled by default; use iTerm2 or
  enable "Allow OSC 52 clipboard sequences" in the Profiles →
  Advanced.

If your terminal doesn't support OSC 52, use the print-fallback
explicitly: `cli-acp --ci-line-mode | tee /tmp/copy.log`, then run
`/copy` and read the transcript out of the log file.

## `Mount point is already in use: /mnt/cwd`

This is a known limitation of ZenFS as a global singleton — running
two CLI instances against the same `--cwd` will collide. Use a
different `--cwd` for the second instance or stop the first one.

## sqlite "database is locked" / "no such table"

- Concurrent CLIs in the same `$cwd` will fight over the sqlite
  WAL. WAL mode tolerates one writer + many readers; if you need
  truly parallel sessions in one cwd, treat each cwd as a separate
  workspace.
- "no such table" means the migrations haven't run — delete
  `<cwd>/.cli-acp-client/state.db` and restart. Migrations are
  re-applied at boot.

## Bash tool can't see a file I just created

- The bash tool only sees files inside a mounted volume. If you
  wrote to a directory outside `/mnt/cwd`, mount that directory:
  `/volume add /Users/alice/projects/foo foo`.
- The agent recomputes its tool catalog at the start of each
  turn, so a freshly mounted volume becomes visible on the next
  prompt — no restart required.

## "Failed to list features: no active session"

`/feature list` and `/feature <key> on|off` need a session. Send a
prompt first (or `/session new`) to spin one up.

## CLI hangs after `/quit`

The embedded duplex + ZenFS keep async handles alive past the main
async chain. The CLI calls `process.exit(0)` after `runtime.shutdown()`
so this should be invisible — if you see it hang, file a bug with
the output of `kill -SIGUSR1 <pid>` (Node prints async resources).

## "MCP catalog fetch failed"

A 401 means the access token is stale — `/login` again.
A 5xx is BodhiApp's problem; check its logs.
A network error usually means the host went away.

## Resetting

To start from scratch:

```sh
rm -rf .cli-acp-client/
```

That drops the sqlite state, settings JSON, and any persisted
volume mounts.
