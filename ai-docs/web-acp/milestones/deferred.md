# Deferred — web-acp post-v1 carry-overs

Items carved out of milestones during execution because they
layer cleanly onto a shipped foundation rather than reshape it.
Each entry captures **what was dropped**, **rationale**, and
**what has to exist** before it re-enters so the next milestone
isn't blocked on it.

Sibling doc for historical context:
[`ai-docs/web-agent/milestones/deferred.md`](../../web-agent/milestones/deferred.md)
— mirrors this structure for the web-agent spike's post-v1
items (extension sandboxing, full shell, multi-tab collab,
RAG, voice).

---

## Permission bridge — carved out of M2.3

**What was deferred.** The pre-execution command classifier,
ACP `session/request_permission` wiring from the bash tool,
and the allow-once / allow-always / reject-once prompt UX.

Originally scoped to M2.3 with three piece-parts:

- A `BashTransformPipeline` plugin that parses each script and
  classifies commands into allow-list (`cat`, `ls`, `grep`,
  `rg`, `find`, `head`, `tail`, `wc`, `stat`, `file`, `tree`,
  `diff`, `which`, `echo`, `printf`, `basename`, `dirname`,
  `jq`, `yq`, `sort`, `uniq`, `cut`, `awk` (read-only
  patterns), `sed -n`, pipes, `cd`, variable assignments),
  confirm-list (`rm`, `rmdir`, `mv`, `cp`, `mkdir`, `touch`,
  `chmod`, `ln`, `sed -i`, redirect writes (`>`, `>>`, `2>`),
  `tee`), and deny-by-default.
- ACP bridge: confirm-list commands issue
  `session/request_permission` with a `ToolCallUpdate`
  describing the script excerpt + flagged destructive
  commands; the user's response flows back and the adapter
  either proceeds or emits a `cancelled` tool-call status.
- Settings UI exposing the classifier's allow-list / confirm-
  list tables so users can audit behaviour.

**Why deferred.** M2 targets functional completeness of the
tool loop: the agent must be able to read, search, and write
the user's folders via a single `bash` tool. Destructive-
command gating is a layer on top of the tool wire, not a
reshape of it. Landing it later keeps M2's diff focused on the
multi-volume mount + just-bash wiring, and lets us validate
the tool ergonomics with real LLM traffic before choosing a
gating granularity. The user running M2 operates entirely on
their own disk through a browser they trust; a temporary
"commands execute as-is" posture is not a new safety compromise.

**When it re-enters.** At the milestone kickoff that follows
M2 exit, once we've observed a few weeks of bash-tool usage.
The re-entry ticket covers:

1. Classifier plugin against the published `just-bash`
   `BashTransformPipeline` shape.
2. ACP permission bridge (`session/request_permission` —
   stable method, already spec'd).
3. Settings UI + reset.

**What has to exist before re-entry** (satisfied by M2 exit):

- `bash` tool registered with `pi-agent-core`'s tool registry
  and emitting `session/update (tool_call)`.
- `session/cancel` wired to a per-turn `AbortController`.
- Volume mounts advertised to the system prompt so the
  classifier can reason about paths.

**ACP-compliance note.** While deferred, web-acp is
**non-compliant on the "destructive-command consent" expectation**
implied by ACP's permission primitives. The compliance-at-a-
glance table in
[`index.md`](index.md) records the row as
`deferred (see deferred.md)` with this entry as the reference.

---

## Allow-always persistence — carved out of M2.3

**What was deferred.** Per-session memory of
`allow_always` permission decisions, persisted on the session
record and surfaced via `bodhi/getSession` on reload. Settings
UI exposing the session's current allow-always set + a reset
button.

**Why deferred.** Follows the permission bridge — the data
structure is meaningless without the bridge that writes to it.
Listed as a separate entry so when the bridge re-enters, the
persistence layer is already scoped (session-local, no cross-
session carry-over, reset on "new session").

**When it re-enters.** Same milestone as the permission bridge,
same ticket.

**What has to exist before re-entry** (satisfied by M2 exit):

- `SessionStore` with persisted session records (M1).
- `bodhi/getSession` snapshot for on-reload rehydration (M1).
- Per-session feature record (`features` slot on the session —
  M2.2) — the same persistence shape extends naturally to
  `allowAlwaysCommands: string[]`.

---

## How to add a deferred entry

When carving something out of an in-flight milestone:

1. Append a new `## <name> — carved out of M<n>.<slice>` section.
2. Document **what was deferred** concretely (list the
   piece-parts, cite the original scope).
3. Capture **why deferred** in one paragraph — the decision has
   to survive the session that made it.
4. State **when it re-enters** (milestone or trigger).
5. List **what has to exist before re-entry** so the re-entry
   ticket can verify its prerequisites in one pass.
6. Note any **ACP-compliance implication** if the deferral
   changes a row in the compliance-at-a-glance table.
7. Update [`index.md`](index.md) and the affected milestone
   doc in the same commit.

Deferred entries are append-only within a milestone: if the
decision is revisited (say, the bridge re-enters partially),
add a follow-up paragraph noting the change rather than
editing history.
