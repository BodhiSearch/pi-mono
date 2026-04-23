# Architecture — web-acp

## The layer cake

```
┌──────────────────────────────────────────────────────────────────┐
│  Host app (React, main thread)                                   │
│  ├─ <WebAcpProvider>                                             │
│  ├─ useAcp() — session state, stream events, sendPrompt, cancel  │
│  ├─ ACP client — renders session/update, serves fs/* as the      │
│  │   IDE-integration seam, mediates permission prompts           │
│  ├─ FSA directory picker UX                                      │
│  └─ ZenFS /sessions, /extensions (app-owned, IndexedDB)          │
├──────────────────────────────────────────────────────────────────┤
│  Transport boundary (SWAPPABLE — ACP JSON-RPC 2.0)               │
│  v1 default:   MessageChannel  (main ↔ Worker)                   │
│  future:       HTTP/SSE, WebSocket  (main ↔ remote agent)        │
│  constraint:   framing code has zero MessagePort/Worker refs     │
├──────────────────────────────────────────────────────────────────┤
│  ACP agent runtime (Web Worker)                                  │
│  ├─ Session loop — prompt → tool_call loop → turn_end            │
│  ├─ Tool execution — built-in bash tool over just-bash +         │
│  │   agent-side MCP client + provider-native tool observation    │
│  ├─ Vault mount — ZenFS WebAccess over transferred FSA handle    │
│  │   wrapped as just-bash IFileSystem                            │
│  └─ Extension host (late milestone)                              │
├──────────────────────────────────────────────────────────────────┤
│  LLM providers via @mariozechner/pi-ai                           │
│  — OpenAI, Anthropic, Bodhi, custom providers (extensions)       │
└──────────────────────────────────────────────────────────────────┘
```

Arrows flow downward between layers. Upward flow is exclusively via
ACP notifications (`session/update`, permission requests, tool-call
announcements).

## Why ACP (and not a bespoke RPC)

web-agent's bespoke `rpc-types.ts` grew shaped by the UI's needs.
Every new UI feature churned the protocol; client and agent
responsibilities blurred; three parallel RPCs accumulated. ACP is
the opposite posture:

- **Stable contract.** JSON-RPC 2.0 envelopes with versioned method
  names. The schema is ground truth, not the UI.
- **Protocol primitives for the hard parts.** Filesystem delegation,
  permission/confirmation, streamed session updates, tool-call
  lifecycle — all first-class, not invented per consumer.
- **Network-shape by construction.** Because ACP is already designed
  for stdio / socket transport, framing it over `MessageChannel`
  today and over HTTP/SSE tomorrow is a transport concern, not a
  protocol concern.

Ground truth:

- `agent-client-protocol/schema/schema.json` — every request,
  response, notification, and error shape. Authoritative over any
  prose doc.
- `agent-client-protocol/schema/schema.unstable.json` — surfaces in
  flight; we pin our usage at M0 and revisit per-milestone.
- `agent-client-protocol/docs/protocol/` — conceptual model (client,
  agent, session, prompt, tool call, permission, fs delegation).
- `svkozak/pi-acp/src/acp/*` — the closest "ACP agent in TypeScript"
  that exists. Node/stdio, not a dependency. We crib the shape of
  `agent.ts`, `session.ts`, `session-store.ts`, `slash-commands.ts`;
  the stdio plumbing does not port.

## The Transport boundary (why it matters)

**Claim:** every ACP message between client and agent is structured-
clone-safe JSON. The framing code knows how to emit and parse
JSON-RPC 2.0 frames; it does not know whether those frames travel
over a `MessagePort`, an HTTP response body, a WebSocket, or a
process pipe.

**Why.** The same ACP agent should run:

- in a Web Worker inside the user's tab (v1 default),
- in a backend Node process fronted by HTTP/SSE (future),
- in a test harness using an in-memory queue (always useful).

If we let the browser transport leak `MessagePort` into the framing,
the remote transport becomes a rewrite. If we build the framing
against a minimal `Transport` abstraction from day one, the remote
transport becomes a new file.

