# M3 — MCP + Provider-Native Tools

## ACP compliance header

**Posture.** Thick agent, **agent is the MCP client**. This is the
ACP-canonical posture: `agent-client-protocol/docs/protocol/session-setup.mdx`
and the `mcpServers` field of `session/new` both place MCP
configuration on the client → agent boundary, with the agent
responsible for actually connecting to MCP servers and invoking
their tools. The claude-agent-acp reference implementation
(`/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/claude-agent-acp/src/acp-agent.ts`)
follows the same pattern.

**Provider-native tools** (OpenAI `web_search`, Anthropic
`web_search` / computer-use, etc.) are handled inside the LLM
provider — the agent never dispatches them. They still surface as
standard `session/update (tool_call)` notifications for
observability, which is what ACP prescribes.

## What this milestone delivers

Two things:

1. **MCP catalog extension.** Users configure MCP servers in
   settings (HTTP only for v1 — stdio isn't available in a
   browser). The worker connects to each configured server,
   discovers its tools, and registers them alongside the built-in
   `bash` tool from M2. The LLM calls MCP tools the same way it
   calls `bash`; the agent routes the invocation back to the
   appropriate MCP client.
2. **Provider-native tool passthrough.** When the LLM provider
   offers a native tool (OpenAI `web_search`, for instance) and
   the user enables it, the agent marks the provider call to
   include that tool. Invocations happen inside the provider; the
   agent observes and reports them as `tool_call` +
   `tool_call_update` notifications so the UI renders them the
   same as any other tool.

## Sub-milestones

M3 ships in three slices. Each independently gate-checkable.

### M3.1 — MCP HTTP client (worker-side)

Deliverables:

- Settings UI on the main thread for configuring MCP servers:
  name, URL, auth header template. Stored in app-local storage
  (IndexedDB via `@zenfs/core`).
- Main-thread → worker push of server configurations at session
  boot and on change via a new ACP extension method
  `_bodhi/mcp/setServers` (request, client → agent). Server list
  replaces the worker's current registry; worker reconnects as
  needed.
- Worker-side MCP HTTP client (Streamable HTTP transport per
  MCP spec). Choice: the official `@modelcontextprotocol/sdk`
  browser client if it ships a browser build by implementation
  time; otherwise a minimal hand-rolled HTTP client targeting
  the MCP spec's Streamable HTTP transport.
- Tool discovery: on connect, the worker calls `tools/list`
  against each server and builds a per-server tool descriptor
  map. Tool names are namespaced (`<serverName>__<toolName>`) to
  avoid collisions with the built-in `bash` tool or between
  servers.
- Register discovered tools with `pi-agent-core`'s registry
  alongside `bash`. Agent advertises the combined list to the
  LLM at prompt time.

**ACP surface touched:**

- New extension method `_bodhi/mcp/setServers`
  (client → agent request). Not stable ACP.
- `agentCapabilities.mcpCapabilities.http = true` advertised
  in `initialize` response (stable since ACP 0.5).
- `agentCapabilities.mcpCapabilities.sse = false` — SSE is
  deprecated in favour of Streamable HTTP per the MCP spec
  and the ACP schema.

**Gate items:**

- Register a public HTTP-transport MCP server (e.g. a
  calculator); the worker advertises its tools alongside
  `bash`.
- Disconnect mid-session (server returns 503); the worker
  surfaces a structured error, not a hung prompt.
- Session reload re-establishes MCP connections (server list
  persists; connections do not).

### M3.2 — MCP tool invocation through the unified registry

Deliverables:

- Route the LLM's tool calls: if the tool name matches
  `bash` → just-bash; if it matches `<serverName>__<toolName>` →
  the corresponding MCP client; otherwise structured error.
- MCP invocation wraps `tools/call` against the server, streams
  any server-side progress as `tool_call_update`, reports final
  content as the tool-call result.
- Permission gating for MCP tools uses the same
  `session/request_permission` surface as built-in tools. Default
  policy: prompt on first call per server per session (session-
  scoped allowlist, same pattern as M2.3). Configurable in
  settings.
