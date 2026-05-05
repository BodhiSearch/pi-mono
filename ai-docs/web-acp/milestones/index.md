# Milestones — web-acp

Roadmap for shipping `packages/web-acp/` — a browser-native ACP
agent built on top of the transport-agnostic
`@bodhiapp/web-acp-agent` runtime package. **Living document.**

**Scope reset (2026-05-05).** Roadmap re-sequenced after the
agent-package extraction + ACP 0.21 compliance + engine split
landed as post-M4 work. M0–M4 + M3.5 remain frozen as shipped
history; M5 is a **digest** of the intervening post-M4 threads
(extraction, compliance, engine split, adaptive plum
simplification, provider-agnostic embed simplification); M6–M11
are the **resequenced remaining work**. See
[`m5-extraction-and-compliance.md`](m5-extraction-and-compliance.md)
for the full digest of what shipped between the original M4
gate and this reset.

**Active-host scope.** `packages/web-acp/` (browser host).

A second host (`packages/cli-acp-client/`, Node TTY) shipped
during the post-M4 period as a **transport-neutrality proof**.
It confirmed the agent runtime is genuinely host-portable. The
CLI is now **shelved**: the folder stays in the repo as frozen
reference but is not part of the active roadmap and does not
receive feature parity with browser-host work. Future Node / HTTP
/ mobile hosts can pick up from the reference when / if they
become roadmap priorities.

## Relationship to neighbours

- `packages/web-agent/` is the **reference spike, not an
  ancestor.** M0–M8 of the frozen spike shipped there; we study
  the specs at `ai-docs/specs/worker-agent/` and the e2e patterns
  at `packages/web-agent/e2e/`. We do not import or copy files.