**Consequences.**

- Framing/protocol code imports nothing from `Worker` / `MessagePort` /
  the DOM. Those live in a transport adapter.
- Tool functions don't flow over the wire — their closures are
  non-cloneable anyway. Tool invocations flow as ACP `tool_call`
  events; the agent's tool registry is built at startup on the
  agent side.
- `ReadableStream`, `AsyncIterator`, or a small `Transport { send;
  onMessage; close }` interface — the shape is a decision for the
  M0.b plan; this doc does not pre-commit. See
  `04-principles.md` § "Transport is swappable".

## ACP architectural postures

ACP leaves room for four placements of responsibility across
agent / client for tool execution and filesystem I/O. Naming them
explicitly because the choice drives M2+ and every subsequent
milestone.

- **Variation A — Thick agent, client-delegated FS (ACP canonical).**
  Agent executes all tools; agent implements high-level tools
  (`read`, `write`, `edit`, `ls`, `glob`, `grep`) by composing the
  two ACP FS primitives (`fs/read_text_file`, `fs/write_text_file`)
  back to the client. The client is the vault's gatekeeper.
  Reference: [`agentclientprotocol/claude-agent-acp/src/acp-agent.ts`](/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/claude-agent-acp/src/acp-agent.ts).
  Best when the FS needs are small (text files only, editor
  integration).

- **Variation B — Thick agent, agent-owned FS.** Agent executes
  all tools *and* owns the filesystem directly; `fs/*` is either
  not used or advertised as an optional IDE-integration seam.
  Best when the agent's tool surface requires a rich FS interface
  that ACP's two-primitive `fs/*` cannot carry (e.g. a full
  shell sandbox like just-bash).

- **Variation C — Thin agent, client-executed tools.** Client
  implements tools; agent asks the client to invoke them via
  extension methods. Anti-pattern for ACP: the spec puts tool
  execution on the agent and the client on the rendering side.
  Listed for completeness.

- **Variation D — Hybrid (client-as-MCP-server).** Client runs a
  local MCP server; agent connects to it as an MCP client to
  reach client-local capabilities. Viable for specific cases
  (screen capture, clipboard) but not for bulk FS access because
  MCP round-trips are too chatty for a shell tool.

**Chosen posture for web-acp: Variation B (agent-owned FS).**
Driver: [just-bash integration](#just-bash-integration) below —
its `IFileSystem` has ~25 methods; ACP `fs/*` has 2. `fs/*` is
still advertised for future IDE integration; the default bash
tool does not use it. The divergence is documented in the
compliance-at-a-glance table at
[`../milestones/index.md`](../milestones/index.md).

## just-bash integration

[`vercel-labs/just-bash`](/Users/amir36/Documents/workspace/src/github.com/vercel-labs/just-bash)
is our LLM-facing tool surface from M2 onward. It provides a
browser-native virtual bash environment with an in-memory VFS and
command coverage that spans the six hand-rolled tools the
original plan enumerated (`read`, `write`, `edit`, `ls`, `glob`,
`grep`) plus pipes, redirects, `jq`, `rg`, `sed`, `awk`, `find`,
and scripting.

- **Single LLM-facing tool: `bash`.** Replaces the six hand-rolled
  tools with one strictly-richer surface.
- **Mounted in the worker.** `MountableFs` composes `/vault`
  (over a ZenFS-backed `IFileSystem` adapter) with `/tmp` +
  `/home/user` (`InMemoryFs` base). `cwd` defaults to `/vault`.
- **Vault FSA handle transferred to the worker at init** via a
  second `MessageChannel` inside the worker `init` payload. The
  main thread keeps a reference too — but the default bash tool
  never round-trips through it.
- **Permission gating** via a `BashTransformPipeline` plugin that
  classifies each script's commands at parse time (allow-list /
  confirm-list / deny-by-default) and bridges the confirm-list
  to ACP `session/request_permission`. See
  [`../milestones/m2-tools.md`](../milestones/m2-tools.md) § M2.3.
