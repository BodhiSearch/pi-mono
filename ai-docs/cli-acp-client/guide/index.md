# cli-acp-client user guide

`@bodhiapp/cli-acp-client` is a Node TTY CLI that embeds the ACP
agent (`@bodhiapp/web-acp-agent`) **in-process**, joined to the
client by an in-memory `TransformStream` duplex. It is the second
host runtime — alongside `@bodhiapp/web-acp` (browser) — and exists
to validate the agent's transport-neutrality and to give terminal
users a Claude-Code-shaped experience.

This guide is task-oriented. Each chapter answers a single user
question.

## Table of contents

1. [Install + connect to a BodhiApp host](./01-install-and-host.md)
2. [Prompts, slash commands, vault commands](./02-vault-commands-and-prompts.md)
3. [The `bash` tool and the `/mnt/cwd` mount](./03-bash-tool.md)
4. [MCP servers — add, toggle, remove](./04-mcp.md)
5. [Multi-volume mounts](./05-volumes.md)
6. [Sessions — list, load, replay, `/info`](./06-sessions.md)
7. [Troubleshooting](./07-troubleshooting.md)
8. [Architecture overview](./08-architecture.md)

## Quick start

```sh
npx @bodhiapp/cli-acp-client
> /host https://your-bodhi-host
# follow the printed URL to log in
> /model oai/gpt-4.1-nano
> Hello!
```

## Where state lives

Everything per-cwd:

- `<cwd>/.cli-acp-client/state.db` — sqlite (sessions, features,
  MCP toggles, requested MCPs, persisted volumes, last-model id).
- `<cwd>/.cli-acp-client/settings.json` — auth host URL + tokens.

Delete the directory to reset.

## See also

- Plan: `.cursor/plans/cli-acp-client_↔_web-acp_parity_bridge_*.plan.md`
- Living spec: `ai-docs/web-acp/specs/cli-acp-client/index.md`
- Sister host: `ai-docs/web-acp/specs/web-acp-client/index.md`
- Shared agent runtime: `ai-docs/web-acp/specs/web-acp-agent/index.md`
