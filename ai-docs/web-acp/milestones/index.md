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
`ai-docs/web-acp/milestones/`.

**Process.** One milestone at a time: implement → gate-check →
commit → move to next. The gate rules carry from
`ai-docs/web-agent/milestones/gate.md` in spirit; a web-acp-specific
gate file lands with the first real milestone if the rules diverge.

## Status board

| #   | Milestone                                                              | Status  | File |
| --- | ---------------------------------------------------------------------- | ------- | ---- |
| M0  | Foundation: scaffold + inline agent + real-LLM e2e, then Worker + ACP framing | **shipped** | [m0-foundation.md](m0-foundation.md) |
| M1  | ACP sessions: create, persist, reload, list, switch                    | **shipped** | [m1-sessions.md](m1-sessions.md) |
| M2  | Multi-volume mount + just-bash shell tool (agent-owned FS)             | **shipped** | [m2-tools.md](m2-tools.md) |
| M3  | MCP over HTTP (provider-native tools deferred)                         | **shipped** | [m3-mcp.md](m3-mcp.md) |
| —   | Post-M3 follow-ups: DeepWiki MCP login + `_bodhi/sessions/delete`      | **shipped** | [m3.5-followups.md](m3.5-followups.md) |
| M4  | Commands + skills: vault commands (phase A) + agent-handled built-ins `/help` `/version` `/info` `/copy` `/mcp` (phase B) + vault prompt templates (M4.2 first slice); parameter form (M4.2-form) + skills (M4.3) pending | **phase A + B + M4.2 first slice shipped; M4.2-form + M4.3 pending** | [m4-commands-and-skills.md](m4-commands-and-skills.md) |
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
| MCP                  | Agent is MCP client; servers configured by client             | Agent is MCP client; Streamable HTTP only; JWT in `McpServerHttp.headers` (M3 shipped) | compliant |
| Provider-native tools | Reported as standard `tool_call` notifications                | **Deferred** — M3 ships MCP only; provider-native passthrough parked to a later milestone (see [deferred.md](deferred.md)) | **deferred (see deferred.md)** |
| Slash commands       | Advertised via `available_commands_update`; expanded client-side | Vault commands expand **agent-side** in `prompt()` (M4 phase A, shipped); vault prompt templates (`<mount>/.pi/prompts/**/*.md`) ride the same loader + expander + advertisement (M4.2 first slice, shipped — commands win on canonical-name collisions with a `[prompts]` warning); built-in commands `/help` `/version` `/info` `/copy` `/mcp` intercepted before the LLM and replied with the `command` tag on `agent_message_chunk._meta.bodhi.builtin`. **Action ride moved to `extNotification("_bodhi/builtin/action")` post-ACP-0.21 migration M6.** All ride the same `available_commands_update` advertisement | compliant |
| Extension methods    | `_`-prefixed, namespaced                                      | `_bodhi/*`; see [steering/04-principles.md](../steering/04-principles.md) § 15. `bodhi/getSession` is the last un-prefixed name; deferred at M5 of the ACP-0.21 migration | partial (M5 deferred) |
| Model selection      | `unstable_setSessionModel` + `SessionModelState` on session-create/load responses | Adopted at M1 + M4 of the ACP-0.21 migration. `bodhi/listModels` and `_meta.bodhi.modelId` retired; the agent resolves `currentModelId` from `SessionState` per prompt | compliant (unstable surface) |
| Session listing      | `Agent.listSessions` (stable since 0.20) | Adopted at M1 + M2 of the ACP-0.21 migration; `bodhi/listSessions` retired. `turnCount` / `lastModelId` / `createdAt` ride `SessionInfo._meta.bodhi` | compliant |
| Session close        | `Agent.closeSession` (stable since 0.20) | Adopted at M1 of the ACP-0.21 migration for in-memory cleanup; `_bodhi/sessions/delete` retained as a user-visible delete gesture that wraps close path + `store.deleteSession` | compliant |
| Per-session config   | `Agent.setSessionConfigOption` + `config_option_update` notification + `NewSessionResponse.configOptions` | Adopted at M1 + M3 of the ACP-0.21 migration; `_bodhi/features/list` and `_bodhi/features/set` retired. Config IDs `_bodhi/features/{bashEnabled,forceToolCall}` (DEV-only `forceToolCall`) | compliant |
| MCP lifecycle        | No first-class transport; ACP allows extensions | Rides on `extNotification("_bodhi/mcp/state", { sessionId, server, state, error?, tools? })` per M6 of the ACP-0.21 migration. Replaced the legacy empty-`agent_message_chunk` + `_meta.bodhi.mcp` carrier | compliant (extension) |
| `agentInfo`          | `InitializeResponse.agentInfo: { name, version }` | Stamped at M1 of the ACP-0.21 migration | compliant |
| `SessionUpdate` kinds (11 in spec) | All explicit | Reducer at host has explicit case arms for every kind plus a default `console.warn` for unknowns (M7 of the ACP-0.21 migration); the 6 not-yet-rendered kinds are slotted no-ops awaiting UI | compliant |
| Session fork         | `session/fork` (unstable schema)                              | Adopted behind a feature flag, pinned SDK version (M6 of original roadmap, post-migration)                 | unstable-with-flag |

