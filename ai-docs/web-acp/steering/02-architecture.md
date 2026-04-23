# Architecture — web-acp

## The layer cake

```
┌──────────────────────────────────────────────────────────────────┐
│  Host app (React, main thread)                                   │
│  ├─ <WebAcpProvider>                                             │
│  ├─ useAcp() — session state, stream events, sendPrompt, cancel  │
│  ├─ ACP client — renders session/update, serves fs/*,            │
│  │   mediates permission prompts                                 │
│  └─ ZenFS /vault mount (FSA handle), /sessions, /extensions      │
├──────────────────────────────────────────────────────────────────┤
│  Transport boundary (SWAPPABLE — ACP JSON-RPC 2.0)               │
│  v1 default:   MessageChannel  (main ↔ Worker)                   │
│  future:       HTTP/SSE, WebSocket  (main ↔ remote agent)        │
│  constraint:   framing code has zero MessagePort/Worker refs     │
├──────────────────────────────────────────────────────────────────┤
│  ACP agent runtime                                               │
│  ├─ Session loop — prompt → tool_call loop → turn_end            │
│  ├─ Tool execution — requests fs/* back to client for vault I/O  │
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

## ZenFS mount layout

Reusing web-agent's mount structure because the concurrency reasoning
still holds. What changes: `/vault` reads and writes done by agent
tools are **proxied via ACP `fs/*` requests**, not via a second
MessageChannel tunnel.

### `/vault` — user's local folder

- Backend: `@zenfs/dom` `WebAccess` wrapping a
  `FileSystemDirectoryHandle` from `window.showDirectoryPicker()`.
- Handle persisted in IndexedDB via `idb-keyval`.
- On every load: read handle → `requestPermission({ mode: 'readwrite' })`
  → mount at `/vault`.
- Tools never touch ZenFS directly. They issue ACP `fs/read_text_file`
  / `fs/write_text_file` requests; the client serves them against
  `/vault`.

### `/sessions` and `/extensions` — app-owned

- Backend: `@zenfs/core` IndexedDB.
- Not exposed to the agent via ACP `fs/*`. App-local, client-side only.
- `/sessions` — `messages.jsonl`, `meta.json` per session.
- `/extensions` — late-milestone; layout TBD from the extension re-entry.

### Why IndexedDB, not OPFS

Unchanged from web-agent's rationale:

- OPFS does not serialise writes across tabs; concurrent writes
  corrupt state silently.
- IndexedDB transactions abort atomically, multi-tab-safe.
- Perf delta is negligible at our scale (session metadata is small).

Binding. If a proposal reaches for OPFS, the answer is no without
a new decision entry explaining what changed.

## Filesystem delegation via ACP `fs/*`

This is the structural win over web-agent's dual-MessageChannel
tunnel.

- Agent wants to read `/vault/foo.ts`. It emits ACP `fs/read_text_file`
  with the path.
- Client receives the request, validates the path is under `/vault`,
  reads it via ZenFS, returns the content in the ACP response.
- Same for `fs/write_text_file`. Client validates + writes + ACKs.
- Denied paths (`/sessions/*`, `/extensions/*`) return a structured
  ACP error; the agent handles it like any other tool error.

The client is the vault's gatekeeper. The agent never sees ZenFS.

## Permission flow

ACP's `tool_call` protocol carries permission/confirmation
primitives. For destructive tools (write, edit) the agent emits a
`tool_call` with pending state; the client prompts the user via UI;
the user allow/deny flows back; the agent continues or errors.

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
