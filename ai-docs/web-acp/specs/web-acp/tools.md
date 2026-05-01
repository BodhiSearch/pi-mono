# tools

**Source of truth (agent — `packages/web-acp-agent/src/`):**
`agent/tools/bash-tool.ts` (the LLM-facing `bash` tool, registered
per-turn by `PromptTurnDriver` when the active session has at
least one mounted volume and the `bashEnabled` feature is on),
`agent/tools/volume-filesystem.ts` (the `IFileSystem` adapter
just-bash sees, layered over the active `VolumeRegistry`).

The host runtime contributes only the *backend* to each volume
(FSA-backed in `packages/web-acp/src/runtime/volumes-fsa/`, real-FS
`PassthroughFS` in `packages/cli-acp-client/src/services/cwd-volume.ts`);
the tool path itself is host-agnostic.

**Parent:** [`./index.md`](./index.md)

## Purpose

Phase B of M2 lands the LLM-facing tool surface. The adoption of
[`vercel-labs/just-bash`](https://github.com/vercel-labs/just-bash)
collapses the historical `read/write/edit/ls/glob/grep` six-tool plan
into one strictly-richer `bash` tool. The tool runs inside the agent
worker against a virtual filesystem that aggregates the ZenFS-backed
volumes (`/mnt/<name>`) plus ephemeral `InMemoryFs` scratch spaces
(`/tmp`, `/home/user`).

The design keeps the agent as the owner of the filesystem; the ACP
`fs/*` client methods remain reserved for the M2 Phase C IDE seam and
are **not** called from the tool path.

## `bash` tool contract

The tool is registered per-turn in `AcpAgentAdapter.prompt` whenever
(a) the `bashEnabled` feature is on for the session and (b) at least
one volume is mounted.

- **Name / label:** `bash` / `Bash`.
- **Description:** ships a short explanation of the virtual FS layout
  and output truncation contract so the model can reason about it.
- **Schema (Typebox):**
  ```ts
  {
    script: string,          // required
    cwd?: string,            // defaults to /mnt/<first mount> or /home/user
    timeout_ms?: number,     // hard ceiling, no default
    stdin?: string           // piped into the script
  }
  ```
- **Output:** a single text content block carrying
  `JSON.stringify({ stdout, stderr, exitCode, truncated })`. The
  richer `details` payload mirrors that structure and is surfaced to
  the UI via the ACP `tool_call_update.rawOutput` field.
- **Truncation:** per-stream 256 KiB ceiling
  (`BASH_OUTPUT_BYTE_LIMIT`). A single `truncated: true` flag is set
  whenever either stdout or stderr was trimmed.

## VFS composition

`createBashTool({ registry })` builds a fresh `MountableFs` per
invocation:

| Mount point | Backend | Lifetime |
| --- | --- | --- |
| `/mnt/<name>` | `VolumeFileSystem` over ZenFS (backed by FSA or the InMemory dev seed) | spans the worker's lifetime |
| `/tmp` | `just-bash` `InMemoryFs` | rebuilt per tool call |
| `/home/user` | `just-bash` `InMemoryFs` | rebuilt per tool call |
| everything else | `InMemoryFs` base | rebuilt per tool call |

Per-call rebuilding is deliberate: the scratch mounts must not leak
state across turns, and the volume set is effectively immutable within
a single `bash.exec` because the worker serialises
`volumes/mount` / `volumes/unmount` traffic against the adapter's
per-turn lock.

### `VolumeFileSystem`

`packages/web-acp/src/agent/tools/volume-filesystem.ts` is the adapter
between `just-bash`'s `IFileSystem` and the ZenFS backend mounted at
`/mnt/<name>`. It:

- prepends its `root` (`/mnt/<name>`) to every relative path that
  `MountableFs` hands in, so ZenFS sees absolute paths;
- normalises POSIX path joins (`.` / `..`) before dispatching;
- maps ZenFS `stat` shapes to `just-bash`'s `FsStat`;
- swallows `ENOSYS` for APIs ZenFS doesn't implement (e.g. `chmod`,
  `chown`) so scripts using them get a well-formed error rather than
  a worker crash.

`VolumeFileSystem` is the only file in `web-acp` that reaches into
`@zenfs/core`'s `fs.promises` surface directly; the rest of the agent
treats ZenFS as an opaque dependency of the registry.

## Cancellation

`AcpAgentAdapter` owns a per-turn `AbortController` (`#turnAbort`).
The adapter binds it into every registered tool via `bindAbortSignal`
so that `session/cancel` can short-circuit a running `bash.exec`
without waiting for the LLM stream to settle.

`createBashTool` additionally links the external signal with a
`timeout_ms`-driven inner controller; whichever fires first wins, and
the bash process is aborted with a well-formed `SIGINT`-equivalent
exit code (130). When a turn ends successfully the per-turn signal
aborts anyway during cleanup — the tool has already returned by then,
so this is harmless.

## ACP translation

`AcpAgentAdapter.#forwardEvent` translates `pi-agent-core`
`tool_execution_*` events into ACP `session/update` notifications:

| `pi-agent-core` event | ACP update |
| --- | --- |
| `tool_execution_start` | `session/update { sessionUpdate: 'tool_call', toolCallId, title, kind: 'execute', status: 'in_progress', rawInput }` |
| `tool_execution_update` | `session/update { sessionUpdate: 'tool_call_update', status: 'in_progress', content? }` |
| `tool_execution_end` | `session/update { sessionUpdate: 'tool_call_update', status: 'completed'|'failed', rawOutput, content? }` |

The `title` is the first non-empty line of the script truncated to 80
characters (`bash: <first line>`), matching the ACP field's intended
semantics. `rawOutput` carries the tool's `details` payload verbatim.

## UI surface

The reference client tracks tool-call state in `useAcp`
(`ToolCallView` records indexed by `toolCallId`) and renders a compact
panel per call through `components/chat/BashToolCall.tsx`:

- `data-testid="tool-call-<id>"` + `data-teststate` reflect the
  current status (`pending` / `in_progress` / `completed` / `failed`).
- The first line of `rawInput.script` is echoed as the title.
- When `rawOutput` arrives, the exit code and both streams are
  rendered with a `truncated` flag when applicable.

Coding-agent surfaces can swap `BashToolCall` out for a richer
renderer; the `ToolCallView` record shape is stable for that.

## Testing

- **Unit (vitest):** `volume-filesystem` path-translation edge cases,
  `bash-tool` schema + truncation + timeout behaviour (using the
  `InMemoryFs` base so tests don't need real FSA handles).
- **e2e (Playwright):** `bash-smoke.spec.ts` seeds a volume with the
  dev helper, asks the model to run a scripted `cat`, and asserts on
  `data-testid="tool-call-*"` progressions.

## Related surfaces

M3 adds a second tool family registered alongside `bash`: MCP tools
from the app-wide catalog. The adapter's registration loop treats
both identically (`bindAbortSignal`, `tool_call` / `tool_call_update`,
`tool_execution_end`); the MCP-specific machinery lives at
[`./mcp.md`](./mcp.md).