The divergent row (filesystem) is the one to understand. See
[steering/02-architecture.md](../steering/02-architecture.md) §
"ACP architectural postures" and § "just-bash integration" for the
reasoning. The short form: just-bash's `IFileSystem` has ~25
methods; ACP `fs/*` has 2. Forcing bash through `fs/*` would
require ~12 non-standard `_bodhi/fs/*` extension methods —
architecturally worse than mounting the vault on the agent and
advertising `fs/*` as a future IDE-integration seam.

**Scope adjustments vs. original plan.**

- **ACP 0.21 compliance migration (M1–M8 of
  [`ai-docs/plans/reviewed-the-acp-compliance-report-peaceful-journal.md`](../../plans/reviewed-the-acp-compliance-report-peaceful-journal.md)).**
  Driven by the audit at
  [`../reviews/acp-compliance-2026-05-03.md`](../reviews/acp-compliance-2026-05-03.md).
  Eight features the spec ships natively that we previously served
  via custom `_bodhi/*` extension methods or `_meta.bodhi.*`
  envelope rides have been migrated to native ACP 0.21 surfaces:
  `Agent.listSessions`, `Agent.closeSession`,
  `Agent.unstable_setSessionModel` + `SessionModelState`,
  `Agent.setSessionConfigOption` + `config_option_update`,
  `agentInfo` on `InitializeResponse`, and explicit reducer arms
  for all 11 `SessionUpdate` kinds. MCP lifecycle and built-in
  actions migrated to dedicated `extNotification` side-channels
  (`_bodhi/mcp/state`, `_bodhi/builtin/action`), keeping
  `_`-prefixed extension naming compliant. **`bodhi/getSession`
  collapse (M5) was deferred** after analysis showed the planned
  reducer-folds-replay-chunks approach was incomplete (the
  agent's `loadSession` only re-emits `'notification'` entries,
  not `'turn'` / `'builtin'` ones); see
  `packages/web-acp/TECHDEBT.md` § "M5 deferred" for the two
  viable paths. **`packages/cli-acp-client/` was deliberately
  left out** of this migration per the user's "leave broken"
  direction; see
  `packages/cli-acp-client/TECHDEBT.md` for the per-call-site
  port.

- **Post-M4 phase B agent-package extraction.** The
  worker-side ACP runtime moved from `packages/web-acp/src/{acp,
  agent,features,mcp/url-canonical,mcp/toggle-store}` into a new
  private `@bodhiapp/web-acp-agent` workspace at
  `packages/web-acp-agent/src/`. The package depends on
  `@zenfs/core` (not `@zenfs/dom`) and exposes a single
  `startAcpAgent(transport, services)` bootstrap that takes a
  byte-stream transport pair plus service interfaces
  (`SessionStore`, `FeatureStore`, `McpToggleStore`,
  `VolumeRegistry`, `LlmProvider`). `web-acp` keeps the browser
  adapters under `packages/web-acp/src/runtime/{storage-dexie,
  volumes-fsa,transport}/` and a thin `agent-worker.ts` shim
  wires them together. Wire surface unchanged. Future Node /
  HTTP-SSE bootstraps plug into the same boundary; M8's library
  extract step folds in behind this seam. The extraction commit
  shipped the agent package + the migrated host-side homes but
  left `agent-worker.ts` still importing from the legacy
  in-package paths; a follow-up cleanup
  ([`ai-docs/plans/indexed-dazzling-fairy.md`](../../plans/indexed-dazzling-fairy.md))
  flipped the worker over, deleted ~14 duplicated engine files
  + the legacy provider runtime + legacy stores from
  `packages/web-acp/src/`, and switched every consumer to import
  from `@bodhiapp/web-acp-agent`. Detail in
  [`../../../.cursor/plans/extract_web-acp-agent_9dacac4b.plan.md`](../../../.cursor/plans/extract_web-acp-agent_9dacac4b.plan.md).
