# M6 — Session tree: fork, in-session branch navigation

## Context

M5 shipped session persistence via Dexie on IndexedDB. Every session is an append-only entry log whose entries already carry `parentId` pointers, so each session is a DAG by construction — `SessionManager.getTree()` and `getBranch(fromId?)` are live today, just with degenerate (linear) output because every `appendMessage` sets `parentId = this.leafId`.

M6 turns that latent capability into two user-visible features:

1. **Cross-session fork.** From any entry in the current session, spin off a new session that starts as a copy of the path from root to that entry. Parent stays untouched.
2. **In-session branch navigation.** Move the leaf pointer inside a session to a previous entry; the next prompt appends as a sibling, growing the DAG.

Both operations reuse the existing SessionStore + SessionManager APIs. No schema changes. No LLM calls (user explicitly rejected the `branchWithSummary` variant).

User-approved scope decisions:
- **Storage model:** full entry copy on fork — each session self-contained, matching coding-agent's JSONL pattern. Ids and parentIds preserved across sessions so a branched child's DAG stays structurally identical to the parent's root-to-fork slice.
- **In-session navigation:** ephemeral leaf. Matches coding-agent's `branch(fromId)`. No persisted navigation markers in MVP — reload resets leaf to the latest entry.
- **UI:** extend the existing session dropdown to render fork relationships; add a per-message "fork from here" + "branch here" action. No separate tree panel.

## Findings from exploration

Coding-agent patterns worth copying (packages/coding-agent/src/core/session-manager.ts):
- `createBranchedSession(leafId)` (lines 1170–1262): extracts root-to-leaf path, filters `LabelEntry` rows, reconstructs in new session with preserved ids + parentIds. Fresh UUIDv7 for the session; parent untouched.
- `branch(branchFromId)` (lines 1125–1130): moves `leafId` in place; no persistence.
- `branchWithSummary(branchFromId, summary)` (lines 1146–1163): appends a `BranchSummaryEntry` with `fromId`, advances leaf to it — this is how coding-agent makes a navigation persistent. **Out of scope for M6 MVP.**
- `getTree()` (lines 1075–1113): returns `SessionTreeNode[]` — the forest of entries with nested `children`.
- `getBranch(fromId?)` (lines 1034–1043): linear chain from a leaf back to root.

Web-agent readiness (already in place):
- `BranchSummaryEntry` + `SessionHeader.parentSession` + `SessionRow.parentSession` — all present (`src/web-agent/core/session/types.ts:33`, `:74`; `src/web-agent/core/session/store.ts:34`).
- `SessionManager.getTree()` + `getBranch()` + `appendBranchSummary()` — wired through `MemorySessionStore` + `DexieSessionStore`.
- `new_session` RPC already accepts `parentSession` (`src/web-agent/rpc/rpc-types.ts:47`). One more command on top of that covers fork.

Gaps to fill (all small):
1. `SessionStore.forkSession()` atomic helper — existing appends don't accept pre-built entries with fixed ids/timestamps; fork needs verbatim copy inside one transaction.
2. `SessionManager.fork(fromEntryId)` + `navigateToLeaf(entryId)` — simple orchestration on top of the store helper.
3. `WorkerAgentHost.loadSession()` should abort any in-flight turn before resetting the agent (latent bug flagged by the audit; M6 exposes it because branch-switch mid-stream is a realistic flow).
4. Two new RPC commands: `fork_session`, `navigate_to_leaf`.
5. `useSessionEntries(sessionId)` — main-thread liveQuery hook for the in-session tree UI (parallel to `useSessionsList`).
6. UI: per-message action menu + picker breadcrumb rendering for fork relationships.

## Design

### DB schema — no changes needed

Current schema (from `src/web-agent/core/session/dexie-store.ts`):

```
sessions: 'id, modifiedAt'
  — pk id, secondary modifiedAt for list ordering.
entries:  '[sessionId+id], sessionId, [sessionId+timestamp], [sessionId+type]'
  — compound pk for direct fetch, sessionId for per-session scans,
    [sessionId+timestamp] for chronological reads,
    [sessionId+type] for type-scoped queries (M7/M8).
```

