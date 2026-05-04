# Tools — `bash` AgentTool + `VolumeFileSystem`

**Source of truth (agent package):** `packages/web-acp-agent/src/agent/tools/`.

## Purpose

The agent registers exactly one LLM-facing tool today —
`bash`. It executes inside a sandboxed `just-bash` browser
shell with mounted volumes (`/mnt/<name>` from
`VolumeRegistry`) and ephemeral scratch (`/tmp`,
`/home/user`). MCP tools are a separate path with their own
adapter ([`mcp.md`](./mcp.md)).

## `createBashTool` — `agent/tools/bash-tool.ts:74`

`createBashTool({ registry })` returns an
`AgentTool<typeof bashInputSchema, BashToolDetails>`. The
function shape matches `pi-agent-core`'s `AgentTool`:

- `name: 'bash'`
- `label: 'Bash'`
- `description` — the multi-line `BASH_DESCRIPTION` constant
  (`:67`) telling the LLM about the mount layout.
- `parameters: bashInputSchema` (TypeBox, `:32`) — one required
  field + three optional:
  - `script: string` (required) — the script body.
  - `cwd?: string` — absolute working directory; defaults to
    `/mnt/<firstVolume>` from `registry.firstMountName()` or
    `/home/user` when no volumes mounted.
  - `timeout_ms?: number` — hard timeout, no default.
  - `stdin?: string` — piped to the script.
- `execute(toolCallId, params, signal?, onUpdate?)` — see
  below.

`execute` flow (`bash-tool.ts:82`):

1. Resolve `cwd` via `resolveCwd(params.cwd, registry)` (`:140`).
2. Build the `MountableFs` via `buildMountable(registry)`
   (`:146`) — one `VolumeFileSystem` per registered volume,
   plus `InMemoryFs` mounts at `/tmp` and `/home/user`. The
   base FS is `InMemoryFs()` so writes outside the mounts land
   in an in-memory shadow rather than crashing.
3. Build a combined abort signal via `linkSignals(signal,
   params.timeout_ms, controllers)` (`:165`) — chains the
   caller's `AbortSignal` (typically the per-turn signal from
   `acp/engine/prompt-driver.ts:bindAbortSignal`) with an
   internal timer.
4. Emit a single empty progress update through `onUpdate`
   (signals "running" to the UI).
5. `await bash.exec(params.script, { signal: combined.signal,
   stdin?, cwd })`. The `combined.signal` is the linked
   controller's signal (from step 3); without it the timeout
   never fires because the original caller-supplied `signal`
   has no timeout wired in.
6. On exception: returns
   `{ stdout: '', stderr: <message>, exitCode: combined.signal.aborted ? 130 : 1 }`
   wrapped in `toolResult`.
7. On success: applies `truncateStreams(stdout, stderr)`
   (`:184`) and returns the truncated streams + `exitCode` +
   `truncated` flag.
8. Cleanup: aborts every linked controller in `finally` to
   tear down the timeout / signal listeners.

`toolResult(details)` (`:133`) wraps the `BashToolDetails`
into the canonical `AgentToolResult` — `content` is a single
text block carrying `JSON.stringify(details)` (so the LLM can
`jq` it), and `details` carries the structured payload for the
host-side renderer.

### Output truncation

`BASH_OUTPUT_BYTE_LIMIT` (256 KiB, `:30`) caps each stream
independently. `truncateStreams` (`:184`) measures via
`TextEncoder().encode(...).byteLength`; truncation slices the
`Uint8Array` to the limit and decodes back via
`TextDecoder('utf-8', { fatal: false })`. The `truncated` flag
is set when *either* stream exceeded; the LLM gets to see the
flag in the JSON payload.

### Cancellation

Two cancellation sources:

- The per-turn abort signal threaded by
  `acp/engine/prompt-driver.ts:bindAbortSignal` so a
  `session/cancel` short-circuits the running shell.
- The internal `params.timeout_ms` timer (when set).

`linkSignals` (`:165`) creates a child `AbortController` that
forwards both. When either fires, `bash.exec`'s
`signal: combined.signal` triggers, the child process
terminates, and the catch branch returns exit code 130 (the
conventional shell SIGINT exit).

## `VolumeFileSystem` — `agent/tools/volume-filesystem.ts`

The just-bash → ZenFS adapter. `MountableFs` dispatches to one
of these per mount; the adapter's job is to translate
relative paths back to absolute ZenFS paths.