- **Post-extraction CLI host (`packages/cli-acp-client/`).**
  A second consumer of `@bodhiapp/web-acp-agent` shipped to
  validate the host-neutral assertion: a Claude-Code-style
  Node TTY CLI that embeds the agent in-process over an
  in-memory `TransformStream` duplex. Same agent code, same
  ACP wire, different transport + different services bag
  (in-memory stores, Node OAuth 2.1/PKCE client with a local
  callback server, `ZenfsVolumeRegistry` seeded with a
  `PassthroughFS` over `node:fs` at `$cwd`). Has its own e2e
  harness mirroring `packages/web-acp/e2e/` against a real
  BodhiApp NAPI instance. The Node OAuth + settings + duplex
  helpers are generic enough to ship as a starter kit when M8
  extracts the agent package proper. Spec at
  [`../specs/cli-acp-client/index.md`](../specs/cli-acp-client/index.md);
  README at
  [`../../../packages/cli-acp-client/README.md`](../../../packages/cli-acp-client/README.md).
- **Pre-M5 engine-split refactor.** Between M4 phase B exit and
  M5 entry the agent-side runtime was restructured along
  coding-agent's wire/engine seam. `acp/agent-adapter.ts` shrank
  from 1,254 → ~245 LoC by lifting per-session state into
  `acp/engine/session-runtime.ts`, the prompt-turn loop into
  `acp/engine/prompt-driver.ts`, the eight `_bodhi/*` extension
  methods into per-file handlers under `acp/engine/ext-methods/`,
  and the built-in slash-command dispatch into
  `acp/engine/builtin-dispatch.ts`. Wire surface unchanged. M5
  extensions, M6 fork, and M7 compaction now plug into the new
  structure rather than churning a god-object. Detail in
  [`../web-acp-vs-coding-agent/engine-split.md`](../web-acp-vs-coding-agent/engine-split.md)
  and
  [`../web-acp-vs-standard-acp/engine-split.md`](../web-acp-vs-standard-acp/engine-split.md).
- **Pre-M5 host-side wire/engine split.** The asymmetric host
  half of the same refactor: `hooks/useAcp.ts` shrank from
  1,133 → ~180 LoC by extracting non-React ACP plumbing
  (runtime singleton, streaming reducer, builtin-dispatch,
  permissions stub, message-shape helpers, session-meta) under
  `src/acp/` and per-concern hooks (`useAcpRuntime`,
  `useAcpAuth`, `useAcpModels`, `useAcpFeatures`, `useAcpMcp`,
  `useAcpSession`, `useAcpStreaming`) under `src/hooks/`. The
  pure `streamingReducer` replaces the imperative refs +
  effects pattern that consumed `session/update` notifications.
  Wire surface byte-identical; `useAcp()` return shape
  unchanged so `ChatDemo.tsx` (the single value-consumer)
  needs no update. Plan at
  [`../../plans/kick-off-prompt-squishy-journal.md`](../../plans/kick-off-prompt-squishy-journal.md).
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
- **M3 was originally MCP + provider-native tools**, not session
  tree. Rationale: in the web-agent spike, MCP was the hard part;
  we tackled it early while the tool surface was minimal and the
  session model stable. **Provider-native tools were deferred
  out of M3** after MCP landed — the `_bodhi/providers/nativeTools`
  extension + per-model toggle UI are parked to [deferred.md](deferred.md)
  so M3's shipped diff stays focused on the MCP wire. See
  [m3-mcp.md](m3-mcp.md).
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
**intent and sequencing**, not implementation detail.

- **[m0-foundation.md](m0-foundation.md)** — **shipped.** Load
  for historical reference on what the rework delivered across
  phases A–D and for the "M0 hardening follow-up" items
  (second transport, worker-boundary e2e assertion) that were
  cut from the M0 diff. **For current code-level reference,
  read the per-package specs at
  [`../specs/web-acp-agent/`](../specs/web-acp-agent/) (agent runtime)
  and [`../specs/web-acp-client/`](../specs/web-acp-client/) (browser
  host) — especially the two startup-sequence narratives at
  [`../specs/web-acp-agent/startup-sequence.md`](../specs/web-acp-agent/startup-sequence.md)
  and [`../specs/web-acp-client/startup-sequence.md`](../specs/web-acp-client/startup-sequence.md).**
- **[m1-sessions.md](m1-sessions.md)** — **shipped.** Load for
  historical reference on the worker-owned Dexie store,
  `session/load` replay, and the `bodhi/getSession` snapshot
  companion that restores the per-session model selector.
