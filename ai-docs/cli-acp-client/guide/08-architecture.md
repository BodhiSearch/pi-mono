# 08. Architecture overview

`cli-acp-client` is the second host runtime for
`@bodhiapp/web-acp-agent`. Where `@bodhiapp/web-acp` runs the agent
in a Web Worker behind a `MessageChannel`, this CLI runs the agent
**in-process** behind an in-memory `TransformStream` duplex. Both
ends speak ACP JSON-RPC 2.0 — same wire as the worker case — which
is the proof point that the agent is genuinely transport- and
runtime-neutral.

```
┌────────────────────── cli-acp-client process ─────────────────────┐
│                                                                   │
│   pi-tui editor      ──────►   shell dispatcher                   │
│        │                            │                             │
│        ▼                            ├── known /cmd ──► CLI registry│
│   line input                        └── unknown /cmd or prompt    │
│                                            │                      │
│                                            ▼                      │
│                                   AcpClient (ClientSideConnection)│
│                                            │                      │
│                                  in-memory TransformStream duplex │
│                                            │                      │
│   ┌───────────── @bodhiapp/web-acp-agent ◄─┘                      │
│   │  AcpAgentAdapter                                              │
│   │    PromptTurnDriver                                           │
│   │      built-ins (/help, /info, /copy, /mcp, /version)          │
│   │      bash tool (just-bash + ZenFS)                            │
│   │      McpConnectionPool (StreamableHTTPClientTransport)        │
│   │      VolumeRegistry (ZenFS PassthroughFS for cwd + extras)    │
│   │    SessionStore / FeatureStore / McpToggleStore (sqlite)      │
│   └─────────────────────────────────────────────────────────────  │
│                                                                   │
└───────────────────────────────────────────────────────────────────┘
```

## State stores (sqlite via Drizzle)

| Table | What's in it |
| --- | --- |
| `sessions` | `id`, `title`, `turnCount`, `lastModelId`, timestamps. |
| `entries` | Append-only log of agent events keyed by `(sessionId, seq)`. |
| `features` | Per-session feature flag JSON blob (`bashEnabled`, `forceToolCall`). |
| `mcp_toggles` | Per-session server + tool toggles JSON blob. |
| `kv` | Host-only key/value blob: `requestedMcps`, `lastModelId`, `volumes`. |

The agent owns `sessions` / `entries` / `features` / `mcp_toggles`
through the `web-acp-agent` store interfaces — the host runs the
schema, but the agent reads/writes through the typed APIs.

The `kv` table is host-only; the agent never touches it. It holds
state that's CLI-shaped (the wishlist, the user's model preference,
their saved mounts).

## Streaming state machine

The CLI ports the same `streamingReducer` web-acp uses. A single
long-lived `client.onSessionUpdate` listener at boot routes every
notification through the reducer. Actions:

- `turn-start` — user submitted a prompt;
- `turn-end` — prompt resolved (with a final assistant message);
- `load-start` / `load-end` — `session/load` started / completed;
- `session-update` — every wire notification (chunks, tool calls,
  MCP lifecycle, builtin actions);
- `reset` — auth-loss or `/session delete <active>`.

The reducer owns:

- `messages` (final transcript),
- `streamingMessage` (in-progress assistant chunk),
- `toolCalls` (Map keyed by toolCallId — final state preserved),
- `mcpStates` (per-server lifecycle status),
- `availableCommands` (last `available_commands_update` payload),
- `isReplaying` (true while a `loadSession` is in flight).

The renderer reads from this state machine through the
`StreamController.onStateChange` listener and `getState()`. It
never subscribes to `onSessionUpdate` directly — that contract
keeps history replay correct.

## Builtin action dispatch

The agent emits `_meta.bodhi.builtin.action` envelopes for actions
that need the client to do something (write to clipboard, mutate
sqlite kv). The CLI dispatcher routes:

- `kind: 'copy'` → fetch session, filter `_builtin` turns, render
  markdown, OSC 52 with print-fallback.
- `kind: 'mcp-add'` → push URL into `KV_REQUESTED_MCPS`.
- `kind: 'mcp-remove'` → drop URL from `KV_REQUESTED_MCPS`.

All dispatch happens host-side; the agent never reaches into sqlite
directly.

## Why an in-memory duplex?

The duplex is a `TransformStream<Uint8Array>` pair. The client
half's writable feeds the agent half's readable, and vice versa.
Same shape as the browser host's `MessageChannel`-backed transport,
but stitched in JS rather than handed off to the platform. Three
benefits:

1. **Zero IPC overhead** — every JSON-RPC byte is copied within
   the same V8 heap.
2. **Type-faithful failure modes** — closing the writable surfaces
   as a real stream error on the reader, just like a real socket.
3. **Same boundary as the browser host** — code that runs against
   the duplex provably runs against any byte-stream transport,
   which is the original swappability promise.

## See also

- [Living spec](../../web-acp/specs/cli-acp-client/index.md)
- [Web-acp browser host counterpart](../../web-acp/specs/web-acp-client/index.md)
- [Shared agent runtime](../../web-acp/specs/web-acp-agent/index.md)
- Agent runtime spec: [`packages/web-acp-agent/`](../../../packages/web-acp-agent/)