- **`fs/*` advertised, not used by built-ins.** Client handlers
  implemented against the same ZenFS store so any ACP-compliant
  agent can still read / write the vault through us. The default
  bash tool does not use `fs/*`.

The structural argument against routing bash through `fs/*`:
just-bash's `IFileSystem` interface
([`/Users/amir36/Documents/workspace/src/github.com/vercel-labs/just-bash/src/fs/interface.ts`](/Users/amir36/Documents/workspace/src/github.com/vercel-labs/just-bash/src/fs/interface.ts))
requires `readdir`, `stat`, `mkdir`, `rm`, `cp`, `mv`, `symlink`,
`chmod`, `lstat`, `readlink`, `realpath`, `utimes`, etc. — 25
methods total. Transporting it over ACP would require ~12
custom `_bodhi/fs/*` extension methods. Compared to that,
mounting the vault on the agent is both *simpler in wire
surface* and *stays closer to ACP* (since ACP's `fs/*` was
designed as an editor-buffer bridge, not a general VFS — see
`agent-client-protocol/docs/protocol/file-system.mdx`).

## ZenFS mount layout

Reusing web-agent's mount structure because the concurrency
reasoning still holds. What changes from the original plan:
`/vault` mounts **inside the worker**, not on the main thread.
The main thread still runs the FSA directory-picker UX.

### `/vault` — user's local folder, worker-mounted

- Backend: `@zenfs/dom` `WebAccess` wrapping a
  `FileSystemDirectoryHandle` from `window.showDirectoryPicker()`.
- Handle acquired on the main thread, persisted in IndexedDB via
  `idb-keyval`, and **transferred to the worker** at init via a
  second `MessageChannel` or structured-clone of the handle
  itself (FSA handles are cloneable).
- The worker mounts at `/vault`, wraps the mount as a just-bash
  `IFileSystem`, and composes it into the `MountableFs` the
  `bash` tool sees.
- The main thread keeps a duplicate handle so the M2.4 `fs/*`
  client handlers can serve IDE-integration reads/writes against
  the same bytes.

### `/sessions` and `/extensions` — main-thread, app-owned

- Backend: `@zenfs/core` IndexedDB on the main thread.
- Not exposed to the agent. `/sessions` is the Dexie store's
  home; `/extensions` hosts extension files that the worker
  reads at session boot via the vault-mounted `IFileSystem`
  (extensions live at `/vault/.bodhi/extensions/` per M5).
- App-local, never crosses the transport boundary.

### Why IndexedDB, not OPFS

Unchanged from web-agent's rationale:

- OPFS does not serialise writes across tabs; concurrent writes
  corrupt state silently.
- IndexedDB transactions abort atomically, multi-tab-safe.
- Perf delta is negligible at our scale (session metadata is small).

Binding. If a proposal reaches for OPFS, the answer is no without
a new decision entry explaining what changed.

## Filesystem posture (post just-bash)

- **Agent owns `/vault` I/O.** The bash tool calls `IFileSystem`
  methods directly against ZenFS inside the worker. Zero ACP
  wire traffic for vault bulk ops.
- **`fs/*` is an advertised seam.** `clientCapabilities.fs.readTextFile`
  and `writeTextFile` both advertise `true` from M2.4 onward.
  Client handlers validate paths and read/write through the same
  ZenFS store. The default bash tool does not use them; external
  ACP agents connecting to the same client can.
- **Remote-agent future.** When the agent eventually runs
  server-side, `/vault` doesn't live in the user's browser.
  Options for that deployment (decided at M8): cloud-mounted
  vault, user-uploaded vault, or text-only mode with `fs/*`
  as the sole FS surface. Do not design for this in M2–M7.

## Permission flow

ACP's `session/request_permission` carries the permission primitive
for destructive actions. The `bash` tool's pre-execution classifier
(M2.3) routes confirm-list commands through this method; the client
prompts the user; the response flows back and the bash script
either executes or returns a `cancelled` tool-call status.