Row shapes (already carrying every field M6 needs — `store.ts:29-52`):

```ts
SessionRow { id, name, cwd, parentSession, createdAt, modifiedAt, entryVersion }
EntryRow   { sessionId, id, parentId, timestamp, type, data: SessionEntry }
```

Fork creates a new `SessionRow` with `parentSession = sourceId`. For each entry copied from source, a new `EntryRow` is inserted under `newSessionId` with `id`, `parentId`, `timestamp`, `type`, and `data` preserved verbatim. Ids and parentIds are shared with the source by value — that's intentional. The compound primary key `[sessionId+id]` prevents any collision: the SAME entry id can exist under both sessions because the session discriminator scopes them.

In-session navigation writes nothing to the store. It mutates `SessionManager.leafId` on the Worker side. The next append uses the new leafId as parentId; from the store's perspective it's an ordinary append with a parentId that happens to not be "the most recent entry."

### Performance analysis

Session-level numbers (order of magnitude, modern laptop browser):
- Typical session: 10–50 entries; heaviest realistic: a few hundred.
- Typical page lifetime: 1–10 sessions active, hundreds persisted.

Fork cost is dominated by the copy. Let `k` = entries from root to fork point, `t` = one IDB row write ≈ 0.5 ms batched inside a Dexie transaction.

| Scenario | Reads | Writes | Wall clock |
|---|---|---|---|
| Fork at entry 5 of a 10-entry session | 2 (session row + entries batch) | 6 (1 session + 5 entries) | ~10 ms |
| Fork at entry 50 of a 100-entry session | 2 | 51 | ~50 ms |
| Fork at entry 500 of a 1000-entry session | 2 | 501 | ~300 ms |

In-session leaf navigation is constant time — one in-memory pointer move. No IDB round-trip.

`listSessions` is already O(N_sessions) for the list view + one indexed scan per session for the summary; fork adds sessions but not entries to that path. Multi-tab reactivity (BroadcastChannel via Dexie liveQuery) broadcasts invalidations per transaction, so forks appear in all open tabs on commit.

**Storage cost of full-copy forks:** each fork duplicates `k` entries. At ~5–20 KB per entry (rich JSON including message content), a typical 50-entry fork costs 250 KB – 1 MB. IDB quotas are hundreds of MB on modern origins; the user would need thousands of deep forks to approach any limit. Worst-case practical: if a user forks repeatedly at the same point, each fork is its own copy — storage scales linearly. Acceptable.

**Do we need early optimization? No.** Three potential optimisations exist but every one complicates the model:

1. Copy-on-write (child references parent's entries until it diverges). Saves storage proportional to shared prefix but makes deletes messy (can't drop parent while a child exists without re-materialising) and turns every read into a join. Not worth it until storage telemetry shows a real problem.
2. Parent-pointer with lazy read join. Same trade-offs as COW.
3. Index on `parentSession`. Needed only if we add a "show all descendants of this session" UI. Not in M6.

Stick with verbatim copy. Revisit only if production data says we must.

### API additions

#### `SessionStore.forkSession`

New atomic helper on the store interface (implemented in both Memory + Dexie):

```ts
/**
 * Create a new session whose entries are the root-to-`upToEntryId` path from
 * `sourceSessionId`. Atomic: either every row lands or none do. Returns the
 * new SessionRow.
 *
 * - Preserves each copied entry's `id`, `parentId`, and `timestamp` verbatim.
 * - `LabelEntry` rows are skipped during the copy; labels on the child start empty.
 * - `newRow.parentSession` is set to `sourceSessionId`.
 * - Throws if `sourceSessionId` doesn't exist or if `upToEntryId` isn't on the
 *   root chain of the source.
 */
forkSession(opts: {
  sourceSessionId: string;
  upToEntryId: string;
  id?: string; // optional explicit id for tests; defaults to new UUIDv7
}): Promise<SessionRow>;
```

MemorySessionStore: `for` loop mutating the two Maps inside a synchronous block.

