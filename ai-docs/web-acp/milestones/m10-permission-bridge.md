# M10 — Permission bridge + allow-always persistence

**Status:** planned. Re-entry of the deferred M2.3 scope
(bash destructive-command gating + ACP
`session/request_permission` + allow-always persistence). See
[`deferred.md`](deferred.md) § "Permission bridge — carved out
of M2.3".

**Host scope.** Agent-primary. Browser host addendum inline under
§ "Browser host addendum".

## What this milestone delivers

Users see a confirmation prompt before the agent runs a
destructive bash command (`rm`, `mv`, `cp`, `mkdir`, `chmod`,
`sed -i`, redirect writes, etc.). They can accept once, accept
always, or reject. Allow-always decisions persist on the session
record; a settings panel exposes the current allow-always list
+ a reset button. The permission bridge also covers MCP tools
and extension-registered tools through the same ACP surface, so
the gating behaviour is uniform.

## Why this landed after extensions / fork / compaction

The permission bridge pre-execution hook shares code with the
extension `tool_call_pre` lifecycle hook from M6. Landing
extensions first means the permission bridge plugs into a stable
hook registry rather than inventing one. The bridge also
interacts with every tool registered through that registry
(built-in `bash`, MCP tools, extension-registered tools), so
landing it after M3 + M6 means one pass covers all tools
uniformly.

The bridge also deliberately ships after basic M6–M9 capability
work lands because it changes user-perceived latency (every
destructive command adds a round-trip). Debugging capability
bugs under the gate is harder than debugging them without; we
want a known-good capability baseline before the gate enters.

## ACP compliance header

**Posture.** Fully ACP-canonical. Rides the stable
`session/request_permission` primitive. No new extension
methods in the default path. Allow-always persistence is a
session-local concern surfaced through the standard `LoadSessionResponse._meta.bodhi`
envelope (principle § 12).

This **moves web-acp from "deferred (non-compliant)" to
"compliant"** on the permission row of the compliance-at-a-
glance table.

## Depends on

- **M1** — session persistence (allow-always lives on the
  session row).
- **M2** — `bash` tool registered and emitting `tool_call`.
  The classifier targets the same `BashTransformPipeline` shape
  just-bash exposes.
- **M3** — MCP tool registration path. The classifier + bridge
  covers MCP tools uniformly so destructive MCP tools
  (hypothetical `filesystem__rm` or similar) get the same gate.
- **M5** — engine split. The bridge wraps
  `PromptTurnDriver`'s tool-binding step through the
  `bindAbortSignal`-style pattern.