- MCP-side error envelopes translate into ACP tool-call errors
  with the server's error text preserved.

**ACP surface touched:**

- Existing `session/update (tool_call)` +
  `tool_call_update` + `session/request_permission`. No new
  extension surface.

**Gate items:**

- Real-LLM round-trip: LLM asks "what's 17*23?" → provider
  selects the MCP calculator tool → agent invokes it → result
  streams back → LLM integrates it.
- Mixed turn: one `bash` call and one MCP tool call inside the
  same turn; both land in the transcript as separate
  `tool_call`s.
- Permission bridge: first MCP call prompts; subsequent calls
  in the same session don't (when the user selected
  `allow_always`).

### M3.3 — Provider-native tool passthrough

Deliverables:

- Per-provider capability discovery: `pi-ai` already knows which
  provider supports which native tool. The adapter exposes these
  to the main thread via a new extension method
  `_bodhi/providers/nativeTools` (request, client → agent) so
  settings UI can render them with per-model toggles.
- Settings UI: toggles for enabling / disabling native tools per
  model (default off for v1).
- Toggles persist per session in the session record and rehydrate
  on reload (`bodhi/getSession` gains a `nativeTools` field).
- When a user enables OpenAI `web_search` for a model and runs
  a prompt with that model, the agent passes the corresponding
  tool config to the provider, observes the provider's
  tool-call output events from the SSE stream, and re-emits
  them as ACP `session/update (tool_call)` +
  `tool_call_update` + result — preserving the tool name,
  arguments, and output so the UI renders them natively.
- Permission handling: provider-native tools do not gate via
  `session/request_permission` in v1 — they're provider-
  executed and the provider already shows its own UX. The
  toggle-to-enable acts as the user's consent. Document this
  explicitly in the M3.3 plan.

**ACP surface touched:**

- `_bodhi/providers/nativeTools` (client → agent).
- Existing `session/update (tool_call)` +
  `tool_call_update`. Reported `tool_call.kind` matches the
  native tool category (`search`, `execute`, etc.).

**Gate items:**

- Enable OpenAI `web_search` on a supported model; ask a
  time-sensitive question; assert the `tool_call` notification
  appears with `kind: 'search'` and a `web_search` tool name.
- Disable the toggle; the same question runs without the
  native tool, and no `tool_call` appears.
- Reload mid-session: the native-tool toggle state rehydrates
  correctly.

## Depends on

- **M1** — session persistence so tool calls (built-in, MCP,
  native) survive reload.
- **M2** — the agent-side tool registry exists; MCP tools
  register alongside `bash`. Permission bridge from M2.3
  generalises to MCP.

## Out of scope

- Stdio MCP. Browsers cannot spawn processes; server-side
  remote-agent deployments are where stdio matters, not here.
- MCP SSE transport. Deprecated per the MCP spec; Streamable
  HTTP is the forward path.
- MCP server auth flows beyond static header templates. OAuth
  against MCP servers is post-v1.
- Declaring MCP tools as "safe" without a first-call prompt.
  Principle: unknown external code gets a confirmation by
  default.
- Provider-native tools that require client-side execution
  (e.g. Anthropic computer-use). The browser has no display
  to drive; we log but do not execute.

## Why this ordering

**MCP before commands and extensions** because MCP tools are
themselves a form of extension — adding external capability to
the agent without changing agent code. Getting the tool registry
shape right (built-in + MCP + native, all addressable by name,
all permission-gated via the same ACP surface) before layering
extensions on top means extensions inherit a stable catalog
rather than churning it.

**Provider-native tools ride the same surface as MCP** because
the UI affordance (toggle in settings; `tool_call` observations
in the transcript) is identical. Splitting them would duplicate
the transcript-rendering code.

**HTTP-only for v1** because stdio is meaningless in a browser
worker; we document the limitation and punt stdio to whenever a
remote-agent deployment happens (at which point we can legitimately
spawn stdio servers from the Node-hosted agent).
