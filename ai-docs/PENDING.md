# Pending — deferred work with a known ask

Short, factual notes of work explicitly deferred mid-session. Each entry
points at the trigger (what user need brings it back) and the shape of the
fix so a future session can pick it up without rediscovering it.

---

## Coding-agent JSONL export / import round-trip

**Deferred during:** Dexie session-storage migration (2026-04-20).

**Why deferred.** The Dexie migration collapsed the `/sessions` ZenFS JSONL
storage into IDB rows. Coding-agent still reads/writes the original JSONL
wire format, so round-tripping a session between web-agent and coding-agent
no longer works out of the box.

**What brings it back.**
- A user asks to "open this web-agent chat in coding-agent" (or the reverse).
- An extension that needs to emit a coding-agent-compatible archive ships.

**Shape of the fix.**
- Add `SessionStore.exportJsonl(sessionId): Promise<string>` that produces the
  exact `session` header + `SessionEntry` JSONL stream coding-agent expects
  (ids, parentIds, timestamps in ISO form).
- Add `SessionStore.importJsonl(text: string): Promise<SessionRow>` that
  `parseJsonl`-s the content, creates a new row, and bulk-inserts the entries
  preserving ids + timestamps + parent links (not re-allocating).
- Both helpers live at the store layer so every implementation gets them;
  SessionManager gains thin wrappers that call the active store.
- `CURRENT_SESSION_VERSION` already matches coding-agent; no schema bump.

**Explicit non-goals of the deferred item.** Live sync / streaming interop.
It's a manual export/import flow, not a shared protocol.