- **M6** — extensions. Extension-registered tools inherit the
  bridge without extra plumbing; the bridge fires
  `tool_call_pre` on the extension bus before the classifier
  decision, so extensions can pre-approve / pre-reject
  commands programmatically (e.g. an always-allow extension
  for a team's trusted CI runner).

## ACP surface touched

- **`session/request_permission`** — stable, spec-defined.
  Agent issues it with a `ToolCall` describing the pending
  script + the classifier's flagged destructive commands;
  user's `allow_once` / `allow_always` / `reject_once` response
  flows back; the bash driver either proceeds or returns a
  `cancelled` tool-call status.
- **`_meta.bodhi.allowAlwaysCommands: string[]`** on
  `LoadSessionResponse._meta.bodhi` — per-session persisted
  allow-always patterns. Ignorable by clients that don't know
  about it; the host's settings panel renders the list.
- No new extension methods. Reset is a host-side action that
  calls the existing `Agent.setSessionConfigOption` surface
  (new config ids under `_bodhi/features/allowAlways<key>`) or
  a dedicated `_bodhi/permissions/reset` ext method if the
  plan decides a structured mutation is cleaner. Decision at
  M10 kickoff; pattern-reset inside allow-always is a small
  wire decision, not a posture change.

## Sub-milestones

### M10.1 — Classifier + `session/request_permission` bridge

Deliverables:

- `agent/tools/permission-classifier.ts` — parses each script
  via the published `just-bash` `BashTransformPipeline` shape
  and classifies commands:
  - **allow-list** (no confirmation): `cat`, `ls`, `grep`,
    `rg`, `find`, `head`, `tail`, `wc`, `stat`, `file`,
    `tree`, `diff`, `which`, `echo`, `printf`, `basename`,
    `dirname`, `jq`, `yq`, `sort`, `uniq`, `cut`, `awk`
    (read-only patterns only), `sed -n`, pipes, `cd`,
    variable assignments, `for` / `while` loops without
    destructive bodies, subshells around allowed commands.
  - **confirm-list** (require permission): `rm`, `rmdir`,
    `mv`, `cp`, `mkdir`, `touch`, `chmod`, `ln`, `sed -i`,
    redirect writes (`>`, `>>`, `2>`), `tee`, `source` / `.`
    of user-supplied paths.
  - **deny-by-default**: anything not in either list (and
    therefore a new class of command the classifier doesn't
    know about).
- Deny-by-default posture keeps the door closed on new
  destructive commands. Users can add patterns to the
  allow-list through the settings UI; plan decides the
  persistence path (likely session-local first, global via
  extension if demand emerges).
- Bridge: before invoking the `bash` tool, the `PromptTurnDriver`
  calls the classifier; if the script contains confirm-list
  commands (and none are allow-always'd for this session), it
  emits `session/request_permission` with a `ToolCallUpdate`
  describing:
  - The full script excerpt.
  - The classifier's flagged destructive commands (for each,
    the matched command + arguments + the working directory
    context so `rm -rf /mnt/wiki` is visibly distinct from
    `rm -rf /tmp`).
  - Three `PermissionOption` entries: `allow_once`,
    `allow_always` (with the canonicalised pattern),
    `reject_once`.
- On `reject_once` / timeout / cancellation, the bash tool
  returns a `cancelled` `AgentToolResult` — the LLM sees the
  cancellation in its next turn and can adapt.
- MCP tool + extension tool coverage: the bridge's hook
  location (wrapping `tool.execute`) fires uniformly. Tools
  declare a `destructiveHint: boolean` on registration
  (default `true` for tools that mutate filesystem / network /
  shell; `false` for read-only tools). Tools without a
  classifier (all tools except `bash`) opt into the gate via
  the hint; no bespoke classifier per tool in v1.

Gate items:

- Unit: classifier correctly categorises a fixture set of
  safe + destructive scripts. False-positive and
  false-negative catalogues explicitly captured.
- Unit: `session/request_permission` wire round-trip — bridge
  emits correct shape; accept / reject paths both land the
  expected downstream state.
- Real-LLM e2e: prompt "Delete README.md from /mnt/wiki";
  confirm the permission dialog appears; accept; assert the
  tool-call completes and the file is gone. Second run: reject;
  assert tool-call is `cancelled` and the file still exists.

### M10.2 — Allow-always persistence + settings panel

Deliverables:

- `allowAlwaysCommands: string[]` on the session row (Dexie v5
  migration). Patterns canonicalised at store time (e.g.
  `rm -rf /mnt/wiki/**` stored as a normalised form; the
  classifier matches against the normalised form at check
  time).
- Bridge honours allow-always: classifier output filtered by
  matching patterns before deciding to prompt. Patterns are
  session-local — cross-session carry-over is deferred.
- `LoadSessionResponse._meta.bodhi.allowAlwaysCommands`
  surfaces the current set.
- Host settings panel:
  `packages/web-acp/src/components/permissions/PermissionsPanel.tsx`
  — lists the active patterns with a per-row `[remove]`
  button and a top-level `[reset all]` button. `data-testid`
  hooks for Playwright.
- Settings page integrates the panel alongside Volumes, MCP,
  Extensions, Features.

Gate items:

- Unit: allow-always pattern persists; second invocation of
  the matching command does not prompt.
- Unit: `[remove]` and `[reset all]` flows work; subsequent
  matching commands prompt again.
- Real-LLM e2e: prompt destructive command; `allow_always`;
  same-pattern follow-up runs silently; reset; follow-up
  prompts again.

### M10.3 — Exit gate

Deliverables:

- Compliance row flip: "Permission" from `deferred` to
  `compliant` in [`index.md`](index.md).
- `rg "request_permission|allow_always|permission-classifier"
  packages/web-acp(-agent)?` returns non-empty (feature
  present) and `rg "deferred.*permission bridge"
  ai-docs/web-acp/milestones/` returns only the historical
  reference in `deferred.md` (entry preserved for
  traceability; marked as re-entered).
- Updated specs under
  [`../specs/web-acp-agent/`](../specs/web-acp-agent/) and
  [`../specs/web-acp-client/`](../specs/web-acp-client/) cover
  the classifier, the bridge, and the settings panel.

## Browser host addendum (`packages/web-acp/`)

**Scope.**

- `useAcpPermissions` slice hook that implements the
  `Client.requestPermission` callback. Opens a modal dialog
  with the permission options; resolves with the user's
  choice; times out per a configurable setting (default 60s,
  times-out → `reject_once`).
- Permissions panel in settings (see M10.2).
- Reducer arm for `allowAlwaysCommands` updates derived from
  `LoadSessionResponse._meta.bodhi.allowAlwaysCommands`.

**Host hard constraints.**

- The modal dialog is **modal** — subsequent prompts queue.
  Concurrent permission requests are rare (one per tool call)
  and the ACP SDK serialises them; the host only has to
  handle one at a time.
- The permission UI shows the full script excerpt + each
  flagged destructive command distinct from the rest of the
  script (syntax highlight if available, plain text
  otherwise). Do not truncate the script.
- No "accept all pending" affordance. Each prompt is a
  deliberate decision.

## Out of scope

- **Allow-always across sessions.** Session-local only in v1.
  Cross-session carry-over is a future settings-panel feature
  once there's demand.
- **Per-command timeout configuration.** One global timeout.
- **Automatic classifier updates** (new destructive commands
  landed via `just-bash` upgrades). Manual review + manual
  allow-list update on upgrade. CI grep on `just-bash` version
  bumps warns the maintainer to re-audit.
- **Destructive MCP tool classification beyond the `destructiveHint`
  opt-in.** MCP doesn't publish per-tool destruction semantics;
  opt-in is the simplest safe default.
- **A global allow-list editor in settings.** v1 shows the
  current session's allow-always + a reset button; adding
  patterns is only possible via `allow_always` on a live
  prompt.

## Cross-references

- Original deferred entry:
  [`deferred.md`](deferred.md) § "Permission bridge — carved
  out of M2.3".
- Tool-registration path: [`m2-tools.md`](m2-tools.md) (shipped).
- MCP tool registration: [`m3-mcp.md`](m3-mcp.md) (shipped).
- Extension tool contribution: [`m6-extensions.md`](m6-extensions.md).
- Principle § 9 (pluggable interfaces), § 12 (extra `_meta`
  fields must be ignorable):
  [`../steering/04-principles.md`](../steering/04-principles.md).
