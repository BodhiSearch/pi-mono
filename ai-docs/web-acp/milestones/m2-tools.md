# M2 — Vault Mount + just-bash Shell Tool

## ACP compliance header

**Posture.** Thick agent, **agent-owned filesystem**. This is a
deliberate, documented divergence from ACP's canonical
"client-delegated FS" pattern — see
[`../steering/02-architecture.md`](../steering/02-architecture.md) §
"ACP architectural postures" and § "just-bash integration" for the
full reasoning.

**Why divergent.** ACP `fs/*` defines two methods —
`fs/read_text_file` and `fs/write_text_file` — intended as an
editor-buffer bridge (unsaved file state) per
`agent-client-protocol/docs/protocol/file-system.mdx`. The
`vercel-labs/just-bash` `IFileSystem` interface
(`src/fs/interface.ts`) exposes ~25 methods
(`readdir`, `stat`, `mkdir`, `rm`, `cp`, `mv`, `symlink`, `chmod`,
`lstat`, `readlink`, `realpath`, `utimes`, …). Transporting bash
through ACP `fs/*` would require ~12 custom `_bodhi/fs/*` extension
methods — a bigger, uglier non-ACP surface than mounting the vault
on the agent directly.

**Where we stay compliant.**

- Tool execution, reporting, permission, and extension-method naming
  remain fully ACP-shaped (see the compliance-at-a-glance table in
  [`index.md`](index.md)).
- `fs/read_text_file` and `fs/write_text_file` are **still
  advertised** on `clientCapabilities.fs`; client handlers read /
  write through the same ZenFS store. The agent's built-in bash
  tool does not use them — they are the **future IDE-integration
  seam** for clients that contribute unsaved editor state or for
  non-web ACP clients that connect to a remote-agent deployment.

## What this milestone delivers

The agent can run arbitrary bash over the user's `/vault` —
`cat`, `ls`, `grep`, `find`, `rg`, `sed`, `jq`, pipes, redirects,
variables, loops. A single LLM-facing tool (`bash`) replaces the
six hand-rolled tools (`read`, `write`, `edit`, `ls`, `glob`,
`grep`) the original M2 plan enumerated. Destructive operations
(`rm`, `mv`, redirect-writes, `rmdir`) prompt via ACP
`session/request_permission`; read-only operations run without
prompting.

Tools exposed to the LLM: **`bash`**. One tool, strictly more
expressive than the six it replaces. External tools (MCP) arrive
in M3; provider-native tools (OpenAI `web_search` etc.) also
land in M3.

## Sub-milestones

M2 ships in four slices. Each is independently gate-checkable
(`npm run check` + matching e2e green) and each is allowed to land
as a separate PR.

### M2.1 — Vault mount (FSA + ZenFS + dev seed, worker-side)

**Carries over from the original M0 scope. The key structural
change vs. the pre-rework plan: the vault mounts in the
worker, not on the main thread.** The main thread still owns the
FSA *directory picker UX*; the resulting `FileSystemDirectoryHandle`
transfers to the worker via a second `MessageChannel` inside the
worker `init` payload, where ZenFS `WebAccess` mounts it.

Deliverables:

- Directory-picker UI on the main thread to acquire a
  `FileSystemDirectoryHandle`; persist it across reloads
  (IDBFS handle store, same pattern as `packages/web-agent/`).
