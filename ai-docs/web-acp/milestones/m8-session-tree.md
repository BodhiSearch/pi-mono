# M8 — Session tree

**Status:** planned. Re-sequenced from the original M6 slot after
the agent-package extraction + ACP 0.21 compliance + engine split
(M5 digest) and the extensions + templates/skills milestones
(M6 / M7) landed ahead of it.

**Host scope.** Agent-primary. Browser host addendum inline under
§ "Browser host addendum".

## ACP compliance header

**Posture.** Adopt **`session/fork`** from ACP's
`schema.unstable.json`, behind a feature flag, with a pinned SDK
version so schema changes don't move us silently. `Agent.listSessions`
(stable since 0.20) already carries us for listing; parent /
child relationships surface on `SessionInfo._meta.bodhi.parentSessionId`.

Rationale for unstable adoption: `session/fork` is exactly the
primitive we need; inventing a `_bodhi/session/fork` extension
would create forward-compatibility pain when upstream stabilises.
Pin the SDK version, treat our adoption as a conscious
unstable-schema bet, and migrate to stable in M11 or whenever
upstream moves.

## What this milestone delivers

The user can fork from any prior message in a session. Forking
creates a new branch inheriting the prefix up to that message; the
original session is untouched. The UI lets the user navigate
branches (parent ↔ child ↔ sibling). All branches persist with
their own tool-call state, skill activations, MCP-tool
selections, and per-session feature toggles. Extension state is
re-loaded per-branch.

User-facing feature set is what the frozen `web-agent` M6 shipped
(`forkSession`, branch-navigation UI, per-message Fork / Branch
affordances), rebuilt on ACP `session/fork`.

## Depends on

- **M1** — session store (parent / child rows extend the
  existing schema).
- **M2** — tools, because forked branches continue issuing tool
  calls.
- **M3** — MCP tool state belongs to the branch; inherited but
  re-connectable.
- **M4** — vault commands / built-ins; each branch gets its own
  advertised set.
- **M5** — engine split + agent-package extraction. Fork threads
  through `AcpSessionRuntime.tearDownSession` /
  `rehydrateInlineFromStore`; rides on the extracted agent's
  stable shape.
- **M6** — extensions. Each branch re-activates the extension
  set (`session_loaded` fires on the child). Extension state is
  per-branch.
- **M7** — skills. Active skills are copied into the child at
  fork; the child can deactivate them freely without affecting
  the parent.

## ACP surface touched

- **`session/fork`** (unstable) — request the agent clone an
  existing session up to a given message and return a new
  session id. See
  `agent-client-protocol/schema/schema.unstable.json` (method is
  unstable as of the SDK version we pin).
- **`Agent.listSessions`** (stable) — `SessionInfo._meta.bodhi`
  gains a `parentSessionId: string | null` field + a
  `branchPoint: { parentSessionId; upToSeq } | null` field.
  `BodhiSessionInfoMeta` in the agent package's `wire/`
  extends accordingly. Clients that don't know about these
  fields ignore them (principle § 12).
- **`session/load`** — unchanged. Forked sessions load
  identically to original sessions; the branch metadata is just
  additional row state.

**Feature-flag posture.**

- `agentCapabilities.fork = false` by default at startup;
  `agentCapabilities.fork = true` when the build is a dev /
  canary build or the user flips a setting.
- Playwright tests for fork run with the flag forced on; prod
  users see fork hidden until the schema stabilises.

## Sub-milestones

### M8.1 — Data model: parent / child session links

Deliverables:

- `SessionStore` interface gains `parentSessionId: string |
  null` + `branchPoint: { parentSessionId: string; upToSeq:
  number } | null` on session rows.
- `createSession({ parentSessionId?, upToSeq? })` clones prefix
  entries up to `upToSeq` (inclusive) into the new session
  with a fresh session id; the new row carries the branch
  metadata. `InlineAgent.restoreMessages(...)` seeds the cloned
  messages at load time.
- In-memory + Dexie impls both support the new columns.
  Existing rows are back-filled with `parentSessionId = null`
  and `branchPoint = null` via a Dexie v4 migration.
- `Agent.listSessions` returns the tree-shaped set (the cursor
  pagination contract unchanged; parent / child ordering is a
  UI concern). Host renders tree structure from the flat list.

Gate items:

- Unit: fork, fork-of-fork, fork-then-delete-parent (child
  orphaned but survives), linear session unchanged by fork
  code.
- Unit: Dexie migration from v3 to v4 on a seeded store
  preserves every existing session + adds the new columns with
  safe defaults.

### M8.2 — `session/fork` wire + handler

Deliverables:

- `AcpAgentAdapter.forkSession({ sessionId, upToMessageId })`
  delegates to
  `AcpSessionRuntime.forkSession(sessionId, upToSeq)` + returns
  the new session id in the `session/fork` response shape.
  `upToSeq` is derived from `upToMessageId` by walking the
  persisted entries (per-turn `messageId` already anchored in
  the replay walker from M5).
