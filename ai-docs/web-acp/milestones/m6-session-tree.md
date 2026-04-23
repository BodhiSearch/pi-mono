# M6 — Session Tree

## ACP compliance header

**Posture.** Adopt **`session/fork`** from ACP's
`schema.unstable.json`, behind a feature flag, with a pinned SDK
version so schema changes don't move us silently. Keep
`bodhi/listSessions` as the listing surface (stable in our own
namespace) until upstream `session/list` stabilises.

Rationale for unstable adoption: `session/fork` is exactly the
primitive we need; inventing a `_bodhi/session/fork` extension
would create forward-compatibility pain when upstream stabilises.
Pin the SDK version, treat our adoption as a conscious unstable-
schema bet, and migrate to stable in M8 or whenever upstream moves.

## What this milestone delivers

The user can fork from any prior message in a session. Forking
creates a new branch inheriting the prefix up to that message; the
original session is untouched. The UI lets the user navigate
branches (parent ↔ child ↔ sibling). All branches persist with
their own tool-call state, skill activations, and MCP-tool
selections. Extension state is re-loaded per-branch.

User-facing feature set is what web-agent M6 shipped —
`forkSession`, branch-navigation UI, per-message Fork/Branch
affordances — rebuilt on ACP `session/fork`.

## ACP surface touched

- **`session/fork`** (unstable) — request the agent clone an
  existing session up to a given message and return a new
  session id. See `agent-client-protocol/schema/schema.unstable.json`
  (method is unstable as of the version we pin at M2 / M3 entry).
- **`bodhi/listSessions`** (our extension, stable in our namespace)
  — lists sessions with parent/child relationships exposed via a
  `parentSessionId` field added to `BodhiSessionSummary`. Swap for
  stable `session/list` when upstream stabilises (currently
  unstable per `schema.unstable.json`).
- **`session/load`** — already stable from M1. Forked sessions
  load identically to original sessions.

The feature-flag posture:

- `agentCapabilities.fork = false` by default at startup;
  `agentCapabilities.fork = true` when the user has flipped a
  setting or when the build is a dev/canary build.
- Playwright tests for fork run with the flag forced on; prod
  users see fork hidden until the schema stabilises.

## Sub-milestones

### M6.1 — Data model: parent/child session links

Deliverables:

- Extend `SessionStore` with `parentSessionId: string | null` +
  `branchPoint: { parentSessionId; upToSeq }` fields on session
  rows.
- `createSession(parentId?, upToSeq?)` clones prefix entries up
  to `upToSeq` (inclusive) into the new session with a fresh
  session id; `InlineAgent` seeds from the cloned messages.
- `listSummaries()` returns a tree-shaped list (parent first,
  children ordered by creation time).
- Unit tests: fork, fork-of-fork, fork-then-delete-parent (child
  is orphaned but survives), and linear session unchanged.

### M6.2 — `session/fork` wire + handler

Deliverables:

- `AcpAgentAdapter.forkSession({ sessionId, upToMessageId })`
  maps to `SessionStore.createSession(parentId, upToSeq)` +
  returns the new session id.
- `AcpClient.forkSession(id, messageId)` wrapper; `useAcp` hook
  exposes `forkSession` + `currentBranchPath`.
- SDK version pin: record the exact `@agentclientprotocol/sdk`
  version we depend on for the unstable schema shape; add a
  CI grep to fail if the version drifts without a matching
  milestone entry.
- Feature flag: `VITE_WEB_ACP_FORK_ENABLED=1` dev-env gate, plus
  a UI toggle in settings for prod opt-in.

### M6.3 — Branch navigation UI

Deliverables:

- `SessionPicker` renders the tree: parent at top, children
  indented, sibling branches at the same level.
- Per-message "Fork here" affordance in `ChatDemo` (drops a new
  branch starting from that message).
- Branch breadcrumb at the top of the transcript: "Branch 2 of
  3 · parented at 'Tue message #5'". Click navigates.
- Playwright spec: create session A → fork at message 3 →
  verify both sessions in the picker → both sessions load
  correctly with the expected transcripts.

## Depends on

- **M1** — session store (parent/child rows extend the existing
  schema).
- **M2** — tools, because forked branches can continue issuing
  tool calls.
- **M3** — MCP tool state belongs to the branch; inherited but
  re-connectable.
- **M4** — active skills inherited at the fork point.
- **M5** — extension state re-loaded per branch.

## Out of scope

- Merging branches back together. Not in v1.
- Cross-session forking (fork session A's prefix into session
  B's tail). Not in v1.
- Collaborative branching. Single user.
- Stable `session/list` adoption — defer until upstream
  stabilises.
- Delete-cascade semantics for parent deletion. v1 orphans the
  children; UI shows "(orphan)" badge.

## Why this ordering

**After tools / MCP / commands / skills / extensions** because
the branch state has to include all of them. Landing fork before
extensions would force a rewrite of the fork handler once
extensions register additional branch-scoped state.

**Before compaction (M7)** because compaction at the fork point
is a plausible UX (fork + summarise-the-prefix). Having fork
stable means the M7 plan can consider that affordance cleanly.

**Unstable-schema adoption is the canonical test of principle 6**
— ACP explicitly provides `session/fork` in `schema.unstable.json`
because that's exactly the forward-compatible extension mechanism
ACP wants us to use. Rather than duplicating the shape in a
`_bodhi/session/fork` extension, we accept the unstable-pin cost.
