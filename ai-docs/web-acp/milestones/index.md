# Milestones — web-acp

Roadmap for shipping `packages/web-acp/` — a browser-native agent
speaking ACP as its internal wire protocol, with a swappable
transport so the same agent can run behind HTTP/SSE for future
remote-agent deployments. Living document.

**Relationship to neighbours.**

- `packages/web-agent/` is the **reference spike, not an ancestor.**
  M0–M8 shipped under that name; we study the specs at
  `ai-docs/specs/worker-agent/` and the e2e patterns at
  `packages/web-agent/e2e/`. We do not import or copy files.
- `svkozak/pi-acp` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/`)
  is **prior art, not a dependency.** It is the closest existing
  "ACP agent in TypeScript" (Node/stdio). The ACP-shaped pieces in
  `src/acp/*` port; the stdio plumbing does not.
- `agentclientprotocol/agent-client-protocol` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/`)
  is **ground truth** for wire shapes. `schema/schema.json` +
  `docs/protocol/` + the reference TS impl under `src/`.
- `agentclientprotocol/claude-agent-acp` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/claude-agent-acp/`)
  is **reference for the thick-agent posture** — in particular
  how a compliant agent implements tools on its side and delegates
  only FS primitives to the client. Read `src/acp-agent.ts`.
- `vercel-labs/just-bash` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/vercel-labs/just-bash/`)
  is the **browser-native bash sandbox** we adopt as our LLM-facing
  tool surface. `src/browser.ts` is the entry; `src/fs/interface.ts`
  is the `IFileSystem` shape we adapt ZenFS to.

**Structure.** This index carries the canonical status board + a
one-line load-hook per milestone so a session knows which detail
file to actually read. Each milestone has its own file under
`ai-docs/web-acp/milestones/`. Per-milestone plans land under
`ai-docs/web-acp/plans/` when we actually pick up the milestone.

**Process.** One milestone at a time: draft the per-milestone plan
at `ai-docs/web-acp/plans/<milestone>.md` → implement → gate-check →
commit → move to next. The gate rules carry from
`ai-docs/web-agent/milestones/gate.md` in spirit; a web-acp-specific
gate file lands with the first real milestone if the rules diverge.

## Status board

| #   | Milestone                                                              | Status  | File |
| --- | ---------------------------------------------------------------------- | ------- | ---- |
| M0  | Foundation: scaffold + inline agent + real-LLM e2e, then Worker + ACP framing | **shipped** | [m0-foundation.md](m0-foundation.md) |
| M1  | ACP sessions: create, persist, reload, list, switch                    | **shipped** | [m1-sessions.md](m1-sessions.md) |
| M2  | Multi-volume mount + just-bash shell tool (agent-owned FS)             | **shipped** | [m2-tools.md](m2-tools.md) |
| M3  | MCP over HTTP + provider-native tool passthrough                       | next    | [m3-mcp.md](m3-mcp.md) |
| M4  | Commands + skills: slash commands, prompt templates, vault-sourced skills | planned | [m4-commands-and-skills.md](m4-commands-and-skills.md) |
| M5  | Extensions: vault-sourced runtime re-entry                             | planned | [m5-extensions.md](m5-extensions.md) |
| M6  | Session tree: `session/fork` (unstable, flag-gated) + `session/list`    | planned | [m6-session-tree.md](m6-session-tree.md) |
| M7  | Compaction: auto + manual + summary persistence                        | planned | [m7-compaction.md](m7-compaction.md) |
| M8  | Polish + extract: diagnostics, HTML export, library package            | planned | [m8-polish-and-extract.md](m8-polish-and-extract.md) |

### ACP compliance at a glance

| Concern              | ACP canonical                                                 | web-acp posture                                                        | Status |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| Tool execution       | Agent executes; reports via `session/update (tool_call)`      | Agent executes; single `bash` tool registered with the LLM (M2)        | compliant |
| Tool reporting       | `session/update (tool_call)` + `tool_call_update`             | Same; CommandCollector maps bash sub-commands when useful              | compliant |
| Permission           | `session/request_permission`                                  | Bridge from destructive bash commands is **deferred** to post-M2; see [deferred.md](deferred.md) | **deferred (see deferred.md)** |
| Filesystem           | Client-delegated via `fs/read_text_file` / `fs/write_text_file` | **Agent-owned** (worker-mounted ZenFS, multi-mount at `/mnt/<name>`); `fs/*` advertised but unused by built-ins (M2) | **divergent (documented)** |
| MCP                  | Agent is MCP client; servers configured by client             | Agent is MCP client; HTTP transport only (M3)                          | compliant |
| Provider-native tools | Reported as standard `tool_call` notifications                | Same — OpenAI `web_search` etc. surface via `tool_call` (M3)           | compliant |
| Slash commands       | Advertised via `available_commands_update`; expanded client-side | Same (M4)                                                              | compliant |
| Extension methods    | `_`-prefixed, namespaced                                      | `_bodhi/*`; see [steering/04-principles.md](../steering/04-principles.md) § 15 | compliant |
| Session fork         | `session/fork` (unstable schema)                              | Adopted behind a feature flag, pinned SDK version (M6)                 | unstable-with-flag |

The divergent row (filesystem) is the one to understand. See
[steering/02-architecture.md](../steering/02-architecture.md) §
"ACP architectural postures" and § "just-bash integration" for the
reasoning. The short form: just-bash's `IFileSystem` has ~25
methods; ACP `fs/*` has 2. Forcing bash through `fs/*` would
require ~12 non-standard `_bodhi/fs/*` extension methods —
architecturally worse than mounting the vault on the agent and
advertising `fs/*` as a future IDE-integration seam.

**Scope adjustments vs. original plan.**

- The phased M0 rework dropped the `/vault` mount + second
  test-double transport out of M0; vault re-enters as M2.1,
  now as **Linux-style multi-volume mounts at `/mnt/<name>`**
  rather than a single `/vault`.
- **M2 has been rescoped** from "six hand-rolled FS tools over
  ACP `fs/*`" to "multi-volume mount + just-bash shell tool +
  generic feature toggles". Driver: the `vercel-labs/just-bash`
  browser-native bash sandbox collapses the six-tool surface
  into a single `bash` tool with a strictly richer capability
  set (pipes, redirects, `jq`, `rg`, scripting). This requires
  the filesystem to live on the agent because ACP `fs/*`
  cannot transport just-bash's `IFileSystem`. ACP `fs/*` is
  still advertised for future IDE integration; built-ins do
  not use it. See [m2-tools.md](m2-tools.md).
- **Permission bridge + allow-always persistence deferred out
  of M2.** Originally scoped as M2.3; carved out to
  [deferred.md](deferred.md). M2's `bash` tool runs commands
  as-is; the destructive-command gate layers on later without
  reshaping the tool-call wire. Re-enters at the milestone
  kickoff following M2 exit.
- **M3 is now MCP + provider-native tools**, not session tree.
  Rationale: in the web-agent spike, MCP was the hard part; we
  tackle it early while the tool surface is minimal and the
  session model is stable. See [m3-mcp.md](m3-mcp.md).
- **Session tree (fork / branch) has moved to M6.** Rationale:
  the session model is already solid after M1 — fork is a
  UX amplifier, not a blocker. Landing tools + MCP + commands +
  extensions first means the fork operation inherits the full
  tool + MCP + extension state on each branch, and
  `session/fork` in the ACP unstable schema gives us a standard
  wire shape when we need it.
- **Compaction (M7) lands after extensions** because extensions
  may want to hook compaction (`before_compact` / `after_compact`).
- The MCP surface that used to live as M2.3 has moved to M3
  proper; see [m3-mcp.md](m3-mcp.md).

## Load-when hooks

Load the detail file only if its hook matches what you're about to
do. Previews are deliberately non-committal — they capture
**intent and sequencing**, not **plan-level detail**. Plan-level
detail lives in `ai-docs/web-acp/plans/` per-milestone.

- **[m0-foundation.md](m0-foundation.md)** — **shipped.** Load
  for historical reference on what the rework delivered across
  phases A–D and for the "M0 hardening follow-up" items
  (second transport, worker-boundary e2e assertion) that were
  cut from the M0 diff. **For current code-level reference,
  read [`../specs/web-acp/`](../specs/web-acp/) — especially
  [`startup-sequence.md`](../specs/web-acp/startup-sequence.md).**
- **[m1-sessions.md](m1-sessions.md)** — **shipped.** Load for
  historical reference on the worker-owned Dexie store,
  `session/load` replay, and the `bodhi/getSession` snapshot
  companion that restores the per-session model selector.
  Delivery plan at [`../plans/m1-sessions.md`](../plans/m1-sessions.md).
- **[m2-tools.md](m2-tools.md)** — **shipped.** Load for
  historical reference on the multi-volume mount, the just-bash
  shell tool, the generic `_bodhi/features/*` toggle surface, and
  the `fs/*` client handlers that live on the main thread as an
  IDE-integration seam (not used by the built-in bash). For
  current code-level reference, read
  [`../specs/web-acp/vault.md`](../specs/web-acp/vault.md),
  [`../specs/web-acp/tools.md`](../specs/web-acp/tools.md), and
  [`../specs/web-acp/features.md`](../specs/web-acp/features.md).
  The permission bridge that used to live as M2.3 is **deferred**
  to post-M2 — see [deferred.md](deferred.md).
- **[deferred.md](deferred.md)** — load whenever a deferral
  decision gets carved out of an in-flight milestone, or when
  the scope of a future milestone needs to pick up a deferred
  item. Currently tracks the permission bridge + allow-always
  persistence carried out of M2.
- **[m3-mcp.md](m3-mcp.md)** —
  load when adding MCP servers to the worker and surfacing
  provider-native tools. Agent is the MCP client (HTTP only).
  Provider-native tools (OpenAI `web_search` etc.) surface as
  regular `tool_call` notifications for observability. For
  current code-level reference once Phase A ships, read
  [`../specs/web-acp/mcp.md`](../specs/web-acp/mcp.md).
- **[m4-commands-and-skills.md](m4-commands-and-skills.md)** —
  load when picking up slash commands, prompt templates, and
  skills. Commands advertised via ACP `available_commands_update`;
  expansion is client-side for plain commands and agent-side
  for skill-activating commands.
- **[m5-extensions.md](m5-extensions.md)** — load when
  extension runtime re-enters. Vault-sourced, fully-trusted.
  Start from ACP extensibility, not web-agent's Blob-URL loader.
- **[m6-session-tree.md](m6-session-tree.md)** — load when
  picking up fork / branch. Adopt `session/fork` from the ACP
  unstable schema behind a feature flag.
- **[m7-compaction.md](m7-compaction.md)** — load when picking
  up compaction.
- **[m8-polish-and-extract.md](m8-polish-and-extract.md)** —
  load when preparing the extractable library.

## Open questions that cut across milestones

These surfaced during the exploration turn and need answers as
soon as the milestone that depends on them is picked up. Do not
answer them speculatively in milestone previews.

- **ACP library choice.** Depend on the ACP reference TS impl,
  vendor a subset, or hand-roll. Settle at **M0**.
- **Schema stability.** Anchor on `schema.json` only vs track
  `schema.unstable.json`. Settle at **M0**, revisit per-milestone.
  Note: M6 (session tree) explicitly adopts an unstable method
  behind a feature flag.
- **Transport interface shape.** `send/onMessage/close` vs duplex
  async-iterator pair. Settle at **M0.b**.
- **Permission policy defaults.** Auto-allow read, prompt on write
  vs per-tool vs configurable. Settle at **M0.a**; per-command
  granularity revisited in **M2.3** given the just-bash tool
  surface.
- **Remote-agent deployment modality.** Agent-owned FS and
  just-bash live in the user's browser. Remote-agent deployment
  therefore requires a different vault story (cloud-mounted,
  user-uploaded, or text-only). Document during **M8**; do not
  design here.
- **Library name.** `@bodhiapp/bodhi-web-acp` is a placeholder.
  Settle at **M8**.

## Cross-cutting references

- **`ai-docs/web-acp/specs/web-acp/`** — living specs for what
  M0 shipped. Start with
  [`startup-sequence.md`](../specs/web-acp/startup-sequence.md).
- **`ai-docs/web-acp/steering/00-vision.md`** — north star.
- **`ai-docs/web-acp/steering/01-goals.md`** — capability checklist
  with test seams.
- **`ai-docs/web-acp/steering/02-architecture.md`** — layer cake,
  transport boundary, ZenFS layout, ACP architectural postures,
  just-bash integration.
- **`ai-docs/web-acp/steering/04-principles.md`** — the rules that
  survive plans. Read before every design decision.
- **`ai-docs/web-agent/README.md`** — frozen archive marker.
- **`ai-docs/specs/worker-agent/`** — web-agent's technical specs.
  Still at its original path. Crib sheet for session shape, tool
  operations, extension hook signatures.
- **`ai-docs/web-agent/milestones/deferred.md`** — explicit post-v1
  non-goals carried over (shell, multi-tab collab, RAG, voice).
  Trust-model rationale for extensions also lives here.