- Handle transfer to the worker via a second `MessageChannel`
  inside the `init` payload (see
  [`../specs/web-acp/agent.md § agent-worker.ts`](../specs/web-acp/agent.md#agent-workerts)).
- ZenFS `WebAccess` backend mounted at `/vault` **inside the
  worker**.
- In-memory dev seed (`InMemoryVaultSeed = {files, name}`) for
  Playwright and dev loops, mounted when no FSA handle is
  available. Seed is injected into the worker, not the main
  thread.
- `installVault(page, seed)` test helper for
  `packages/web-acp/e2e/`, carrying the web-agent pattern
  (`page.addInitScript` → `window.__zenfsSeed` → seed forwarded
  into worker boot).

**Depends on:** M0 shipped, M1 shipped.

**ACP surface touched:** none in M2.1. The vault comes alive on
the worker side; `fs/*` handlers ride alongside the built-ins in
M2.4.

**Gate items:**

- Playwright `installVault` seeds a folder; the UI reflects it
  (the seed reaches the worker through init, not by main-thread
  mount).
- Vault survives reload via the persisted FSA handle.
- `chat.spec.ts` + `sessions-persist.spec.ts` +
  `sessions-resume.spec.ts` still green (the vault is not yet
  used in the prompt path).

### M2.2 — just-bash integration + single `bash` tool

Deliverables:

- Add `just-bash` as a workspace dependency (use the `browser`
  entry; `src/browser.ts` in the just-bash tree). Version pinned
  exactly per house rules.
- Worker-side `VaultFileSystem` adapter: a class implementing
  just-bash's `IFileSystem` (from
  `/Users/amir36/Documents/workspace/src/github.com/vercel-labs/just-bash/src/fs/interface.ts`)
  backed by the ZenFS `/vault` mount from M2.1.
- `MountableFs` composition inside the worker: `/vault` mounted
  over `VaultFileSystem`; `InMemoryFs` base for `/tmp` and other
  scratch paths; `cwd` defaults to `/vault`.
- A single `bash` tool registered with `pi-agent-core`'s tool
  registry. Schema:

  - `input`: `{ script: string; cwd?: string; timeout_ms?: number; stdin?: string }`.
  - `output`: `{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }`.
- `AcpAgentAdapter` emits ACP `session/update (tool_call)` with
  `kind: 'execute'` when bash runs; streams sub-command progress
  via `tool_call_update` using just-bash's `CommandCollectorPlugin`
  metadata.
- Output size ceiling (e.g. 256 KB) with truncation flag; long-
  running scripts honour `AbortSignal` from `session/cancel`.
- Network disabled by default (`curl` unavailable). JavaScript
  (`js-exec`) and Python (`python3`) stay disabled — Node-only
  in just-bash, browser-incompatible anyway.

**Depends on:** M2.1 (vault mount), M1 (persistence, so tool-call
debugging is tractable).

**ACP surface touched:**

- `session/update (tool_call)` + `tool_call_update` with
  `kind: 'execute'`.
- `session/cancel` wired to the just-bash `AbortSignal`.
- Agent advertises the `bash` tool in its prompt-time tool list;
  the LLM calls it like any other tool.

**Gate items:**

- Real-LLM round-trip: LLM issues `bash {"script": "cat README.md"}`,
  agent executes, `stdout` reaches the next LLM turn.
- LLM pipeline: `bash {"script": "ls /vault | grep \\.md$ | head -5"}`
  returns a non-empty list.
- Cancel: `session/cancel` during a long loop (`for i in $(seq 1
  100); do sleep 1; done`) stops cleanly.

### M2.3 — Permission bridge (just-bash transform → `session/request_permission`)

Deliverables:

- A just-bash `BashTransformPipeline` plugin (see
  `src/transform/` in the just-bash tree) that inspects the parsed
  AST of each script **before execution** and classifies commands:
  - **Allow-list (auto-run):** `cat`, `ls`, `grep`, `rg`, `find`,
    `head`, `tail`, `wc`, `stat`, `file`, `tree`, `diff`, `which`,
    `echo`, `printf`, `basename`, `dirname`, `jq`, `yq`, `sort`,
    `uniq`, `cut`, `awk` (read-only patterns), `sed -n`, pipes,
    `cd`, variable assignments.
  - **Confirm-list (prompt once per script):** `rm`, `rmdir`,
    `mv`, `cp`, `mkdir`, `touch`, `chmod`, `ln`, `sed -i`, any
    redirect write (`>`, `>>`, `2>`), `tee`.
  - **Deny-by-default:** anything the classifier doesn't
    recognise (unknown custom commands). Surface a structured
    tool-call error to the LLM so it can refactor.
- Bridge to ACP: when the classifier finds a confirm-list command,
  the adapter issues `session/request_permission` with a
  `ToolCallUpdate` describing the script excerpt and the specific
  destructive commands detected. The client renders a prompt; the
  user's `allow_once` / `allow_always` / `reject_once` response
  flows back through ACP; the adapter either executes or returns
  a structured `cancelled` tool-call status.
- `allow_always` scopes live in the session's `SessionStore`
  (per-session memory of user choices). No cross-session persistence
  in v1.
- Settings UI on the main thread shows the session's current
  allow-always set and a "reset allowlist" button.

**Depends on:** M2.2 (the bash tool must run end-to-end before the
permission gate has anything to gate).

**ACP surface touched:**

- `session/request_permission` (stable).
- `tool_call.status = 'cancelled'` on user rejection.
- No new extension methods; everything rides the permission
  primitive.

**Gate items:**

- Read-only e2e: LLM runs `bash {"script": "cat README.md"}` →
  no permission prompt.
- Destructive e2e: LLM runs
  `bash {"script": "rm /vault/foo.txt"}` → Playwright asserts the
  permission dialog; reject → tool-call result carries
  `cancelled`; accept-once → the file is gone.
- Allow-always e2e: user selects "allow always" for `rm`; next
  `rm` in the same session does not prompt.
- Deny-by-default e2e: LLM calls an unrecognised custom command;
  tool call returns a structured error describing the unknown
  command class.

### M2.4 — `fs/*` client handlers (advertised, not used by built-ins)

**Why we ship this despite the built-in tool not using it.**
Advertising `fs.readTextFile = true` / `fs.writeTextFile = true`
keeps `web-acp` a compliant ACP client. Any ACP-speaking agent
(not just our bash tool) can use these to read / write the vault
through us. It also gives an IDE integration a concrete seam —
unsaved buffer state bridging — when someone swaps our worker for
a Zed-like agent or an external extension wants to contribute a
tool that uses `fs/*` directly.

Deliverables:

- Client-side handlers in `AcpClient` for `fs/read_text_file` and
  `fs/write_text_file`, validating the path is under `/vault`
  (the worker holds the same invariant through `VaultFileSystem`)
  and reading / writing through the **same ZenFS store** the
  worker mounts. Both sides see the same bytes.
- Path safety: reject paths that escape `/vault` (symlink
  traversal, `..` escape, absolute paths outside `/vault`).
- Advertise both capabilities in `initialize` response's
  `clientCapabilities.fs`.
- Documented as "future IDE-integration seam, not used by the
  default bash tool" in the new
  [`../specs/web-acp/vault.md`](../specs/web-acp/vault.md) spec
  written in this slice.

**Depends on:** M2.1 (vault mount must exist). Independent of
M2.2 / M2.3 — ships standalone if staging needs it.

**ACP surface touched:**

- `fs/read_text_file`, `fs/write_text_file` on the client side.
- `clientCapabilities.fs.readTextFile` / `writeTextFile` both
  flip to `true` in `AcpClient.initialize()`.

**Gate items:**

- Unit test: a synthetic ACP agent (test double) calls
  `fs/read_text_file` and gets the same content the built-in
  bash tool sees via `cat`.
- Path-safety unit tests for `..`, symlink escape, absolute
  paths outside `/vault`.
- `chat.spec.ts` + M2.2 + M2.3 e2e all still green (no
  regression).

## Overall depends on

- **M0.b** — transport + ACP framing (shipped as part of M0).
- **M1** — persistence, so tool-call debugging is tractable and
  allow-always scopes have a home.

## Out of scope

- ACP `terminal/*` delegation. just-bash is the terminal; the
  agent doesn't need client-side shell execution.
- Per-command pre-approval UX beyond the M2.3 allow-list /
  confirm-list / deny-by-default triad.
- Tool-call tracing / debugging UI. That's M8 polish.
- Binary file operations via the LLM-facing tool. just-bash
  handles binary files internally (`base64`, `od`, `tar`,
  `gzip`); the LLM sees text responses.
- MCP tools, provider-native tools, and slash commands — all M3+.
- `js-exec` / `python3` via just-bash. Node-only in just-bash,
  browser-incompatible. Post-v1 if ever.

## Why this ordering

**Tools before tree** because tool loops amplify every subsequent
surface: MCP tools, commands, extensions, fork — they all layer on
top of the tool loop. Debugging a broken tool call is painful
enough in a flat session; in a forked session it's worse. Land the
tool surface first.

**just-bash before MCP** because the built-in tool catalog has to
exist before external catalogs can sit beside it. MCP in M3 will
register alongside the single `bash` tool; the registry shape is
the same either way.

**Agent-owned FS is the structural decision driving this slice.**
It is not a shortcut or a deviation of convenience — it is forced
by just-bash's `IFileSystem` shape, which has ~25 methods vs.
ACP's 2. The decision is documented in
[`../steering/02-architecture.md`](../steering/02-architecture.md)
and justified against the remote-agent future in the same doc.
When we eventually ship remote-agent, the vault story changes
(cloud-mounted, user-uploaded, or text-only) — that's a deployment-
level concern, not an M2 concern.