- `svkozak/pi-acp` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/`)
  is **prior art, not a dependency.** The closest existing "ACP
  agent in TypeScript" (Node/stdio). Its `src/acp/*` shape ports;
  stdio plumbing does not.
- `agentclientprotocol/agent-client-protocol` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/`)
  is **ground truth** for wire shapes. `schema/schema.json` +
  `docs/protocol/` + the reference TS impl under `src/`.
- `agentclientprotocol/claude-agent-acp` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/claude-agent-acp/`)
  is **reference for the thick-agent posture** — a compliant
  agent that implements tools and delegates FS primitives to the
  client. Read `src/acp-agent.ts`.
- `vercel-labs/just-bash` (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/vercel-labs/just-bash/`)
  is the **browser-native bash sandbox** we adopted for the M2
  tool surface. Depend on the published `just-bash` npm package
  (browser build at `just-bash/browser`); do not vendor source.

## Structure

This index carries the canonical status board + a one-line
load-hook per milestone so a session knows which detail file to
actually read. Each milestone has its own file under
`ai-docs/web-acp/milestones/`.

**Process.** One milestone at a time: implement → gate-check →
commit → move to next. Per-host divergence (when meaningful) is
captured as a "Browser host addendum" inline in the milestone
file; sibling per-host files are only created when a host has
genuinely divergent work that warrants its own document.

## Status board

### Shipped (frozen history)

| #    | Milestone                                                              | File |
| ---- | ---------------------------------------------------------------------- | ---- |
| M0   | Foundation: scaffold + inline agent + real-LLM e2e, then Worker + ACP framing | [m0-foundation.md](m0-foundation.md) |
| M1   | ACP sessions: create, persist, reload, list, switch                    | [m1-sessions.md](m1-sessions.md) |
| M2   | Multi-volume mount + just-bash shell tool (agent-owned FS)             | [m2-tools.md](m2-tools.md) |
| M3   | MCP over HTTP (provider-native tools deferred)                         | [m3-mcp.md](m3-mcp.md) |
| M3.5 | DeepWiki MCP login + `_bodhi/sessions/delete`                          | [m3.5-followups.md](m3.5-followups.md) |
| M4   | Commands + skills (phase A vault commands + phase B built-ins + M4.2 first slice) | [m4-commands-and-skills.md](m4-commands-and-skills.md) |
| M5   | **Digest:** agent-package extraction, ACP 0.21 compliance sweep, engine split (agent + host), "adaptive plum" + "provider-agnostic embed" simplifications | [m5-extraction-and-compliance.md](m5-extraction-and-compliance.md) |
| M6   | **Extensions** — vault-sourced runtime (system-prompt mutators, input transform, tools, tool gates, slash commands, session metadata, provider observability, inter-extension events, custom providers, toggle + reload + persisted disabled list, `/extension add` npm install) | [m6-extensions.md](m6-extensions.md) |

### Planned (resequenced)

| #    | Milestone                                                              | Host scope          | File |
| ---- | ---------------------------------------------------------------------- | ------------------- | ---- |
| M7   | **Prompt template parameter form + skills** — finishes the M4 commands pipeline (`arguments:` front-matter, `{{name}}` substitution, skills at `<mount>/.pi/skills/<name>/SKILL.md`, `_bodhi/skills/activate`) | agent + web-acp addendum | [m7-templates-and-skills.md](m7-templates-and-skills.md) |
| M8   | **Session tree** — `session/fork` (unstable, flag-gated) + parent/child rows + branch navigation UI | agent + web-acp addendum | [m8-session-tree.md](m8-session-tree.md) |
| M9   | **Compaction** — auto + manual (`/compact` built-in) + summary persistence + extension `before_compact`/`after_compact` hooks | agent + web-acp addendum | [m9-compaction.md](m9-compaction.md) |
| M10  | **Permission bridge** — re-entry of deferred M2.3: classifier + `session/request_permission` + allow-always persistence, covering bash + MCP + extension tools uniformly | agent + web-acp addendum | [m10-permission-bridge.md](m10-permission-bridge.md) |
| M11  | **Polish + npm publish** — `@bodhiapp/web-acp-agent` to npm, optional browser-host runtime extraction, diagnostics panel, HTML export, compliance-table closeout | agent + web-acp addendum | [m11-polish-and-publish.md](m11-polish-and-publish.md) |

### ACP compliance at a glance

| Concern              | ACP canonical                                                 | web-acp posture                                                        | Status |
| -------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------- | ------ |
| Tool execution       | Agent executes; reports via `session/update (tool_call)`      | Agent executes; single `bash` tool + MCP tools registered with the LLM | compliant |
| Tool reporting       | `session/update (tool_call)` + `tool_call_update`             | Same; CommandCollector maps bash sub-commands when useful              | compliant |
| Permission           | `session/request_permission`                                  | **Deferred** — re-enters as **M10** (see `m10-permission-bridge.md`)   | **deferred → M10** |
| Filesystem           | Client-delegated via `fs/read_text_file` / `fs/write_text_file` | **Agent-owned** (worker-mounted ZenFS, multi-mount at `/mnt/<name>`); `clientCapabilities.fs` not advertised post-"adaptive plum" — see M5 digest § 5 | **divergent (documented)** |
| MCP                  | Agent is MCP client; servers configured by client             | Agent is MCP client; Streamable HTTP only; JWT in `McpServerHttp.headers` (M3 shipped) | compliant |
| Provider-native tools | Reported as standard `tool_call` notifications                | **Deferred** — `_bodhi/providers/nativeTools` + per-model toggle UI parked; see [deferred.md](deferred.md) | **deferred** |
| Slash commands       | Advertised via `available_commands_update`; expanded client-side | Vault commands + prompt templates + built-ins + extension commands all ride the same advertisement; commands win on canonical-name collisions with prompts; built-ins intercepted agent-side (phase B shipped). Extension commands shipped at **M6**; parameter form + skills land at **M7** | compliant |
| Extension methods    | `_`-prefixed, namespaced                                      | All `_bodhi/*`; see [steering/04-principles.md](../steering/04-principles.md) § 15. Legacy `bodhi/*` names cleaned up in the M5 compliance sweep | compliant |
| Model selection      | `unstable_setSessionModel` + `SessionModelState` on session-create/load responses | Adopted in the M5 compliance sweep | compliant (unstable surface) |
| Session listing      | `Agent.listSessions` (stable since 0.20); cursor-paginated    | Adopted in the M5 compliance sweep. Cursor is base64(`page=N&per_page=10&sort_by=updated_at&sort_seq=desc`) | compliant |
| Session close        | `Agent.closeSession` (stable since 0.20) | Adopted in the M5 compliance sweep for in-memory cleanup; `_bodhi/sessions/delete` retained as a user-visible delete gesture | compliant |
| Per-session config   | `Agent.setSessionConfigOption` + `config_option_update` + `NewSessionResponse.configOptions` | Adopted in the M5 compliance sweep. Config IDs `_bodhi/features/{bashEnabled,forceToolCall}` (DEV-only `forceToolCall`); more config IDs land with M9 (`autoCompact*`) and M10 (`allowAlways*`) | compliant |
| MCP lifecycle        | No first-class transport; ACP allows extensions | Rides on `extNotification("_bodhi/mcp/state", ...)` (M5 digest § 2) | compliant (extension) |
| Built-in action ride | No first-class transport; ACP allows extensions | Rides on `extNotification("_bodhi/builtin/action", ...)` (M5 digest § 2) | compliant (extension) |
| `agentInfo`          | `InitializeResponse.agentInfo: { name, version }` | Stamped in the M5 compliance sweep | compliant |
| `SessionUpdate` kinds (11 in spec) | All explicit | Host reducer has explicit case arms for every kind (M5 digest § 4) | compliant |
| Session fork         | `session/fork` (unstable schema) | Adopted at **M8** behind a feature flag, pinned SDK version | **planned (M8)** |

The **divergent** row (filesystem) is the one to understand. See
[steering/02-architecture.md](../steering/02-architecture.md) §
"ACP architectural postures" and § "just-bash integration" for
the reasoning. The short form: just-bash's `IFileSystem` has ~25
methods; ACP `fs/*` has 2. Forcing bash through `fs/*` would
require ~12 non-standard `_bodhi/fs/*` extension methods —
architecturally worse than mounting the vault on the agent.

### How the resequencing maps to the original plan

For readers who remember the original M5–M8 roadmap:

| Original slot                              | New slot                                                    |
| ------------------------------------------ | ----------------------------------------------------------- |
| M5 — Extensions                            | **M6** (promoted, shipped — see m6-extensions.md)           |
| M4.2-form (prompt template parameter form) | **M7.1** (now a dedicated milestone with skills)            |
| M4.3 — Skills                              | **M7.2**                                                    |
| M6 — Session tree                          | **M8** (scope unchanged, dependencies updated for M6/M7)    |
| M7 — Compaction                            | **M9** (scope refined; extension hooks now a first-class dep) |
| Deferred — Permission bridge (was M2.3)    | **M10** (re-entered from deferred)                           |
| M8 — Polish + extract                      | **M11** (extraction already done in M5 digest; publish remains) |

## Load-when hooks

Load the detail file only if its hook matches what you're about
to do. Previews are deliberately non-committal — they capture
**intent and sequencing**, not implementation detail.

### Shipped (load for historical reference)

- **[m0-foundation.md](m0-foundation.md)** — shipped. For
  current code-level reference, read the per-package specs at
  [`../specs/web-acp-agent/`](../specs/web-acp-agent/) (agent
  runtime) and [`../specs/web-acp-client/`](../specs/web-acp-client/)
  (browser host), especially the two startup-sequence files.
- **[m1-sessions.md](m1-sessions.md)** — shipped. Read when
  touching the session lifecycle.
- **[m2-tools.md](m2-tools.md)** — shipped. Read when touching
  volumes, the bash tool, or feature toggles.
- **[m3-mcp.md](m3-mcp.md)** — shipped. Read when touching the
  MCP wire.
- **[m3.5-followups.md](m3.5-followups.md)** — shipped. Read
  when touching session-delete or multi-server login.
- **[m4-commands-and-skills.md](m4-commands-and-skills.md)** —
  phase A + B + M4.2 first slice shipped; **M4.2-form + M4.3
  are now M7**. Read when touching the commands pipeline.
- **[m5-extraction-and-compliance.md](m5-extraction-and-compliance.md)**
  — shipped digest. Read when any foundational assumption feels
  off — extraction + ACP 0.21 compliance + engine split +
  simplifications together moved the whole foundation; the
  digest is the single entry point to "what changed".
- **[m6-extensions.md](m6-extensions.md)** — shipped. Read
  when touching the extension runtime, the `_bodhi/extensions/*`
  surface, the `/extension` built-in, the `pi.dev` install
  flow, or `<mount>/.pi/extensions/<name>/` discovery. Read
  alongside [`../specs/web-acp-agent/extensions.md`](../specs/web-acp-agent/extensions.md)
  for the callback-by-callback contract.

### Planned (load when picking up the matching milestone)

- **[m7-templates-and-skills.md](m7-templates-and-skills.md)** —
  **next up.** Load when picking up the prompt parameter form
  or skills.
- **[m8-session-tree.md](m8-session-tree.md)** — load when
  picking up fork / branch.
- **[m9-compaction.md](m9-compaction.md)** — load when picking
  up compaction.
- **[m10-permission-bridge.md](m10-permission-bridge.md)** —
  load when re-entering the deferred M2.3 permission bridge.
- **[m11-polish-and-publish.md](m11-polish-and-publish.md)** —
  load when preparing for the npm publish + the polish sweep.

### Cross-cutting

- **[deferred.md](deferred.md)** — carry-over items. The
  permission bridge + allow-always persistence entries are
  preserved for traceability but are now scheduled as **M10**;
  provider-native tools remain post-v1 unless a product demand
  surfaces. The `bodhi/*` → `_bodhi/*` rename was largely
  absorbed into the M5 compliance sweep; residual notes stay
  for completeness.

## Open questions that cut across milestones

These surfaced during the post-M4 reset and need answers as soon
as the milestone that depends on them is picked up. Do not
answer them speculatively in milestone previews.

- **Extension API semver stance.** When does the M6 extension
  API freeze? Proposal: freeze at **M11** (npm publish) with
  `0.x` minors meaning breaking. Settle at **M11** kickoff.
- **Per-session volume namespacing.** Latent today; blocks
  any multi-session backend host. Tracked at
  [`packages/web-acp-agent/TECHDEBT.md`](../../../packages/web-acp-agent/TECHDEBT.md).
  Re-enters when a multi-session host appears (not on the
  current roadmap).
- **Compaction wire shape.** `_meta.bodhi.compacted` synthetic
  message vs `_bodhi/session/compacted` notification vs future
  ACP RFD. Settle at **M9** kickoff.
- **Browser-host runtime extraction (M11.2).** Conditional on a
  concrete third-party consumer. Settle at **M11** kickoff.
- **Remote-agent deployment modality.** Agent-owned FS +
  just-bash live in the user's browser. Remote-agent deployment
  therefore requires a different vault story (cloud-mounted,
  user-uploaded, or text-only). Documented but not committed at
  **M11** via the new `ai-docs/web-acp/remote-agent.md` decision
  log. Shipping a remote-agent host is out of the current roadmap.
- **Future transports.** WebSocket / HTTP-SSE / Node stdio /
  mobile hosts are **not** in the current roadmap per the
  2026-05-05 sequencing decision. Re-enters when a concrete
  deployment driver surfaces.

## Cross-cutting references

- **`ai-docs/web-acp/specs/web-acp-agent/`** — agent-runtime
  living specs. Start with
  [`startup-sequence.md`](../specs/web-acp-agent/startup-sequence.md).
- **`ai-docs/web-acp/specs/web-acp-client/`** — browser host
  living specs. Start with
  [`startup-sequence.md`](../specs/web-acp-client/startup-sequence.md).
- **`ai-docs/web-acp/specs/cli-acp-client/`** — CLI host living
  spec. **Frozen; reference only.** The CLI is not on the active
  roadmap.
- **`ai-docs/web-acp/steering/00-vision.md`** — north star.
- **`ai-docs/web-acp/steering/01-goals.md`** — capability
  checklist with test seams.
- **`ai-docs/web-acp/steering/02-architecture.md`** — layer cake,
  transport boundary, ZenFS layout, ACP architectural postures,
  just-bash integration.
- **`ai-docs/web-acp/steering/04-principles.md`** — the rules
  that survive plans. Read before every design decision.
- **`ai-docs/web-agent/README.md`** — frozen-archive marker for
  the pre-ACP web-agent spike.
- **`ai-docs/specs/worker-agent/`** — web-agent's technical
  specs. Still at its original path. Crib sheet for session
  shape, tool operations, extension hook signatures.
- **`ai-docs/web-agent/milestones/deferred.md`** — post-v1
  non-goals inherited from the spike (shell, multi-tab collab,
  RAG, voice).