DexieSessionStore:
```ts
return this.db.transaction('rw', [this.db.sessions, this.db.entries], async () => {
  const source = await this.db.sessions.get(sourceSessionId);
  if (!source) throw new Error(...);
  const sourceEntries = await this.getEntries(sourceSessionId); // chrono order
  const path = walkPathToEntry(sourceEntries, upToEntryId); // root-to-target inclusive
  const now = Date.now();
  const newRow: SessionRow = {
    id: opts.id ?? generateSessionId(),
    name: null,
    cwd: source.cwd,
    parentSession: source.id,
    createdAt: now,
    modifiedAt: now,
    entryVersion: source.entryVersion,
  };
  await this.db.sessions.add(newRow);
  for (const entry of path) {
    if (entry.type === 'label') continue;
    await this.db.entries.add({
      sessionId: newRow.id,
      id: entry.id,
      parentId: entry.parentId,
      timestamp: Date.parse(entry.timestamp),
      type: entry.type,
      data: entry,
    });
  }
  return newRow;
});
```

`walkPathToEntry` is a tiny pure helper — builds `byId` map, walks parentId chain from target to root, reverses. Can live in `core/session/tree.ts` alongside any other small tree helpers we need later.

#### `SessionManager` additions

```ts
async fork(fromEntryId: string): Promise<SessionManager> {
  if (!this.byId.has(fromEntryId)) throw new Error(`unknown entry ${fromEntryId}`);
  const row = await this.store.forkSession({
    sourceSessionId: this.sessionId,
    upToEntryId: fromEntryId,
  });
  return SessionManager.load(this.store, row.id);
}

navigateToLeaf(entryId: string): void {
  if (!this.byId.has(entryId)) throw new Error(`unknown entry ${entryId}`);
  this.leafId = entryId;
}
```

`fork` returns the new SessionManager so callers can immediately activate it. `navigateToLeaf` is synchronous — pure in-memory pointer move. Ephemeral; not persisted. A follow-up in M6.1 or M7 can add a `branchWithSummary` variant that appends a `BranchSummaryEntry` if we decide ephemeral is too surprising.

#### `WorkerAgentHost`

Two new handlers + one bug fix:

```ts
async forkSession(fromEntryId: string): Promise<{ sessionId: string }> {
  const sm = this.sessionManager;
  if (!sm) throw new Error('no active session');
  const forked = await sm.fork(fromEntryId);
  this.sessionManager = forked;
  this.session.reset();
  this.session.restoreMessages(forked.buildSessionContext().messages);
  this.emitSessionLoaded();
  return { sessionId: forked.getSessionId() };
}

async navigateToLeaf(entryId: string): Promise<void> {
  const sm = this.sessionManager;
  if (!sm) throw new Error('no active session');
  sm.navigateToLeaf(entryId);
  // Rebuild the agent's message window from the new branch.
  this.session.reset();
  this.session.restoreMessages(sm.buildSessionContext().messages);
  this.emitSessionLoaded();
}
```

Bug fix to existing `loadSession`:

```ts
async loadSession(sessionId: string): Promise<void> {
  // Flush any queued appends from the previous session, then abort a
  // streaming turn before we swap state out from under it.
  await this.writeChain;
  this.session.abort();
  const sm = await SessionManager.load(this.store, sessionId);
  // ... rest unchanged
}
```

The audit flagged this is latent today — a user who hits "switch session" while a turn is streaming ends up with the streaming message orphaned. M6's branch-switch flow exercises it directly, so fix in this commit.

#### RPC surface

Two new command variants + matching responses (extend `rpc-types.ts`):

```ts
| { id: string; type: 'fork_session'; fromEntryId: string }
| { id: string; type: 'navigate_to_leaf'; entryId: string }
```

Responses:
```ts
| { id; type: 'response'; command: 'fork_session'; success: true; data: { sessionId: string } }
| { id; type: 'response'; command: 'navigate_to_leaf'; success: true }
```

`RpcClient.forkSession(fromEntryId)` + `RpcClient.navigateToLeaf(entryId)`. Both fire and wait for the `session_loaded` event to update main-thread state (same pattern as existing `newSession` + `loadSession`).

#### Main-thread reactivity

New hook `src/hooks/useSessionEntries(sessionId)`:

