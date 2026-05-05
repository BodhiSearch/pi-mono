# M9 — Compaction

**Status:** planned. Re-sequenced from the original M7 slot. Ships
after extensions (M6) and session tree (M8) so compaction hooks
plug into a stable extension surface and fork interactions are
already in place.

**Host scope.** Agent-primary. Browser host addendum inline under
§ "Browser host addendum".

## What this milestone delivers

Long sessions survive past the model's context window. The agent
detects when context usage crosses a configurable threshold,
summarises the earlier turns, replaces them with a compact
summary, and continues. Users can also trigger compaction
manually via a new `/compact` built-in slash command. The summary
is visible in the UI as a "context summarised here" bubble and
persists with the session; extensions can observe and optionally
edit the summary through `before_compact` / `after_compact`
lifecycle hooks (landed through the M6 extension surface).

## ACP compliance header

**Posture.** Native ACP wire where possible, `_bodhi/*` extension
otherwise. ACP has no dedicated compaction primitive; the plan
picks between two compliant options at kickoff and documents the
decision:

- **Option A — ride the transcript.** Encode the compacted
  summary as a synthetic assistant message in the transcript with
  an agreed `_meta.bodhi.compacted = { replacedSeqRange:
  [lo, hi], summaryModelId }` marker. Clients that don't know
  about the marker still render the message (principle § 12);
  clients that do render it with a "context summarised here"
  affordance.
- **Option B — namespaced notification.** Emit a
  `_bodhi/session/compacted` extension notification carrying
  the summary payload and the range of replaced messages.
  Clients render a distinct summary bubble. The on-store
  representation is either a new `'compacted'` `SessionEntry`
  kind or the same synthetic-message approach from Option A.

Plan at kickoff picks one; the other carries as a deferred
re-entry if upstream ACP eventually defines compaction.

## Depends on

- **M1** — compacted summaries persist alongside the session.
- **M4** — `/compact` rides the built-in slash-command surface
  alongside `/help`, `/version`, `/info`, `/copy`, `/mcp`.
- **M5** — engine split. The compaction path lives under
  `acp/engine/` (new `compaction-driver.ts` alongside
  `prompt-driver.ts`); replay walker already supports filtering
  on specific entry kinds.
- **M6** — extension runtime; extensions hook `before_compact` /
  `after_compact`.
- **M8** is **not** a hard dependency — compaction can land on
  flat sessions first and layer into the fork tree later
  (compacted parent branch → forked child inherits the summary).
  M8 lands first so that interaction is testable at M9 exit.

## ACP surface touched

- **`/compact` built-in slash command.** Agent-handled in
  `agent/commands/builtins/compact.ts` — intercepts before the
  LLM, runs the compaction driver, emits the summary via the
  chosen wire path (Option A or B), persists the compacted
  entry. Feels identical to `/help` from the user's side
  (`agent_message_chunk` or notification stamped with the
  builtin marker).
- **Auto-compaction threshold.** Agent emits compaction when
  token usage against the active model exceeds a configurable
  ratio (default `0.85` of `contextWindow`). Threshold lives on
  a new feature toggle `_bodhi/features/autoCompactEnabled`
  (default `true`) and a numeric setting
  `_bodhi/features/autoCompactThreshold` (0..1, default 0.85).
  Principle § 15 naming; rides existing config-option surface.