Allow-always scopes are session-scoped and persist with the session
record; settings UI exposes them for reset. MCP tools and
extension-registered tools ride the same permission surface
(first-call prompt per server/extension per session with
`allow_always` memory).

This replaces web-agent's `extension_ui_request` side-channel for
the subset of UI that was really "confirm this action".

## Testing seam

Carried from web-agent unchanged in spirit:

- Playwright cannot click through `showDirectoryPicker` (user-gesture
  gated native dialog).
- Pattern: `e2e/helpers/install-vault.ts` walks a seed directory,
  builds a `Record<"/vault/…", utf8>`, passes it via
  `page.addInitScript` into `window.__zenfsSeed` **before** app code
  runs. A `DEV`-gated `useDevSeedBoot` hook pre-mounts an `InMemory`
  backend populated with the seed before `useDirectoryHandle` has a
  chance to run. Production builds dead-code the branch.
- This is the **only** allowed way to prime filesystem state for
  tests. No `page.evaluate` into ZenFS internals.
- Real-LLM e2e for the M0 path. DOM-witness assertions only; no
  LLM-text assertions. Same discipline as web-agent's e2e.

## Reference sources — what we copy, what we don't

### `packages/coding-agent/` (upstream library)

Copy patterns, do not import:

- Session lifecycle, turn loop, queued steering.
- Extension hook signatures (`ToolCallEvent`, `TurnEndEvent`, …).
- Tool "operations" pattern — schema agnostic to the FS backend.

Why not import: `fs`, `child_process`, jiti, `pi-tui` pull node-only
deps that break browser bundling and would block library extraction.

### `packages/web-agent/` (frozen archive)

Reference-only. Spec material under `ai-docs/specs/worker-agent/` is
the right starting point for "what does session shape look like";
source is the right starting point for "how did we actually
implement X". **Do not copy files across.** Re-derive deliberately.

### `agentclientprotocol/agent-client-protocol`

Cloned locally at
`/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/`.
Ground truth for wire. Schema + reference TS impl (`src/`) are the
authoritative implementation reference. We either consume the
reference library as a dep or vendor a subset — decided at M0.

### `svkozak/pi-acp`

Cloned locally at
`/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/`.
Prior art, not a dep. `src/acp/agent.ts`, `session.ts`,
`session-store.ts`, `slash-commands.ts` are the most instructive
files in either external repo. Treat as MVP reference: the ACP-shaped
pieces port; the stdio plumbing does not.

### `bodhiapps/zenfs-browser`

Still a pattern source for ZenFS mount lifecycle, FSA handle
persistence + `requestPermission` re-grant, dev-seed testing seam.
Not on npm, not a dep.

### `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`

Actual deps. Browser-safe. `pi-ai` gives model adapters and streams;
`pi-agent-core` gives the Agent loop the ACP agent wraps.

## Library extraction (late milestone)

At the end of the roadmap, `packages/web-acp/src/<agent-subpath>/`
gets lifted to its own package. The discipline that makes this
mechanical is principle 3: the agent subtree imports inward only.
Working placeholder name: `@bodhiapp/bodhi-web-acp`. The ACP surface
is the stable external contract.

## Open architectural questions (resolve before the milestone that needs the answer)

- **ACP library choice.** Depend on `@zed-industries/agent-client-protocol`
  (if published) / the reference TS impl, vendor a subset, or hand-roll?
  M0 decision.
- **Schema stability.** Anchor on `schema.json` only, or track
  `schema.unstable.json`? M0–M2 needs drive this.
- **Transport interface shape.** Simple `send/onMessage/close`,
  or a duplex async-iterator pair mirroring ACP's own
  `Connection`? M0.b decision.
- **Permission policy defaults.** Auto-allow read, prompt on write?
  Per-tool? Configurable by consumer? Pre-M0.a wiring decision.
- **Library name.** `@bodhiapp/bodhi-web-acp` is a placeholder.
  Extraction milestone.

Each of these lands as a decision entry when we need the answer.
