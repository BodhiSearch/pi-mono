# M1 — ACP Sessions

## What this milestone delivers

A user's chat survives a page reload. They can leave a session,
come back later, and pick up where they left off. They can list
past sessions and switch between them. Sessions are ACP sessions
— the object of record is whatever `session/new` returns, plus
the transcript of `session/update` events.

## ACP surface touched

- `session/new` — create a new session, receive its ID.
- `session/prompt` + `session/update` — the turn loop from M0.b,
  now with transcripts being persisted.
- `session/cancel` — unchanged from M0.b.
- Session ID + capabilities round-trip from `initialize`.
- App-level persistence layer (not ACP): `/sessions/<id>/meta.json`,
  `/sessions/<id>/messages.jsonl` via ZenFS + IndexedDB.

Whether "resume a session" is an ACP concept (some flavour of
`session/load`) or purely an app-level re-create-and-replay is an
**open question for the plan**. The reference ACP repo and pi-acp
should both be read for prior art before the plan is drafted.

## Depends on

- **M0.b** — ACP framing over transport must be real before sessions
  can be anything more than in-memory scratch.

## Out of scope

- Fork / branch / navigate — that's M3.
- Compaction of long transcripts — M4.
- Multi-user / multi-device session sync — post-v1.
- Encrypting sessions on disk — post-v1.

## Why this ordering

Persistence needs ACP to be the authoritative message shape. If we
persist web-agent-style messages and then retrofit ACP, we rewrite
the serialiser. Do it ACP-native from the start.

Persistence before tools (M2) because the e2e becomes much harder
to debug once tools fire — being able to reload a broken state and
inspect it saves hours.
