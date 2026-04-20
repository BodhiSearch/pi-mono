Preserve the M6 (session tree) implementation context for packages/web-agent.

CURRENT STATE
- Repo: pi-mono at /Users/amir36/Documents/workspace/src/github.com/BodhiSearch/pi-mono
- Branch: main, ahead of origin/main by 13 commits. Working tree clean.
- Last three commits:
    af2b7086 refactor(web-agent): Post-M5 cleanup — options plumbing + dead-code pruning
    5cd569c0 refactor(web-agent): swap M5 session storage to Dexie on IndexedDB
    3ddd01b2 feat(web-agent): M5 session persistence — /sessions IndexedDB + picker
- Test baseline: 156 unit tests green, 4/4 e2e specs green, repo-level `npm run check` clean.
- M6 plan file ai-docs/plans/m6-session-tree.md was just written and approved. Implementation
  has NOT started yet.

PLAN
- ai-docs/plans/m6-session-tree.md — full approved plan for M6 (session tree: fork +
  in-session branch navigation). 5 phases, single commit at the end, checkpoint commits OK.
- Phases: (1) store layer + tree.ts helper, (2) SessionManager.fork + navigateToLeaf,
  (3) RPC + WorkerAgentHost + abort-on-load fix, (4) React hooks + UI, (5) e2e + docs +
  commit.
- Each phase gates on `npm run check` + `npm test` (+ `npm run test:e2e` at the end of
  phase 5 and for any UI-visible change).

USER'S ANSWERED QUESTIONS (locked decisions — do not re-litigate)
- Scope: "Fork + in-session tree viewer". Cross-session fork (new session with copied
  entries) AND in-session leaf navigation (move leafId within a single session). The
  SessionPicker dropdown shows fork relationships so users switch across parent/child
  sessions; per-message action buttons handle fork / branch-here actions inside a session.
- NO LLM-generated branch summaries. `branchWithSummary` variant is explicitly out of scope
  for M6 MVP (the third scope option was rejected). navigateToLeaf is ephemeral — moves
  leafId in memory, no entry appended.
- Fork storage: full entry copy (same shape as coding-agent's JSONL model). Child session
  gets a fresh UUIDv7; `parentSession = sourceId` on the child's SessionRow; copied
  entries preserve original `id`, `parentId`, `timestamp` verbatim. LabelEntry rows are
  skipped during the copy. No COW, no parent-reference joins — per user's "DAG with
  references" phrasing (the DAG lives inside one session via parentId pointers).
- DB schema: unchanged from M5. Existing sessions + entries tables carry every field M6
  needs. The compound PK `[sessionId+id]` lets preserved entry ids coexist across sessions
  without collision.
- Early optimization: NOT needed. Fork is O(k) rows in a single Dexie transaction,
  ~10–50 ms for typical sessions; fork-storage cost is linear in shared prefix but
  acceptable (typical < 1 MB per fork). Plan explicitly names three optimisations
  considered and rejected (COW, parent-pointer, dedup). Revisit only on real telemetry.

WORKING TREE
- ai-docs/plans/m6-session-tree.md is UNTRACKED (new, just written, not committed).
- No other uncommitted changes.

DURABLE STEERING (read before touching code)
- CLAUDE.md (repo root) — project focus, core values, commands
- ai-docs/milestones.md — M0–M5 done + Post-M5 cleanup post-script. M6 is the next
  milestone, the one we are implementing now.
- ai-docs/plans/m6-session-tree.md — the plan we are executing
- ai-docs/decisions/ — D1–D21 landed (split into per-group files; start at
  `decisions/index.md`). D18 (fork storage) + D19 (ephemeral leaf nav) in
  `decisions/m6-session-tree.md`.
- ai-docs/02-architecture.md (ZenFS mount layout, dependency classification from Post-M5)
- ai-docs/04-principles.md (web-agent imports inward only; storage is IndexedDB not OPFS;
  few high-value e2e with test.step per concern)

NOTES / LATENT GOTCHAS FROM PRIOR WORK (do not re-learn)
- WorkerAgentHost.loadSession currently does NOT abort an in-flight turn before resetting
  the agent. M6 phase 3 fixes this — `await this.writeChain; this.session.abort();` before
  `SessionManager.load`. Tests should cover this new behavior.
- DexieSessionStore uses a per-session monotonic timestamp bump in `_writeEntry` to keep
  `[sessionId+timestamp]` ordering stable under same-ms ties. `forkSession` must bypass
  that bump and preserve the source entry's timestamp verbatim — write via direct
  `this.db.entries.add(row)` inside the fork transaction, not via `_writeEntry`.
- `API_KEY_PRESENCE_PLACEHOLDER` in worker/agent-worker.ts is required because pi-ai's
  OpenAI provider layer gates on `getApiKey()` returning something even when real auth is
  via `Authorization: Bearer` headers. Do not remove.
- The SessionPicker's existing data-testids drive session-persistence.spec.ts. M6 phase 4
  MUST keep existing testids intact; add new ones for fork (`session-fork-indicator`,
  `chat-message-fork-action`, etc.) without renaming old ones.
- e2e tests auto-start the Bodhi server via packages/web-agent/e2e/tests/global-setup.ts.
  `npm run test:e2e` is self-contained — no manual server start.

WORKFLOW
- Single commit at the end covering all 5 phases; checkpoint commits are fine if any
  phase takes more than ~½ day.
- Target test counts: ~170 unit tests (156 baseline + ~15 new); 4 e2e specs with
  session-persistence.spec.ts extended (no new spec file).
- Do NOT widen scope mid-implementation — anything the plan doesn't call in-scope gets
  filed as a follow-up, not quietly added. Ask via AskUserQuestion if the plan seems
  wrong in practice.

DECISION RECORDS TO APPEND IN PHASE 5
- D18 — Fork storage: full entry copy on fork; `parentSession` pointer on child; ids
  + parentIds preserved verbatim; labels skipped.
- D19 — Ephemeral leaf navigation: navigateToLeaf mutates in-memory leafId only, no
  persisted marker. Reload re-derives leaf as the chronologically-latest entry. M6.1
  or later may add a BranchSummaryEntry marker if needed.

MANDATORY GATES BEFORE COMMIT
- `cd packages/web-agent && npm run check`
- `cd packages/web-agent && npm test`
- `cd packages/web-agent && npm run test:e2e`
- Repo-level `npm run check` at root (biome + tsgo + browser-smoke + web-ui +
  web-agent must all be green; this is the milestone gate per
  ai-docs/milestones.md#milestone-gate).

Existing 156 unit tests + 4 e2e specs must stay green. Do not modify unrelated specs.
