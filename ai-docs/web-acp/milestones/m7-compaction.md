# M7 — Compaction

## What this milestone delivers

Long sessions survive past the model's context window. The agent
detects when context usage crosses a configurable threshold,
summarises the earlier turns, replaces them with a compact summary,
and continues. Users can also trigger compaction manually (via the
`/compact` slash command from M4). The summary is visible in the
UI as a "context summarised here" bubble and persists with the
session.

## ACP surface touched

Options to evaluate during the plan (principle 6 + principle 15):

- A namespaced notification (`_bodhi/session/compacted`) that
  carries the summary payload and the range of replaced messages.
  Client renders the summary bubble.
- Encode the summary as a synthetic assistant message in the
  transcript with an agreed `_meta.role` tag. Client renders
  differently based on the tag.
- Contribute an ACP RFD upstream if compaction is becoming a
  common pattern across ACP agents.

The plan picks the path and documents it.

## Depends on

- **M1** — compacted summaries must persist alongside the session.
- **M4** — `/compact` slash command. Manual compaction uses the
  M4 command surface.
- **M5** — extensions may hook `before_compact` / `after_compact`;
  the extension runtime must exist so hooks have somewhere to
  register.
- **M6** is **not** a hard dependency — compaction can land on
  flat sessions first and layer into the fork tree later
  (compacted parent branch → forked child inherits the summary).

## Out of scope

- Configurable summarisation prompts. v1 uses a hardcoded
  compaction prompt; exposing it is a follow-up.
- Cross-session summarisation ("remember everything about my
  project"). Different feature, not compaction.

## Why this ordering

Compaction is only visible once sessions are long enough to need
it. That means at least M1 (persistence so long sessions survive),
M2 (tools, because tool loops are what push context usage up
fast), and ideally M3 (MCP extends the tool catalog and further
amplifies context usage). Before those, compaction has no
customers.

Landing compaction after M5 (extensions) because extensions may
want to hook `before_compact` / `after_compact` to edit or tag the
summary. Better to stabilise the compaction behaviour and the
extension hook surface in one milestone than to negotiate both
separately.

Landing after M6 (session tree) because the fork operation
interacts with compaction — does a compacted branch propagate the
summary to its children on fork? Having fork stable at M6 means
M7 can answer that cleanly (recommendation: yes, the summary is
copied; the child can re-expand by forking from the original
pre-compact branch if it still exists).