```ts
export function useSessionEntries(sessionId: string | null): SessionEntry[] {
  const store = getMainStore();
  const result = useLiveQuery(
    () => (sessionId ? store.getEntries(sessionId) : []),
    [store, sessionId],
    []
  );
  return result ?? [];
}
```

Used by the in-session tree UI. Re-renders automatically when the Worker writes.

The existing `useSessionsList` already returns `SessionSummary[]`. To render fork relationships, we need a small derived structure (`SessionTreeForest`) — grouping sessions by `parentSessionPath` on the main thread is cheap enough to do inside the picker (or a derived hook `useSessionForest()`).

### UI additions

1. **`SessionPicker` — fork tree rendering.** Group sessions by `parentSessionPath`. Root sessions render flat; forks nest under their parent with a single level of indent + a ↳ glyph. For the picker's narrow dropdown (420 px), one level is enough; deeper forks just flatten visually but keep the parent breadcrumb in the title line.

2. **Per-message action menu in `ChatMessages` / `ChatMessageBubble`.** Hover menu with two items:
   - `Fork from here` → calls `rpcClient.forkSession(entryId)`.
   - `Branch from here` → calls `rpcClient.navigateToLeaf(entryId)`.
   Entry ids need to be discoverable in the UI; extend message rendering to carry the entry id as a prop / data attribute.

3. **In-session tree indicator.** When the leaf is not at the chronologically latest entry (i.e., the user navigated back), render a subtle badge near the chat input ("on branch" + entry preview) so the user knows their next prompt will start a sibling.

No separate tree panel in the MVP. `getTree()`'s nested output is good raw material for a future tree panel (M7/M8 polish), but for M6 the per-message actions + picker breadcrumb cover the stated scope.

## Files to modify

### Add
- `packages/web-agent/src/web-agent/core/session/tree.ts` — `walkPathToEntry(entries, entryId)` helper + test.
- `packages/web-agent/src/web-agent/core/session/tree.test.ts`.
- `packages/web-agent/src/hooks/useSessionEntries.ts` — liveQuery entry reader.

### Modify
- `packages/web-agent/src/web-agent/core/session/store.ts` — add `forkSession` to the interface.
- `packages/web-agent/src/web-agent/core/session/memory-store.ts` — impl + test coverage.
- `packages/web-agent/src/web-agent/core/session/memory-store.test.ts` — add fork round-trip tests (verbatim id preservation, parentSession set, labels skipped).
- `packages/web-agent/src/web-agent/core/session/dexie-store.ts` — impl.
- `packages/web-agent/src/web-agent/core/session/dexie-store.test.ts` — parity + transactional-all-or-nothing test (mid-tx failure rolls back).
- `packages/web-agent/src/web-agent/core/session/session-manager.ts` — `fork()` + `navigateToLeaf()`.
- `packages/web-agent/src/web-agent/core/session/session-manager.test.ts` — round-trip + negative-case tests.
- `packages/web-agent/src/web-agent/rpc/rpc-types.ts` — new commands + responses.
- `packages/web-agent/src/web-agent/rpc/rpc-client.ts` — client methods.
- `packages/web-agent/src/web-agent/rpc/rpc-server.ts` — dispatch + host methods on `AgentSessionHost` interface.
- `packages/web-agent/src/web-agent/rpc/rpc.test.ts` — round-trip for the new commands.
- `packages/web-agent/src/web-agent/worker/worker-host.ts` — `forkSession`, `navigateToLeaf`, abort-before-reset fix in `loadSession`.
- `packages/web-agent/src/web-agent/worker/worker-host.test.ts` — fork + navigate + abort-on-load tests.
- `packages/web-agent/src/hooks/useAgent.ts` — expose `sessions.fork(entryId)` + `sessions.navigateToLeaf(entryId)` methods.
- `packages/web-agent/src/components/chat/ChatMessages.tsx` (and/or `ChatMessageBubble`) — per-message action menu; thread entry id through props.
- `packages/web-agent/src/components/sessions/SessionPicker.tsx` — forest rendering with one-level indent + breadcrumb.
- `packages/web-agent/e2e/session-persistence.spec.ts` — extend with fork + navigate steps.
- `ai-docs/milestones.md` — mark M6 done, outcome section.
- `ai-docs/05-decisions.md` — D18 (fork storage = full copy), D19 (ephemeral leaf navigation).

