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
| M0  | Foundation: scaffold + ZenFS `/vault` + real-LLM e2e, then Worker + ACP framing | planned | [m0-foundation.md](m0-foundation.md) |
| M1  | ACP sessions: create, persist, reload, list, switch                    | planned | [m1-sessions.md](m1-sessions.md) |
| M2  | Filesystem tools via ACP `fs/*` delegation                             | planned | [m2-tools.md](m2-tools.md) |
| M3  | Session tree: fork, branch, navigate (likely needs ACP extension)      | planned | [m3-session-tree.md](m3-session-tree.md) |
| M4  | Compaction: auto + manual + summary persistence                        | planned | [m4-compaction.md](m4-compaction.md) |
| M5  | Resources: slash commands, prompt templates, skills                    | planned | [m5-resources.md](m5-resources.md) |
| M6  | Extensions: runtime re-entry, starting from "how does ACP extend?"     | planned | [m6-extensions.md](m6-extensions.md) |
| M7  | Polish + extract: diagnostics, HTML export, library package            | planned | [m7-polish-and-extract.md](m7-polish-and-extract.md) |

## Load-when hooks

Load the detail file only if its hook matches what you're about to
do. Previews are deliberately non-committal — they capture
**intent and sequencing**, not **plan-level detail**. Plan-level
detail lives in `ai-docs/web-acp/plans/` per-milestone.

- **[m0-foundation.md](m0-foundation.md)** — load when picking up
  the first coding turn. Two parts: M0.a scaffold + vault + inline
  agent + real-LLM e2e; M0.b agent behind Worker + ACP framing over
  `MessageChannel`. Two transport implementations (real +
  test-double) gate M0.b to prove swappability.
- **[m1-sessions.md](m1-sessions.md)** — load when picking up
  session persistence / reload / list / switch.
- **[m2-tools.md](m2-tools.md)** — load when moving tools onto ACP
  `fs/*` delegation.
- **[m3-session-tree.md](m3-session-tree.md)** — load when picking
  up fork / branch. Flag: likely needs an ACP extension.
- **[m4-compaction.md](m4-compaction.md)** — load when picking up
  compaction.
- **[m5-resources.md](m5-resources.md)** — load when picking up
  slash commands / prompt templates / skills.
- **[m6-extensions.md](m6-extensions.md)** — load when extension
  runtime re-enters. Start from ACP extensibility, not web-agent's
  Blob-URL loader.
- **[m7-polish-and-extract.md](m7-polish-and-extract.md)** — load
  when preparing the extractable library.

## Open questions that cut across milestones

These surfaced during the exploration turn and need answers as
soon as the milestone that depends on them is picked up. Do not
answer them speculatively in milestone previews.

- **ACP library choice.** Depend on the ACP reference TS impl,
  vendor a subset, or hand-roll. Settle at **M0**.
- **Schema stability.** Anchor on `schema.json` only vs track
  `schema.unstable.json`. Settle at **M0**, revisit per-milestone.
- **Transport interface shape.** `send/onMessage/close` vs duplex
  async-iterator pair. Settle at **M0.b**.
- **Permission policy defaults.** Auto-allow read, prompt on write
  vs per-tool vs configurable. Settle at **M0.a**.
- **Library name.** `@bodhiapp/bodhi-web-acp` is a placeholder.
  Settle at **M7**.

## Cross-cutting references

- **`ai-docs/web-acp/steering/00-vision.md`** — north star.
- **`ai-docs/web-acp/steering/01-goals.md`** — capability checklist
  with test seams.
- **`ai-docs/web-acp/steering/02-architecture.md`** — layer cake,
  transport boundary, ZenFS layout.
- **`ai-docs/web-acp/steering/04-principles.md`** — the rules that
  survive plans. Read before every design decision.
- **`ai-docs/web-agent/README.md`** — frozen archive marker.
- **`ai-docs/specs/worker-agent/`** — web-agent's technical specs.
  Still at its original path. Crib sheet for session shape, tool
  operations, extension hook signatures.
- **`ai-docs/web-agent/milestones/deferred.md`** — explicit post-v1
  non-goals carried over (shell, multi-tab collab, RAG, voice).
  Trust-model rationale for extensions also lives here.
