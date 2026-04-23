# web-acp — M1 ACP Sessions — delivery plan

Status: **shipped** across four phase commits on `main`.

Milestone: [`../milestones/m1-sessions.md`](../milestones/m1-sessions.md).
Kickoff prompt: [`../prompts/002-m1-sessions.md`](../prompts/002-m1-sessions.md).

## Overview

Ship persistence, listing, and resumption of ACP sessions behind
a worker-owned Dexie store. `session/new` stays unchanged;
resumption uses ACP's stable `session/load` with verbatim replay
of stored `SessionNotification`s; listing uses a Bodhi
extension method until the upstream `session/list` leaves
unstable. A companion `bodhi/getSession` snapshot call restores
the UI and the per-session model selector in one hop.

## Decisions settled before plan time

- **Resume path:** ACP stable `session/load`. Advertised via
  `agentCapabilities.loadSession: true` at Phase C entry.
  Justification: principle 6 (ACP extensibility before
  sub-protocols); `session/load` is in `schema.json`, not
  `schema.unstable.json`; pi-acp implements it identically at
  `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/src/acp/agent.ts`;
  the remote-agent transport later requires agent-authoritative
  state.
- **Store owner:** Worker (`AcpAgentAdapter`). Main thread stays
  a presenter. Matches the `bodhi/listModels` pattern already in
  `packages/web-acp/src/acp/agent-adapter.ts`. Alternatives
  (client-authoritative / stateless coordinator) rejected —
  both require bespoke `_meta` extensions that violate
  principle 2.
- **Listing surface:** Bodhi ext method `bodhi/listSessions`.
  Upstream `session/list` exists in the SDK but is declared
  only in `schema.unstable.json`; M0 committed to stable
  schema. When upstream stabilises, the method id renames and
  the response shape is compatible.
- **Replay shape:** Verbatim re-emission of stored
  `SessionNotification`s. Matches ACP's "stream the entire
  conversation history back to the client via notifications"
  language in `schema.json § LoadSessionRequest`. Companion
  `bodhi/getSession` returns a collapsed
  `{messages, lastModelId, title}` so the UI can rehydrate in
  one call without aggregating replay deltas.
- **Model restoration:** `modelId` is stored on every
  end-of-turn `entries.kind === 'turn'` row. `bodhi/getSession`
  returns the last-seen `modelId` as `lastModelId`; the hook
  uses it to snap the model selector when loading a session.
  Reference pattern: `packages/coding-agent/` stores
  `modelId` per session in its session row.
- **No `schemaVersion` column.** ACP does not define one at
  store granularity. Introducing one pretends to solve
  forward-compat without buying us anything; schema migration
  is addressed in the milestone that actually needs it.
- **M0 hardening items** (second transport, worker-boundary
  e2e) — **deferred** per user decision. Not part of M1.

## What ships end-to-end

- A user who refreshes mid-session finds the session in the
  picker, opens it, and the transcript re-renders exactly as
  it was — including the model selected for that session.
- The picker lists past sessions newest-first with a truncated
  title derived from the first user prompt.
- "+ New chat" leaves the active session in the list and
  starts a fresh one with an empty `InlineAgent`.
- `chat.spec.ts` remains untouched and green at every commit.
- Two new e2e specs (`sessions-persist.spec.ts`,
  `sessions-resume.spec.ts`) cover persist, list, and switch.
- `.env.test` provisions both an OpenAI and an Anthropic
  model so the resume spec can prove per-session model
  rehydration across two providers.

## Architecture at exit

```mermaid
sequenceDiagram
  participant UI as ChatDemo / SessionPicker
  participant Hook as useAcp
  participant Client as AcpClient
  participant Adapter as AcpAgentAdapter
  participant Store as SessionStore (Dexie in worker)
  participant Inline as InlineAgent

  UI->>Hook: loadSession(id)
  Hook->>Client: loadSession(id)
  Client->>Adapter: session/load
  Adapter->>Store: readEntries(id)
  Store-->>Adapter: entries[]
  loop each notification entry
    Adapter->>Client: sessionUpdate (replay; bypasses #emit)
  end
  Adapter->>Inline: restoreMessages(lastTurn.finalMessages)
  Adapter->>Adapter: #activeInlineSessionId = id
  Adapter-->>Client: {modes: null, configOptions: null}

  Hook->>Client: getSession(id)
  Client->>Adapter: bodhi/getSession
  Adapter->>Store: readEntries + session row
  Adapter-->>Client: {messages, lastModelId, title}
  Hook-->>UI: setMessages + selectedModel = lastModelId
```

## Phase A — Worker-side session store (no UI surface)

Shipped as commit `49a55bc4 — web-acp: M1 phase A — worker-side session store`.

- New `packages/web-acp/src/agent/session-store.ts` — Dexie schema + CRUD.
- New `packages/web-acp/src/agent/session-store.test.ts` — vitest coverage.
- `InlineAgent.restoreMessages` / `getMessages` added.
- `AcpAgentAdapter.newSession` / `#emit` / `prompt` wired to the store.
- Spec updates: new [`../specs/web-acp/sessions.md`](../specs/web-acp/sessions.md);
  edits to `index.md`, `agent.md`, `acp.md`.