`VolumeFileSystem` implements just-bash's `IFileSystem`
interface (21 methods on the adapter). Constructor takes
`root: string` (e.g. `'/mnt/wiki'`) and validates it's
absolute + strips trailing slash. Every method composes
`this.abs(path) = root + path` and delegates to
`zenfs.promises.<op>` (the global VFS the
`ZenfsVolumeRegistry` mounted into).

Full method list: `readFile`, `readFileBuffer`, `writeFile`,
`appendFile`, `exists`, `stat`, `lstat`, `mkdir`, `readdir`,
`readdirWithFileTypes`, `rm`, `cp`, `mv`, `resolvePath`,
`getAllPaths`, `chmod`, `symlink`, `link`, `readlink`,
`realpath`, `utimes`. All path-translating; no logic lives
here beyond the prefix join + buffer ↔ string encoding
helpers (`resolveReadEncoding`, `resolveWriteEncoding`,
`decodeBuffer`, `toUint8Array`, `toNodePayload`).

This is the structural reason the agent owns the filesystem
directly rather than routing through ACP's `fs/*` primitives:
ACP's `fs/read_text_file` + `fs/write_text_file` are a
two-method editor-buffer bridge; just-bash's `IFileSystem` is
a 25-method shell-grade surface. Forcing bash through `fs/*`
would require ~12 custom `_bodhi/fs/*` extension methods —
worse for ACP compliance than mounting the FS on the agent.
See `steering/02-architecture.md` § "ACP architectural
postures".

## `BashToolDetails` — `bash-tool.ts:56`

```ts
interface BashToolDetails {
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
}
```

Surfaced to the host via the `tool_call` / `tool_call_update`
notifications:

- `tool_call.title` is rendered by
  `acp/wire-utils.ts:toolTitle('bash', { script })`:
  `bash: <first line, truncated to 80 chars>`.
- `tool_call_update.content` is built by
  `acp/wire-utils.ts:toToolCallContent` from the
  `result.content` array (one text block carrying the
  JSON-stringified details).
- `tool_call_update.rawOutput` carries `result.details` —
  hosts that want to render the structured payload directly
  read this.

The host's renderer (browser:
`packages/web-acp/src/components/chat/BashToolCall.tsx`)
parses `rawOutput` to render stdout/stderr panes + the exit
code badge + a `truncated` warning.

## ACP wire translation

The bash tool itself is host-agnostic — it speaks
`pi-agent-core`'s `AgentTool` interface. The translation to
ACP `tool_call` / `tool_call_update` events happens in
`acp/engine/prompt-driver.ts:#forwardEvent` (see
[`acp.md`](./acp.md) § engine layer):

| pi-agent-core event | ACP notification |
| --- | --- |
| `tool_execution_start` | `tool_call` (`status: 'in_progress'`, `kind: 'execute'`, `rawInput: args`) |
| `tool_execution_update` | `tool_call_update` (`status: 'in_progress'`, `content?: toToolCallContent(partialResult.content)`) |
| `tool_execution_end` (success) | `tool_call_update` (`status: 'completed'`, `rawOutput: result.details ?? result`, `content?: toToolCallContent(result.content)`) |
| `tool_execution_end` (error) | `tool_call_update` (`status: 'failed'`, `rawOutput`, `content`) |

## Future tool surfaces

The agent registers the bash tool only when
`featureSnapshot.bashEnabled && registry.list().length > 0`.
MCP tools (one `AgentTool` per `<server>__<tool>` pair) come
from `acp/engine/session-runtime.ts:mcpToolsForSession` and
are filtered by per-tool toggles. See [`mcp.md`](./mcp.md).

The current shape supports adding more agent-side tools (e.g.
`web_search`, `read_url`, `compute`) by making them additional
`AgentTool` factories the driver registers per turn. That work
isn't scoped today.

## Cross-references

- Volume registry the bash tool reads:
  [`volumes.md`](./volumes.md).
- `MountableFs` composition reference:
  `vercel-labs/just-bash/src/fs/interface.ts` (the `IFileSystem`
  contract `VolumeFileSystem` implements).
- Engine-layer event translation:
  [`acp.md`](./acp.md) § engine layer.
- Host-side renderer:
  `packages/web-acp/src/components/chat/BashToolCall.tsx`
  (covered in [`../web-acp-client/commands.md`](../web-acp-client/commands.md)).
