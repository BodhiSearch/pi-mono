# Plan — delete-session button (web-acp, ACP-compliant)

## Context

`packages/web-acp/` ships M3 with sessions persisted in a Dexie store
and a left-rail `SessionPicker` UI, but there is no way for a user to
remove a session — list grows monotonically. The store already has
an atomic `deleteSession(id)` (`packages/web-acp/src/agent/session-store.ts:151`,
impl `:241–248`) with cascade across `entries / features / mcpToggles`,
and a passing unit test
(`packages/web-acp/src/agent/session-store.test.ts:166–178`). Wire and
UI surfaces are greenfield.

Goal: surface a one-click delete affordance per row in `SessionPicker`,
flow it through an ACP-compliant extension method, and — when the
currently-active session is the one being deleted — cancel in-flight
work first, then reset to a fresh new session via the existing
auto-create flow.

## ACP posture

ACP has **no stable** `session/delete` verb. `session/close` exists in
`schema.unstable.json` but its semantics are "cancel ongoing work and
free in-memory resources", not "remove from persistent storage" —
wrong tool. Per
[`steering/04-principles.md`](../web-acp/steering/04-principles.md) §
15 ("All web-acp extension methods start with `_bodhi/` and use
slash-separated sub-namespaces"), the new method is
**`_bodhi/sessions/delete`**, mirroring the shape of the existing
`_bodhi/mcp/toggles/set` and `_bodhi/features/set` handlers.

For the in-flight cancel before destruction we reuse the **stable
ACP** verb `session/cancel` rather than inventing anything — that's
exactly what it's for.

## Wire contract

Add to `packages/web-acp/src/acp/index.ts` next to the existing
`_bodhi/*` constants:

```ts
export const BODHI_SESSIONS_DELETE_METHOD = '_bodhi/sessions/delete';

export interface BodhiSessionsDeleteRequest extends Record<string, unknown> {
  sessionId: string;
}
export interface BodhiSessionsDeleteResponse extends Record<string, unknown> {
  deleted: boolean;
}
```

Empty / boolean-only response is sufficient — caller refreshes the
list separately. `deleted: false` is reserved for "no such session";
the worker still resolves rather than throwing so the client can
treat repeat-deletes as idempotent.

## Files to change

| Layer | File | Edit |
| --- | --- | --- |
| Wire constants | `packages/web-acp/src/acp/index.ts` | Add `BODHI_SESSIONS_DELETE_METHOD` + req/resp types |
| Client wrapper | `packages/web-acp/src/acp/client.ts` | Add `deleteSession(sessionId): Promise<boolean>` calling `conn.extMethod(...)` |
| Agent adapter | `packages/web-acp/src/acp/agent-adapter.ts` | New branch in `extMethod` (around line 477, just before the throw) — validate `sessionId`, call `this.#store.deleteSession(req.sessionId)` if store exists, return `{ deleted: true }`. Throw the same `no session store configured` error as `BODHI_GET_SESSION_METHOD` when `#store` is null |
| Hook | `packages/web-acp/src/hooks/useAcp.ts` | Add `deleteSession(id)` callback. If `id === currentSessionId`: `await runtime.client.cancel(_session)` (swallow errors), then `clearMessages()` (already at `:774`, resets `_session`/`currentSessionId`/messages). Then `await runtime.client.deleteSession(id)`, then `await refreshSessions()`. The existing auto-create effect (`:642`, gated on `currentSessionId == null`) takes over and provisions a fresh session |
| Picker UI | `packages/web-acp/src/components/chat/SessionPicker.tsx` | Add `onDelete: (id) => void` prop. Restructure each `<li>` so the row content is a `<button>` (existing) plus a sibling delete button using `lucide-react`'s `Trash2` icon, `data-testid={`session-delete-${session.id}`}`, hidden until row hover (`opacity-0 group-hover:opacity-100`). Click stops propagation and calls `onDelete(id)`. Per user decision, **no confirmation** — single click deletes |
| Picker host | `packages/web-acp/src/components/chat/ChatDemo.tsx` | Pull `deleteSession` from `useAcp()` and pass as `onDelete={deleteSession}` to `SessionPicker` |

## Tests

| Layer | File | Cases |
| --- | --- | --- |
| Adapter unit | `packages/web-acp/src/acp/agent-adapter.test.ts` (extend) | (a) `_bodhi/sessions/delete` calls store.deleteSession and returns `{ deleted: true }`; (b) missing `sessionId` throws; (c) no-store throws the standard message |
| Store unit | `packages/web-acp/src/agent/session-store.test.ts` | already covers deleteSession — no change |
| E2E | new `packages/web-acp/e2e/sessions-delete.spec.ts` (or extend an existing sessions spec under `e2e/`) | One spec, multiple `test.step`s per `04-principles.md` § 8: (1) create two sessions, switch to the older one, click delete on the *inactive* one, assert it disappears from `[data-testid=session-picker]` and the active row stays unchanged; (2) click delete on the *active* row, assert: in-flight cancel observable (no streaming chunks land after), picker no longer shows that id, transcript is empty (`message-bubble` count 0), and a brand-new session id appears in `data-testid=session-picker` once `ensureSession` rehydrates |

E2E selectors already exist on the rows (`session-row-${id}`,
`session-picker`, `data-testsessions`); the new `session-delete-${id}`
button keeps the same naming convention so `e2e/tests/pages/ChatPage.ts`
extension is mechanical.

## Out of scope

- Bulk / multi-select delete.
- Undo / soft-delete.
- A confirmation modal (user opted out — single-click delete).
- Renaming the legacy `bodhi/listSessions` / `bodhi/getSession` to the
  underscored namespace (already tracked as deferred cleanup at
  `packages/web-acp/src/acp/index.ts:26–28`).
- ACP `session/close` adoption — different semantics; revisit if/when
  it stabilises and we want a "free resources but keep on disk" verb.

## Verification

- `cd packages/web-acp && npm run check` — lint + typecheck clean.
- `cd packages/web-acp && npm test` — vitest green; new
  agent-adapter cases included.
- `cd packages/web-acp && npm run test:e2e -- sessions-delete` —
  Playwright spec passes against the real-LLM harness in
  `e2e/tests/global-setup.ts`. Confirm via `--reporter=list` that
  both `test.step` rows ran.
- Manual smoke (dev server): `npm run dev`, log in, send a turn in
  one session, create a second session, hover the inactive row →
  trash icon appears → click → row vanishes; switch to a session,
  click delete on the active row → transcript clears, a new empty
  session appears in the picker.

## Steering / spec follow-ups

- Append a row to the "ACP compliance at a glance" table in
  [`ai-docs/web-acp/milestones/index.md`](../web-acp/milestones/index.md)
  under "Session deletion" — `web-acp posture: _bodhi/sessions/delete
  (no ACP equivalent)`, status `compliant (extension)`.
- If `specs/web-acp/sessions.md` exists, document the new wire shape
  there alongside `bodhi/listSessions` / `bodhi/getSession`. If it
  doesn't, no spec churn — the constants in `acp/index.ts` are
  self-documenting for now.