## Phase B — List sessions (`bodhi/listSessions` + picker)

Shipped as commit `bcfbd07d — web-acp: M1 phase B — list sessions via bodhi/listSessions`.

- New ext method `bodhi/listSessions` + `AcpClient.listSessions`.
- `useAcp` gains `sessions` + `refreshSessions`.
- New `SessionPicker` component (read-only for this phase).
- `.env.test` provisions a second (Anthropic) model;
  `global-setup.ts` exposes both ids.
- New `packages/web-acp/e2e/sessions-persist.spec.ts`.
- Spec updates: `sessions.md`, `acp.md`, `hook.md`,
  `startup-sequence.md`.

## Phase C — Resume sessions (`session/load` + switcher)

Shipped as commit `e4c1ad6c — web-acp: M1 phase C — resume sessions via session/load`.

- `initialize` advertises `agentCapabilities.loadSession: true`.
- `AcpAgentAdapter.loadSession` implemented; replay bypasses
  `#emit` to avoid double-persist; `InlineAgent` seeded from
  last `turn.finalMessages`.
- `bodhi/getSession` ext method returns the collapsed
  `{sessionId, messages, lastModelId, title}` snapshot.
- `#activeInlineSessionId` + `prompt` mismatch guard +
  `#rehydrateInlineFromStore` ensure a session's
  `InlineAgent` state cannot leak into another session's
  `finalMessages`.
- `useAcp.loadSession` + `currentSessionId` +
  `isLoadingSession` + `isReplayingRef` (silences the live
  update handler during replay).
- `SessionPicker` click wired to `loadSession`; active row
  gets `data-teststate="active"`.
- New `packages/web-acp/e2e/sessions-resume.spec.ts` covers
  two-model session switching + follow-up prompt DOM
  witness.
- Spec updates: `sessions.md`, `acp.md`, `hook.md`,
  `startup-sequence.md` (new Phase 2.5), `index.md`.

## Phase D — Polish + M1 exit

Shipped as commit `web-acp: M1 phase D — session polish + M1 exit gate`.

- Milestone doc [`../milestones/m1-sessions.md`](../milestones/m1-sessions.md)
  marked "shipped" with decision log + tests inventory.
- This plan lands as the authored delivery record.
- Next-milestone kickoff prompt
  [`../prompts/003-m2-tools.md`](../prompts/003-m2-tools.md)
  drafted (skeleton per plan scope).
- Final M1 kickoff prompt
  [`../prompts/002-m1-sessions.md`](../prompts/002-m1-sessions.md)
  formalised — records the brief a future executor would
  follow to reproduce M1.
- Stretch scope (rename / delete UI + a richer
  `sessions-lifecycle.spec.ts`) **cut** at Phase D scope
  review: current picker ergonomics are sufficient and the
  three-spec e2e suite already exercises persist + list +
  switch end-to-end.

## Gates

All four phase commits passed:

- `npm run check` green (biome + tsgo root + per-package
  lint + typecheck).
- Web-acp vitest: 13 tests across 2 files green.
- Web-acp Playwright: `chat.spec.ts`,
  `sessions-persist.spec.ts`, `sessions-resume.spec.ts` all
  green with real-LLM traffic.

## Risks realised + how they resolved

- **InlineAgent cross-session history leak.** Found during
  Phase C e2e: "+ New chat" → prompt on the new session
  persisted the *previous* session's messages into the new
  session's `finalMessages`, because `pi-agent-core`'s
  `Agent` keeps a single message history. Fixed by
  tracking `#activeInlineSessionId` on the adapter and
  clearing / restoring the inline runtime at every session
  boundary (`newSession`, `loadSession`, and a guard in
  `prompt`).
- **`waitServerReady` hang on page reload.** The setup
  modal walker in the e2e page object unconditionally
  waited for the iframe; after a reload the Bodhi auth
  tokens survived and the modal never appeared. Fixed by
  making the walker conditional on the overlay being
  visible.
- **`App.test.tsx` vitest fail under jsdom.** Pre-existing
  issue surfaced by `npm test`: jsdom has no `Worker`.
  Added a `NoopWorker` stub in
  `packages/web-acp/src/test/setup.ts`.
- **ESLint `set-state-in-effect`.** Introducing
  `setSessions([])` directly in an effect tripped the rule.
  Refactored to an async IIFE with a `cancelled` flag —
  the standard pattern.

## Out of scope (M1) — explicit

- Fork / branch / navigate — M3.
- Compaction entries — M4.
- Cross-tab live session-list updates — post-v1.
- Encryption at rest — post-v1.
- LLM-generated titles (truncated-prefix title is
  sufficient) — post-v1 if ever.
- Upstream `session/list` adoption — revisit when it
  stabilises; migration is a renamed constant + unchanged
  response shape.
- Second (test-double) transport + worker-boundary e2e
  assertion — still an M0 follow-up, not bundled here per
  user decision.
- Rename / delete UI — parked as M1.x if product pushes
  for it, otherwise picked up opportunistically in M5.