## Phasing (single commit at the end; checkpoint commits OK)

Each phase has its own gate: `npm run check` + `npm test` + targeted e2e where applicable.

### Phase 1 — Store layer (½ day)
- `tree.ts` helper + test.
- `SessionStore.forkSession` interface + Memory + Dexie impls.
- Tests for both stores: verbatim copy, parentSession set, label skip, transactional rollback.
- **Gate:** `memory-store.test.ts` + `dexie-store.test.ts` green.

### Phase 2 — SessionManager (½ day)
- `fork(fromEntryId)` + `navigateToLeaf(entryId)`.
- Update `session-manager.test.ts` with round-trip assertions.
- **Gate:** existing + new SM tests green.

### Phase 3 — RPC + WorkerAgentHost (½ day)
- Extend RPC union; add client methods; dispatch on server.
- `WorkerAgentHost.forkSession` + `navigateToLeaf`; abort-before-reset fix in `loadSession`.
- Test: fork + navigate round-trip via in-process transport in `rpc.test.ts`.
- Test: `worker-host.test.ts` new cases for fork, navigate, and aborts-mid-stream on load.
- **Gate:** 156 + ~12 new unit tests green.

### Phase 4 — React + UI (½ day)
- `useSessionEntries` hook.
- `useAgent.sessions.fork` + `.navigateToLeaf` pass-through.
- `ChatMessages` per-message action menu.
- `SessionPicker` forest rendering + breadcrumb.
- Manual Claude-in-Chrome smoke (reload + fork + switch).
- **Gate:** dev-server smoke + existing e2e still green.

### Phase 5 — E2E + docs + commit (½ day)
- Extend `e2e/session-persistence.spec.ts` with `test.step`s:
  - `fork from message X → new session appears in picker with breadcrumb`
  - `new session has copied messages + parentSession set`
  - `switch back to parent → original messages intact`
  - `navigate to earlier entry → badge renders; next prompt branches under it`
- D18 + D19 in `05-decisions.md`.
- M6 outcome paragraph in `milestones.md` (surprises worth recording).
- **Gate:** `npm run test:e2e` green; repo-level `npm run check`.

## Verification

- Repo-level `npm run check` (biome + tsgo + browser-smoke + web-ui + web-agent) clean.
- `cd packages/web-agent && npm test` — target 156 + ~15 new = ~170 tests, all green.
- `cd packages/web-agent && npm run test:e2e` — all 4 existing specs + extended session-persistence spec green.
- Manual browser smoke via Claude in Chrome: reload + fork + switch + navigate-back works across tabs.

## Risks + rollback

- **Fork storage cost if sessions grow large.** Mitigation: ship as-is; add a JSONL-export-and-fork-cap only if real usage hits limits.
- **Ephemeral leaf is surprising for users.** If a user navigates back, reloads the page, and their leaf pops forward to the latest entry, they lose context of "which branch they were on." Documented as a known limitation of MVP. M6.1 can add `branchWithSummary` to persist navigation markers if needed.
- **UI churn in `SessionPicker` risks breaking the `data-testid`s that `session-persistence.spec.ts` depends on.** Keep the existing testids; add new ones (`session-fork-indicator`, `chat-message-fork-action`) without renaming old ones. Lowers e2e breakage risk.
- **Rollback:** Phase 1–2 are pure-data; trivially revertible. Phase 3 introduces new RPC commands (additive; safe to revert). Phase 4 UI changes are contained in 2 components. Worst case: revert the commit, nothing else depends on M6.

## Out of scope

- LLM-generated branch summaries (user rejected scope option 3; revisit in M7/M8 with the extension hook surface).
- Persistent leaf position across reloads (ephemeral in MVP; M6.1 could add a navigation-marker entry).
- Full entry-tree panel UI (current scope uses per-message actions + picker breadcrumb instead).
- Cross-session "view a forked session's tree" — fork navigation is handled by switching sessions; no "browse another session's entries without switching" in MVP.
- Optimising fork storage (COW, parent pointers, deduplication). Re-evaluate only on real telemetry.
