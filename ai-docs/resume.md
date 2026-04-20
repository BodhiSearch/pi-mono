Resume M6 implementation for packages/web-agent (session tree — fork + in-session
branch navigation). The plan is approved; we are executing it. No replanning.

Step 1 — Read durable steering in this exact order:
  1. CLAUDE.md (repo root)
  2. ai-docs/milestones.md — M0–M5 done; M6 is the next milestone.
  3. ai-docs/plans/m6-session-tree.md — THE plan. Follow phase order; each phase has
      its own gate.
  4. ai-docs/05-decisions.md — D1–D17 landed. D18 + D19 land with M6 in Phase 5.
  5. ai-docs/02-architecture.md (ZenFS mount layout, Post-M5 dependency classification)
      and ai-docs/04-principles.md (web-agent imports inward only; few high-value e2e
      with test.step per concern).

Step 2 — In parallel, read the current web-agent shape you're about to touch:
  - packages/web-agent/src/web-agent/core/session/store.ts — interface gets a new
      forkSession method in Phase 1.
  - packages/web-agent/src/web-agent/core/session/memory-store.ts — new forkSession
      impl + new tests in Phase 1.
  - packages/web-agent/src/web-agent/core/session/dexie-store.ts — new forkSession
      impl using a single Dexie transaction; direct `this.db.entries.add(row)` call
      (bypassing `_writeEntry`'s monotonic-timestamp bump so copied entries keep their
      original timestamps).
  - packages/web-agent/src/web-agent/core/session/session-manager.ts — gets `fork`
      and `navigateToLeaf` methods in Phase 2.
  - packages/web-agent/src/web-agent/core/session/types.ts — already has every type
      M6 needs (BranchSummaryEntry, SessionHeader.parentSession, SessionTreeNode).
      Do not widen.
  - packages/web-agent/src/web-agent/worker/worker-host.ts — Phase 3: `forkSession`,
      `navigateToLeaf`, and the abort-before-reset fix to loadSession.
  - packages/web-agent/src/web-agent/rpc/rpc-types.ts + rpc-client.ts + rpc-server.ts
      — Phase 3: two new commands (`fork_session`, `navigate_to_leaf`) and responses.
  - packages/web-agent/src/hooks/useAgent.ts + useSessionsList.ts — Phase 4: add a
      new useSessionEntries hook + expose sessions.fork / sessions.navigateToLeaf.
  - packages/web-agent/src/components/sessions/SessionPicker.tsx — Phase 4: tree-indent
      forest rendering + breadcrumb for forked sessions. Keep existing data-testids.
  - packages/web-agent/src/components/chat/ChatMessages.tsx (and related bubble
      components) — Phase 4: per-message action menu (Fork / Branch).
  - packages/web-agent/e2e/session-persistence.spec.ts — Phase 5: extended with
      test.step entries for fork + navigate. Do not create a new spec file.
  - Existing tests to keep green without edits: memory-store.test.ts, dexie-store.test.ts
      (extend, don't rewrite), session-manager.test.ts (extend), rpc.test.ts (extend),
      worker-host.test.ts (extend), zenfs-operations.test.ts, zenfs-provider.test.ts,
      agent-session.test.ts.

Step 3 — Reference patterns to study (read-only; do not import):
  - packages/coding-agent/src/core/session-manager.ts lines 1125–1262 — the fork
      (`createBranchedSession`) and branch (`branch` / `branchWithSummary`) patterns.
      Copy shapes; skip the LLM summarisation path (out of scope for M6).
  - packages/coding-agent/src/core/agent-session-runtime.ts lines 141–262 — the
      switchSession + fork runtime transitions. Mirror the abort-before-teardown
      ordering (we add it to loadSession in Phase 3).
  - packages/coding-agent tree-traversal tests (test/session-manager/tree-traversal.test.ts)
      — structural patterns for our session-manager.test.ts additions.

Step 4 — Confirm installed deps + working tree:
  - `cd packages/web-agent && grep -E "dexie|dexie-react-hooks" package.json`
      expected: dexie ^4.4.2 + dexie-react-hooks ^1.1.7 (both already installed from M5).
  - `git status` should show:
      new:       ai-docs/compact.md (this prompt's sibling)
      new:       ai-docs/resume.md (this prompt itself)
      new:       ai-docs/plans/m6-session-tree.md
    No other uncommitted changes.
  - `git log --oneline -3` expected top: af2b7086 (Post-M5 cleanup).

Step 5 — Create a TaskCreate list mirroring the 5 phases in the plan, then start
Phase 1 (store layer):
  - Phase 1 — SessionStore.forkSession + tree.ts helper + tests (both stores)
  - Phase 2 — SessionManager.fork + navigateToLeaf + tests
  - Phase 3 — RPC commands + WorkerAgentHost handlers + abort-before-reset fix
  - Phase 4 — useSessionEntries hook + useAgent pass-through + SessionPicker forest
      rendering + per-message action menu
  - Phase 5 — Extend session-persistence.spec.ts; write M6 outcome in milestones.md;
      append D18 + D19 to 05-decisions.md; single commit covering all phases.

Gates (run after each phase):
  cd packages/web-agent && npm run check   # lint + tsc -b
  cd packages/web-agent && npm test         # vitest — 156 existing + ~15 new
Phase 4 and 5 additionally:
  cd packages/web-agent && npm run test:e2e # 4 existing + extended spec

Mandatory milestone gate before commit (per ai-docs/milestones.md#milestone-gate):
  Repo-level `npm run check` at the repo root — biome + tsgo + browser-smoke +
  web-ui check + web-agent check must all be green.

Must stay green: 156 existing unit tests + 4 existing e2e specs. Do not modify
unrelated specs. session-persistence.spec.ts may be EXTENDED (per the plan), but its
existing steps + data-testids must keep passing.

Locked design decisions (do NOT re-litigate):
  - Fork storage = full entry copy (coding-agent JSONL shape). Preserved ids + parentIds
      + timestamps on copied entries. Labels skipped.
  - navigateToLeaf is EPHEMERAL — no persisted marker, no LLM summary. Matches
      coding-agent `branch(fromId)`. M6.1 can revisit with BranchSummaryEntry persistence.
  - DB schema is unchanged from M5. No new indexes or tables.
  - Fork is atomic via Dexie's `db.transaction('rw', [sessions, entries], ...)` —
      use direct `db.entries.add(row)` inside the tx, NOT the monotonic-timestamp
      `_writeEntry` helper (which would rewrite source timestamps).

If anything in the plan looks ambiguous or contradicts the current code state, stop
and ask via AskUserQuestion before deviating.

Final commit covers all 5 phases. Checkpoint commits are OK if any phase takes longer
than ~½ day. Commit message style mirrors af2b7086 (short title + bulleted body +
Co-Authored-By trailer).

Decision records to append in Phase 5:
  - D18 — Fork storage: full entry copy, parentSession pointer, ids + parentIds +
      timestamps preserved verbatim, labels skipped during copy.
  - D19 — Ephemeral leaf navigation: in-memory leafId move only; reload re-derives
      leaf from the latest entry. BranchSummaryEntry persistence deferred to M6.1+.
