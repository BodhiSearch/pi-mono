# M2 — Multi-volume Mount + just-bash Shell Tool

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
methods — a bigger, uglier non-ACP surface than mounting volumes
on the agent directly.

**Where we stay compliant.**

- Tool execution, reporting, and extension-method naming remain
  fully ACP-shaped (see the compliance-at-a-glance table in
  [`index.md`](index.md)).
- `fs/read_text_file` and `fs/write_text_file` are **still
  advertised** on `clientCapabilities.fs`; client handlers read /
  write through the same ZenFS store. The agent's built-in bash
  tool does not use them — they are the **future IDE-integration
  seam** for clients that contribute unsaved editor state or for
  non-web ACP clients that connect to a remote-agent deployment.

**Where we are deferred.** Per-command permission gating
(`session/request_permission` bridge + allow-always persistence)
is carved out of M2 and tracked in
[`deferred.md`](deferred.md). The `bash` tool in M2 runs
commands as-is; the bridge layers on later without reshaping
the tool-call wire.

## What this milestone delivers

The agent can run arbitrary bash over the user's mounted
volumes — `cat`, `ls`, `grep`, `find`, `rg`, `sed`, `jq`,
pipes, redirects, variables, loops. Users mount one or more
real folders via FSA; each lands at a Linux-style
`/mnt/<folder-name>` path with `-1`, `-2`, … collision
suffixes; optional per-volume descriptions are folded into the
system prompt so the LLM knows each mount's purpose. A single
LLM-facing tool (`bash`) replaces the six hand-rolled tools
(`read`, `write`, `edit`, `ls`, `glob`, `grep`) the original
M2 plan enumerated.

Tools exposed to the LLM: **`bash`**. One tool, strictly more
expressive than the six it replaces. External tools (MCP) arrive
in M3; provider-native tools (OpenAI `web_search` etc.) also
land in M3.

Alongside the tool, M2 ships a small generic feature-toggle
surface (`_bodhi/features/list`, `_bodhi/features/set`) with
two initial flags: `bashEnabled` (user-facing, default `true`)
and `forceToolCall` (DEV-only, default `false`, used by e2e
to deterministically drive tool calls). Feature state persists
with the session record.

## Sub-milestones

M2 ships in four slices. Each is independently gate-checkable
(`npm run check` + matching e2e green) and each is allowed to land
as a separate PR.

### M2.1 — Multi-volume mount (FSA + ZenFS + dev seed, worker-side)

**Carries over from the original M0 scope, expanded to
multi-volume.** The main thread still owns the FSA directory-
picker UX; each resulting `FileSystemDirectoryHandle` joins an
array of `VolumeInit` entries and transfers to the worker via
the worker `init` payload, where ZenFS `WebAccess` mounts each
at `/mnt/<name>`.

Deliverables:

- Volumes panel UI on the main thread: add volume, remove
  volume, optional description input. Persist the
  `{ handle, mountName, description? }[]` across reloads
  (IDBFS handle store via `idb-keyval`, re-derived from the
  web-agent pattern).
- Mount-name derivation: `folder-name` base, `-1`, `-2`, …
  collision suffixes when a live mount already uses the base
  name.