- **`before_compact` / `after_compact` extension hooks.** New
  `LifecycleEvents` entries in the M6 `ExtensionContext` API:
  - `before_compact: (sessionId, { range, prompt })` — the
    extension can mutate the prompt to steer the summarisation
    style.
  - `after_compact: (sessionId, { range, summary })` — the
    extension can read the summary or edit it before it hits
    the store / wire (returning a new summary string replaces
    the agent's version; `undefined` means "unchanged").

## Sub-milestones

### M9.1 — Compaction driver + `/compact` built-in

Deliverables:

- `acp/engine/compaction-driver.ts` — summarises a given range
  of session entries by calling the active model with a
  dedicated compaction prompt (`COMPACTION_SYSTEM_PROMPT`
  constant in `agent/system-prompt.ts`). The driver is a
  single-turn LLM call that produces a plain-text summary;
  rides through the existing `streamFn` so cancellation and
  token accounting work for free.
- `agent/commands/builtins/compact.ts` — `/compact` built-in.
  No arguments in v1 (compacts everything older than the most
  recent N turns where N is configurable on the same feature
  surface). `/compact --range 1-10` arg parsing is deferred to
  a follow-up slice.
- On-store representation: picks Option A or B at kickoff.
  Persistence happens through `SessionStore` in the same
  transaction that records the replaced-range removal, to
  ensure the store never observes a half-compacted session.
- `handleLoadSession` replay walker recognises compacted
  entries and emits the rendering marker back to the client.

Gate items:

- Unit: compaction driver over a fixture transcript produces
  a non-empty summary under the chosen wire shape.
- Unit: `/compact` built-in run end-to-end; assert store has
  the compacted entry; subsequent `session/load` replays the
  summary in place of the replaced range.
- Real-LLM e2e: seed a session with 20+ turns; invoke
  `/compact`; assert the summary bubble renders; follow-up
  prompt succeeds under the compacted context.

### M9.2 — Auto-compaction + extension hooks

Deliverables:

- Token-usage accountant in `prompt-driver.ts` (or a new
  `token-accountant.ts` sibling) that reads the LLM's
  `usage` field + the active model's `contextWindow` and
  fires compaction when the ratio crosses the configured
  threshold. Runs before the next turn to avoid mid-turn
  interruptions.
- Feature surface: `_bodhi/features/autoCompactEnabled`
  (boolean, default `true`);
  `_bodhi/features/autoCompactThreshold` (number 0..1, default
  0.85). Exposed through `Agent.setSessionConfigOption` using
  the existing ACP 0.21 config-option wire (see
  `acp/feature-config.ts`).
- `before_compact` / `after_compact` hooks fire from the
  compaction driver. M6's `LifecycleEvents` type gains these
  two entries; extension authors upgrade the type on activate.
- Skills + extensions interplay: compaction preserves the
  active-skill set (active skills are a session attribute, not
  a transcript attribute — their `systemPromptAddition` gets
  re-applied on every post-compaction turn).

Gate items:

- Unit: auto-compaction triggers at >=85% usage; does not
  trigger below threshold; respects the disable toggle.
- Unit: extension `before_compact` mutates the prompt and the
  driver uses the mutated prompt; extension `after_compact`
  replaces the summary and the replacement lands on the store.
- Real-LLM e2e: drive a long session in DEV with a reduced
  auto-compact threshold (dev env var `VITE_WEB_ACP_AUTOCOMPACT_THRESHOLD=0.3`);
  assert compaction fires mid-session without user
  intervention.

### M9.3 — Fork interaction + exit gate

Deliverables:

- Forking from a compacted session carries the compacted
  entries into the child by default. The child can
  `/compact` again (re-summarising on top of existing
  summaries) or re-fork from a pre-compact ancestor if the
  parent still exists.
- Gate item: Playwright — fork at message 5 on a session with
  a compact at messages 1-3; child shows both the compact
  bubble and the forked-in messages 4-5. Re-run `/compact` on
  the child; parent's compact is unaffected.

## Browser host addendum (`packages/web-acp/`)

**Scope.**

- Reducer arm in `streamingReducer` (or `panelsReducer`,
  depending on the chosen wire shape) for the compaction
  marker. Renders a distinct bubble with muted background,
  left-accent line, and a `[show replaced messages]` toggle
  (deferred to M9.3 polish if budget tight — ship the bubble
  first).
- Settings page adds toggles for
  `autoCompactEnabled` + `autoCompactThreshold`. Threshold is
  a numeric slider (0..1).
- `ChatInput` advertises `/compact` through the same picker
  that shows `/help` etc. — no host work needed beyond the
  agent emitting the built-in through
  `available_commands_update`.

## Out of scope

- **Configurable summarisation prompts from the user.** v1
  uses a hard-coded `COMPACTION_SYSTEM_PROMPT`; exposing it via
  the vault (`<mount>/.pi/compaction.md`?) is a follow-up.
- **Cross-session summarisation** ("remember everything about
  my project"). Different feature, not compaction.
- **Partial / range compaction with user-visible controls.**
  `/compact --range` arg parsing lands post-M9.
- **Summary quality metrics.** No evaluation harness for the
  compaction driver's output quality in v1.

## Why this ordering

Compaction is only visible once sessions are long enough to need
it. That means at least M1 (persistence so long sessions survive),
M2 (tools, because tool loops are what push context usage up
fast), and ideally M3 (MCP extends the tool catalog and further
amplifies context usage). Before those, compaction has no
customers.

Landing compaction after M6 (extensions) because extensions may
want to hook `before_compact` / `after_compact` to edit or tag
the summary. Better to stabilise compaction behaviour and the
extension hook surface in one milestone than to negotiate both
separately.

Landing after M8 (session tree) because the fork operation
interacts with compaction — does a compacted branch propagate the
summary to its children on fork? Having fork stable at M8 means
M9 can answer that cleanly (recommendation: yes, the summary is
copied; the child can re-expand by forking from the original
pre-compact branch if it still exists).

## Cross-references

- M6 extensions (hook surface dependency):
  [`m6-extensions.md`](m6-extensions.md).
- M8 session tree (fork-compaction interaction):
  [`m8-session-tree.md`](m8-session-tree.md).
- Principle § 12 (extra `_meta` fields must be ignorable):
  [`../steering/04-principles.md`](../steering/04-principles.md).