- **[m2-tools.md](m2-tools.md)** — **shipped.** Load for
  historical reference on the multi-volume mount, the just-bash
  shell tool, the generic `_bodhi/features/*` toggle surface, and
  the `fs/*` client handlers that live on the main thread as an
  IDE-integration seam (not used by the built-in bash). For
  current code-level reference, read
  [`../specs/web-acp-agent/volumes.md`](../specs/web-acp-agent/volumes.md)
  + [`../specs/web-acp-client/volumes.md`](../specs/web-acp-client/volumes.md),
  [`../specs/web-acp-agent/tools.md`](../specs/web-acp-agent/tools.md),
  and [`../specs/web-acp-agent/features.md`](../specs/web-acp-agent/features.md)
  + [`../specs/web-acp-client/features.md`](../specs/web-acp-client/features.md).
  The permission bridge that used to live as M2.3 is **deferred**
  to post-M2 — see [deferred.md](deferred.md).
- **[deferred.md](deferred.md)** — load whenever a deferral
  decision gets carved out of an in-flight milestone, or when
  the scope of a future milestone needs to pick up a deferred
  item. Currently tracks the permission bridge + allow-always
  persistence carried out of M2, provider-native tool
  passthrough carried out of M3, and two M0 carry-overs (the
  second-transport / worker-boundary-e2e hardening pair and the
  `bodhi/*` → `_bodhi/*` extension-method rename).
- **[m3-mcp.md](m3-mcp.md)** — **shipped.** Load for historical
  reference on the MCP-over-HTTP integration: live catalog fetch,
  JWT-in-`McpServerHttp.headers`, refcounted worker pool,
  `<srv>__<tool>` namespacing, per-session `mcpToggles`
  (Dexie v3 + `_bodhi/mcp/toggles/set`), and the `_meta.bodhi.mcp`
  lifecycle notification contract. For current code-level
  reference, read
  [`../specs/web-acp-agent/mcp.md`](../specs/web-acp-agent/mcp.md)
  + [`../specs/web-acp-client/mcp.md`](../specs/web-acp-client/mcp.md).
  Provider-native tools were carved out of M3 — see
  [deferred.md](deferred.md).
- **[m3.5-followups.md](m3.5-followups.md)** — **shipped.** Load
  for historical reference on the two post-M3-exit-gate
  follow-ups: a second `addMcpServer(...)` call requesting scope
  for the public DeepWiki MCP at login (multi-server pattern
  established without churning M3's wire) and the
  `_bodhi/sessions/delete` extension method that closes the M1
  session lifecycle (create / list / load / **delete**) with a
  single-click affordance in the picker.
- **[m4-commands-and-skills.md](m4-commands-and-skills.md)** —
  **phase A + B + M4.2 first slice shipped; M4.2-form + M4.3
  pending.** Phase A landed vault-sourced slash commands at
  `<mount>/.pi/commands/**/*.md` with agent-side template
  expansion in `prompt()`. Phase B added agent-handled built-ins
  `/help`, `/version`, `/info`, `/copy`, `/mcp` that intercept
  in `prompt()` before any LLM resolution, emit replies stamped
  with `_meta.bodhi.builtin = { command, action? }` on
  `agent_message_chunk`, and persist as a new `'builtin'`
  `SessionEntry` kind so the LLM never sees the exchange even
  after `session/load`. `/copy` rides an open-ended
  `action.kind` discriminator (no payload on the wire — the
  client builds the markdown locally from `messages` state).
  M4.2 first slice landed vault-sourced prompt templates at
  `<mount>/.pi/prompts/**/*.md`: same `CommandDef` shape as
  commands, same canonical naming, same expander, merged into
  `available_commands_update` after commands; commands win on
  canonical-name collisions with a `[prompts]` warning. The
  `AvailableCommand` wire shape carries no kind discriminator —
  the picker stays a black-box consumer. For current code-level
  reference, read
  [`../specs/web-acp-agent/commands.md`](../specs/web-acp-agent/commands.md)
  + [`../specs/web-acp-client/commands.md`](../specs/web-acp-client/commands.md)
  and [`../specs/web-acp-agent/sessions.md`](../specs/web-acp-agent/sessions.md)
  (the `'builtin'` entry kind doc). Pending sub-milestones:
  M4.2-form (parameter form for templates with named
  parameters); M4.3 skills (`<mount>/.pi/skills/<name>/SKILL.md`,
  `_bodhi/skills/activate`). State-mutation built-ins
  (`/name`, `/model`, `/new`, `/resume`, `/settings`, `/login`,
  `/logout`) carved out as the next slice. `/compact` lands
  with M7; `/fork` / `/tree` with M6.
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

- **`ai-docs/web-acp/specs/web-acp-agent/`** — agent-runtime
  living specs. Start with
  [`startup-sequence.md`](../specs/web-acp-agent/startup-sequence.md).
- **`ai-docs/web-acp/specs/web-acp-client/`** — browser host
  living specs. Start with
  [`startup-sequence.md`](../specs/web-acp-client/startup-sequence.md).
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