- Handle-array transfer to the worker via the worker `init`
  payload (structured-cloned; see
  [`../specs/web-acp/agent.md § agent-worker.ts`](../specs/web-acp/agent.md#agent-workerts)).
- ZenFS `WebAccess` backend mounted at `/mnt/<name>` **inside
  the worker**, one mount per `VolumeInit`.
- In-memory dev seed: `window.__zenfsSeed: VolumeSeed[] =
  Array<{ name, description?, files }>` for Playwright and dev
  loops, mounted when no FSA handles are available. Seed is
  injected into the worker, not the main thread.
- System-prompt composition: the worker appends a
  `Volumes:\n- /mnt/<name> — <description>\n- /mnt/<name2>`
  block to the system prompt so the LLM knows each mount's
  purpose. Mounts without a description render as
  `- /mnt/<name>` only.
- `installVolumes(page, seeds[])` test helper for
  `packages/web-acp/e2e/`, superseding `installVault`.

**Depends on:** M0 shipped, M1 shipped.

**ACP surface touched:** none in M2.1. The mounts come alive
on the worker side; `fs/*` handlers ride alongside the
built-ins in M2.3.

**Gate items:**

- Playwright `installVolumes` seeds multiple folders; the
  volumes panel lists each mount point (the seed reaches the
  worker through init, not by main-thread mount).
- Second folder with the same base name gets a `-1` suffix,
  verified in the panel and in the worker's mount table.
- Volumes survive reload via the persisted FSA handles.
- Follow-up prompt referencing a volume's description is
  answered with description-specific content (system-prompt
  injection working end-to-end).
- `chat.spec.ts` + `sessions-persist.spec.ts` +
  `sessions-resume.spec.ts` still green (the mounts are not
  yet used in the prompt path).

### M2.2 — just-bash integration + single `bash` tool + feature toggles

Deliverables:

- Add `just-bash` as a workspace dependency from npm (pinned
  version, import from `just-bash/browser`). No local
  vendoring.
- Worker-side `VolumeFileSystem` adapter: a class implementing
  just-bash's `IFileSystem` backed by a ZenFS `/mnt/<name>`
  mount. One instance per volume.
- `MountableFs` composition inside the worker: each
  `/mnt/<name>` mounted over its `VolumeFileSystem`;
  `InMemoryFs` base for `/tmp` and `/home/user`; `cwd`
  defaults to the first mounted volume. If no volumes are
  mounted, the `bash` tool is not registered.
- A single `bash` tool registered with `pi-agent-core`'s tool
  registry. Schema:

  - `input`: `{ script: string; cwd?: string; timeout_ms?: number; stdin?: string }`.
  - `output`: `{ stdout: string; stderr: string; exitCode: number; truncated?: boolean }`.
- `AcpAgentAdapter` emits ACP `session/update (tool_call)` with
  `kind: 'execute'` when bash runs; streams sub-command
  progress via `tool_call_update` using just-bash's
  `CommandCollectorPlugin` metadata.
- Output size ceiling (256 KB) with truncation flag; long-
  running scripts honour `AbortSignal` from `session/cancel`.
- Network disabled by default (`curl` unavailable). JavaScript
  (`js-exec`) and Python (`python3`) stay disabled — Node-only
  in just-bash, browser-incompatible anyway.

Generic feature-toggle surface lands here:

- `_bodhi/features/list` (returns `{ features, defaults }`) and
  `_bodhi/features/set` (accepts `{ key, value }`), both
  declared as constants in `acp/methods.ts` per principle 15.
- Session-scoped `features: Record<string, boolean>` slot on
  the session record; persisted + surfaced via
  `bodhi/getSession` on reload.
- Initial flags:
  - `bashEnabled` (default `true`, user-visible). When
    `false`, the `bash` tool is not registered with the tool
    registry for that session's turns.
  - `forceToolCall` (default `false`, writable only in
    `import.meta.env.DEV`). When `true`, the pi-ai prompt
    request carries `tool_choice: 'required'` so the LLM must
    invoke a tool — lets e2e drive tool calls
    deterministically without `page.evaluate`.
- Settings UI exposes each feature with a per-toggle
  `data-testid="feature-toggle-<key>"` and
  `data-test-state="on|off"`. `forceToolCall` is hidden in
  production builds.

**Depends on:** M2.1 (volume mounts), M1 (persistence, so
tool-call debugging is tractable and feature state has a
home).

**ACP surface touched:**

- `session/update (tool_call)` + `tool_call_update` with
  `kind: 'execute'`.
- `session/cancel` wired to the just-bash `AbortSignal`.
- `_bodhi/features/list`, `_bodhi/features/set` (extension
  methods).
- Agent advertises the `bash` tool in its prompt-time tool
  list when `features.bashEnabled === true`; the LLM calls it
  like any other tool.

**Gate items:**

- Real-LLM round-trip: seed a volume, LLM issues
  `bash {"script": "cat /mnt/wiki/README.md"}`, agent
  executes, `stdout` reaches the next LLM turn.
- LLM pipeline: `bash {"script": "ls /mnt/wiki | grep \\.md$ | head -5"}`
  returns a non-empty list.
- Multi-mount reach: `bash {"script": "ls /mnt/wiki /mnt/code"}`
  lists both mounts.
- Cancel: `session/cancel` during a long loop
  (`for i in $(seq 1 100); do sleep 1; done`) stops cleanly.
- Feature gate: toggle `bashEnabled` off; reload; bash tool no
  longer advertised in the LLM's tool list for subsequent
  turns.
- DEV force: toggle `forceToolCall` on in DEV; a benign prompt
  triggers a bash call; production build does not expose the
  toggle.

### M2.3 — `fs/*` client handlers (advertised, not used by built-ins)

**Why we ship this despite the built-in tool not using it.**
Advertising `fs.readTextFile = true` / `fs.writeTextFile =
true` keeps `web-acp` a compliant ACP client. Any ACP-
speaking agent (not just our bash tool) can use these to read
/ write mounted volumes through us. It also gives an IDE
integration a concrete seam — unsaved buffer state bridging —
when someone swaps our worker for a Zed-like agent or an
external extension wants to contribute a tool that uses
`fs/*` directly.

Deliverables:

- Client-side handlers in `AcpClient` for `fs/read_text_file`
  and `fs/write_text_file`, validating the path is under one
  of the mounted `/mnt/<name>` roots (iterate live volumes)
  and reading / writing through the **same ZenFS store** the
  worker mounts. Both sides see the same bytes.
- Path safety: reject paths that escape any `/mnt/<name>`
  (symlink traversal, `..` escape, absolute paths outside the
  mounted set, cross-mount escape).
- Advertise both capabilities in `initialize` response's
  `clientCapabilities.fs`.
- Documented as "future IDE-integration seam, not used by the
  default bash tool" in the
  [`../specs/web-acp/vault.md`](../specs/web-acp/vault.md)
  spec.

**Depends on:** M2.1 (mounts must exist). Independent of
M2.2 — ships standalone if staging needs it.

**ACP surface touched:**

- `fs/read_text_file`, `fs/write_text_file` on the client
  side.
- `clientCapabilities.fs.readTextFile` / `writeTextFile` both
  flip to `true` in `AcpClient.initialize()`.

**Gate items:**

- Unit test: a synthetic ACP agent (test double) calls
  `fs/read_text_file` and gets the same content the built-in
  bash tool sees via `cat`.
- Path-safety unit tests for `..`, symlink escape, absolute
  paths outside the mounted set, cross-mount escape.
- `chat.spec.ts` + M2.1 + M2.2 e2e all still green (no
  regression).

### M2.4 — Polish + M2 exit

Deliverables:

- Import-direction audit: no agent-side code imports from the
  main-thread client (`@/*` or `src/components/` paths).
- Deferred-bridge audit:
  `rg "request_permission|allow_always|bash-classifier"
  packages/web-acp/src/` returns empty.
- Milestone status finalised; next prompt
  (`004-m3-mcp-and-native-tools.md`) drafted.
- Spec index ([`../specs/web-acp/index.md`](../specs/web-acp/index.md))
  lists every new spec (`vault.md`, `tools.md`,
  `features.md`); no dangling links.

## Overall depends on

- **M0.b** — transport + ACP framing (shipped as part of M0).
- **M1** — persistence, so tool-call debugging is tractable and
  feature state has a home.

## Out of scope

- **Per-command permission gating** — carved out to
  [`deferred.md`](deferred.md); re-enters in a post-M2
  milestone kickoff.
- **Allow-always persistence** — same (deferred with the
  bridge).
- ACP `terminal/*` delegation. just-bash is the terminal; the
  agent doesn't need client-side shell execution.
- Tool-call tracing / debugging UI. That's M8 polish.
- Binary file operations via the LLM-facing tool. just-bash
  handles binary files internally (`base64`, `od`, `tar`,
  `gzip`); the LLM sees text responses.
- MCP tools, provider-native tools, and slash commands — all
  M3+.
- `js-exec` / `python3` via just-bash. Node-only in just-bash,
  browser-incompatible. Post-v1 if ever.

## Why this ordering

**Tools before tree** because tool loops amplify every
subsequent surface: MCP tools, commands, extensions, fork —
they all layer on top of the tool loop. Debugging a broken
tool call is painful enough in a flat session; in a forked
session it's worse. Land the tool surface first.

**just-bash before MCP** because the built-in tool catalog
has to exist before external catalogs can sit beside it. MCP
in M3 will register alongside the single `bash` tool; the
registry shape is the same either way.

**Multi-mount up front** because choosing `/mnt/<name>` from
the start avoids a rename migration when a second volume is
added later — the LLM-visible path shape is stable from M2.1
onward.

**Feature toggles in M2.2** because the bash tool is the
first feature that benefits from being switchable, and the
e2e harness needs `forceToolCall` to drive the bash path
deterministically without `page.evaluate`.

**Permission bridge after functional completeness** because
gating destructive commands is a layer over the tool wire, not
a reshape of it. Landing it later lets us observe real LLM
traffic against the bash tool first.

**Agent-owned FS is the structural decision driving this
slice.** It is not a shortcut or a deviation of convenience —
it is forced by just-bash's `IFileSystem` shape, which has
~25 methods vs. ACP's 2. The decision is documented in
[`../steering/02-architecture.md`](../steering/02-architecture.md)
and justified against the remote-agent future in the same
doc. When we eventually ship remote-agent, the mount story
changes (cloud-mounted, user-uploaded, or text-only) — that's
a deployment-level concern, not an M2 concern.