- `AcpClient.forkSession(id, messageId)` wrapper on the host
  side.
- `useAcpSession` slice hook exposes `forkSession` +
  `currentBranchPath`.
- SDK version pin: record the exact `@agentclientprotocol/sdk`
  version we depend on for the unstable schema shape; add a CI
  grep to fail the build if the SDK version drifts without a
  matching milestone entry (`rg 'agentclientprotocol/sdk.*"[^~^]'`
  in `package.json` files).
- Feature flag: `VITE_WEB_ACP_FORK_ENABLED=1` dev env var
  (picked up at Vite build time) plus a user-visible toggle in
  the settings page.

Gate items:

- Unit: `forkSession` up to message 3 produces a new row
  whose entries array is the first-3 slice of the parent's;
  fourth entry onward is absent.
- Unit: forked session's `session/load` replays the cloned
  prefix and seeds `InlineAgent` with the cloned assistant
  messages so the first follow-up prompt uses the branched
  context.
- Real-LLM e2e: create session A → prompt three times → fork
  at message 3 → prompt follow-up on branch → assert branch
  and parent both load correctly with their expected
  transcripts + the follow-up only lands on the child.

### M8.3 — Branch navigation UI + exit gate

Deliverables (host-side):

- `SessionPicker` renders the tree: parent at top, children
  indented under the parent row, sibling branches at the same
  level (visual depth determined by walking
  `parentSessionId`).
- Per-message "Fork here" affordance in `MessageBubble` or
  `ChatDemo` that calls `useAcpSession.forkSession(id,
  messageId)` and auto-loads the new branch.
- Branch breadcrumb at the top of the transcript:
  `Branch 2 of 3 · parented at 'Tue prompt #5'`. Click any
  segment navigates.
- `[orphan]` badge on children of a deleted parent (principle
  § 13 — surface state rather than hiding it).

Gate items:

- Playwright: create session A → fork at message 3 → verify
  both sessions in the picker tree → both load with the
  expected transcripts. Delete the parent → child shows
  `[orphan]`.
- `rg "VITE_WEB_ACP_FORK_ENABLED|agentCapabilities\.fork"
  packages/web-acp` returns non-empty (feature flag present).
- The fork UI is hidden when `agentCapabilities.fork =
  false`.

## Browser host addendum (`packages/web-acp/`)

**Scope.**

- `useAcpSession.forkSession` + `currentBranchPath` thread.
- `SessionPicker` tree rendering (new reducer arm in
  `panelsReducer` for the computed tree derived from flat
  list).
- `MessageBubble` / `ChatDemo` fork affordance gated behind
  `agentCapabilities.fork`.
- Settings-page toggle for `VITE_WEB_ACP_FORK_ENABLED` (user
  opt-in during the unstable phase).

**Host hard constraints.** No new transport-level work. The
tree is a rendering concern over the existing `listSessions`
cursor-paginated contract.

## Out of scope

- **Merging branches back together.** Not in v1.
- **Cross-session forking** (fork session A's prefix into
  session B's tail). Not in v1.
- **Collaborative branching.** Single user.
- **Stable `session/list` adoption** for the tree-specific
  fields — defer until upstream stabilises.
- **Delete-cascade semantics** for parent deletion. v1 orphans
  the children; UI shows `[orphan]`.
- **Live picker re-render** when another tab forks. Single-tab
  scope.

## Why this ordering

**After tools / MCP / commands / skills / extensions** because
the branch state has to include all of them. Landing fork before
extensions would force a rewrite of the fork handler once
extensions register additional branch-scoped state.

**Before compaction (M9)** because compaction at the fork point
is a plausible UX (fork + summarise-the-prefix). Having fork
stable means the M9 plan can consider that affordance cleanly.

**Unstable-schema adoption is the canonical test of principle 6**
— ACP explicitly provides `session/fork` in
`schema.unstable.json` because that is exactly the
forward-compatible extension mechanism ACP wants us to use.
Rather than duplicating the shape in a `_bodhi/session/fork`
extension, we accept the unstable-pin cost and keep the
migration path open.

## Cross-references

- Frozen `web-agent` M6 (pattern reference; not imported):
  [`../../web-agent/milestones/`](../../web-agent/milestones/).
- ACP unstable schema:
  `agent-client-protocol/schema/schema.unstable.json`.
- M6 extensions (dependency): [`m6-extensions.md`](m6-extensions.md).
- M7 skills (dependency): [`m7-templates-and-skills.md`](m7-templates-and-skills.md).
- Principle § 6 (ACP extensibility before sub-protocols),
  § 12 (extra `_meta` fields must be ignorable):
  [`../steering/04-principles.md`](../steering/04-principles.md).
