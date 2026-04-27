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

## Provider-native tool passthrough — carved out of M3.3

**What was deferred.** Per-model toggles for provider-native
tools (OpenAI `web_search`, Anthropic `web_search`, etc.),
capability discovery via a new `_bodhi/providers/nativeTools`
extension method, per-session persistence of which native tools
are enabled, and the provider → ACP `tool_call` /
`tool_call_update` passthrough.

Originally scoped as M3.3 with four piece-parts:

- `_bodhi/providers/nativeTools` (client → agent request) so the
  settings UI can render supported native tools per model. `pi-ai`
  already knows which provider exposes which native tool; the
  adapter just needs to surface that map.
- Settings UI with per-model toggles (default off) wired to the
  existing `_bodhi/features/*` pattern (or a sibling surface
  depending on discovery UX).
- Per-session persistence of enabled native tools, extending the
  `bodhi/getSession` snapshot with a `nativeTools` field so
  reloads rehydrate the toggle state.
- Passthrough: when a toggled-on native tool fires mid-turn, the
  agent observes the provider's tool-call events from the SSE
  stream and re-emits them as standard ACP
  `session/update (tool_call)` + `tool_call_update` + result,
  preserving the tool name, arguments, and output for the UI.

**Why deferred.** M3 targets a clean MCP-over-HTTP landing: the
generic tool-registration wire (`<srv>__<tool>` namespacing,
refcounted pool, per-session toggles) is a foundation that
provider-native tools can layer onto without churning. Splitting
the two lets M3's diff stay focused on the MCP transport and
proxy story, and avoids entangling per-model toggle plumbing with
the MCP toggle plumbing. The UI affordance is identical
(`tool_call` in the transcript), so the passthrough piece is a
small follow-up that does not reshape the shipped M3 wire.

**When it re-enters.** At a milestone kickoff after M3 exit —
typically alongside either M4 (commands + skills) or a dedicated
short milestone if the permission bridge re-enters first. The
re-entry ticket covers:

1. `_bodhi/providers/nativeTools` request wiring in
   `AcpAgentAdapter` + `AcpClient`.
2. Per-model toggle UI — either a new panel or an extension of
   the existing feature-toggle surface.
3. Per-session persistence: extend `BodhiGetSessionResponse` with
   `nativeTools` and hydrate on `loadSession`.
4. Provider-side passthrough in `BodhiProvider` /
   `InlineAgent` so tool-call events land as ACP notifications.

**What has to exist before re-entry** (satisfied by M3 exit):

- Tool registry composes MCP + `bash` through a single path
  (`InlineAgent.setModel({ tools })`) — native tools slot in the
  same way.
- `bodhi/getSession` snapshot returns per-session state and
  `session/load` rehydrates it — `nativeTools` extends the
  existing shape without a schema churn.
- `tool_call` / `tool_call_update` emission is fully exercised by
  the MCP path — native tools reuse it verbatim.

**ACP-compliance note.** Deferral does not move the compliance
row: provider-native tools, when they land, ride the stable
`session/update (tool_call)` wire. The row in the compliance-at-
a-glance table is marked `deferred (see deferred.md)` while the
feature is not shipped.

---

## M0 hardening — second transport + worker-boundary e2e

**What was deferred.** Two items the original M0.b gate listed
that the phase-D rework did not carry:

1. A minimal **in-memory test-double transport** paired with
   `createMessagePortStream` so unit tests can frame-round-trip
   the ACP stack without spinning up a real `MessageChannel`.
   Forces the framing-layer interface boundary to be real per
   principle § 3 (transport swappable).
2. A **worker-boundary e2e assertion** — one Playwright step
   confirming the worker boundary is real (e.g. a worker-only
   global is not on `window`, or the worker's module graph
   doesn't leak into the page's).

Both are recorded in [`m0-foundation.md`](m0-foundation.md) §
"M0 hardening follow-up" but were not surfaced here when M1
landed.

**Why deferred.** Phase D's rework already proved the framing
layer separates cleanly from `MessagePort`-specific code (M1's
persistence work became the second consumer of the client
surface, exercising the same code paths a remote-agent transport
will). The two items are belt-and-braces, not blocking. M1's
real consumer was a stronger swappability proof than a synthetic
test-double would have been on the M0 timeline.

**When it re-enters.** Opportunistically. The natural time is
the milestone that introduces the second transport for real
(e.g. an HTTP/SSE remote-agent path during M8 polish + extract,
or a dedicated short milestone if a third-party consumer needs
one earlier). The worker-boundary assertion can ride any
Playwright sweep that touches `useAcp` boot.

**What has to exist before re-entry** (already satisfied):

- The framing layer (`packages/web-acp/src/transport/`) imports
  zero `MessagePort` / `Worker` / DOM references — verified at
  M0 phase D's grep gate.
- `createMessagePortStream` is the only `MessagePort` consumer
  in the framing path; a sibling test-double can plug in via
  the same `{readable, writable}` shape.

**ACP-compliance note.** No compliance row affected — this is
internal correctness scaffolding, not protocol surface.

---

## `bodhi/*` → `_bodhi/*` extension-method rename

**What was deferred.** Renaming the three M0/M1 extension
methods that pre-date principle § 15 (`_`-prefixed, namespaced
extension methods) so the wire is consistent:

- `bodhi/listModels` → `_bodhi/listModels` (or a structured
  sub-namespace such as `_bodhi/models/list`).
- `bodhi/listSessions` → `_bodhi/sessions/list`.
- `bodhi/getSession` → `_bodhi/sessions/get`.

The newer M2/M3/M3.5 extension methods (`_bodhi/volumes/list`,
`_bodhi/features/{list,set}`, `_bodhi/mcp/toggles/set`,
`_bodhi/sessions/delete`) already follow the convention.

**Why deferred.** The unprefixed names predate the principle
that codified the rule; they are wire-compatible with the
current SDK and changing them is a breaking change to clients
that may already snapshot the constants. The code at
`packages/web-acp/src/acp/index.ts` flags this explicitly:

> M2 extension methods use the spec-blessed `_`-prefix; the
> older `bodhi/*` constants above stay unchanged to preserve
> M1 client-side contracts (a rename is tracked as a deferred
> cleanup item).

We chose hygiene over churn at M2 kickoff and have not
re-litigated since.

**When it re-enters.** At the M8 library-extraction milestone,
or earlier if an unrelated breaking change to the extension
surface is already in flight. The migration ladder per
principle § 15:

1. Advertise both the old and new method names for one
   release; route them to the same handler.
2. Switch the in-tree client (and any consumer the library
   gains) to the new names.
3. Remove the legacy aliases in the next release after a
   decision entry documenting the swap.

**What has to exist before re-entry** (already satisfied):

- Extension methods declared as constants in
  `packages/web-acp/src/acp/index.ts` rather than inlined at
  call sites — a single rename sweep covers every consumer.
- A documented migration ladder in principle § 15.

**ACP-compliance note.** Compliance row "Extension methods" in
[`index.md`](index.md) currently reads "compliant" because
principle § 15 explicitly carries the legacy aliases as a
documented carry-over. The rename closes that hedge cleanly
without changing the row.

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
