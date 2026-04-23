# M4 — Compaction

## What this milestone delivers

Long sessions survive past the model's context window. The agent
detects when context usage crosses a configurable threshold,
summarises the earlier turns, replaces them with a compact summary,
and continues. Users can also trigger compaction manually. The
summary is visible in the UI as a "context summarised here" bubble
and persists with the session.

## ACP surface touched

Same ACP-extension question as M3. Options:

- A namespaced notification (`x-bodhiapp/session-compacted`) that
  carries the summary payload and the range of replaced messages.
  Client renders the summary bubble.
- Encode the summary as a synthetic assistant message in the
  transcript with an agreed `_meta.role` tag. Client renders
  differently based on the tag.
- Contribute an ACP RFD upstream if compaction is becoming a
  common pattern across ACP agents.

Principle 6 applies. The plan picks the path and documents it.

## Depends on

- **M1** — compacted summaries must persist alongside the session.
- **M3** is **not** a hard dependency — compaction can land on
  flat sessions first and layer into the tree later.

## Out of scope

- Extension hooks on compaction (`before_compact`, `after_compact`).
  That's M6, when extensions re-enter.
- Configurable summarisation prompts. v1 uses a hardcoded
  compaction prompt; exposing it is a follow-up.
- Cross-session summarisation ("remember everything about my
  project"). Different feature, not compaction.

## Why this ordering

Compaction is only visible once sessions are long enough to need
it. That means at least M1 (persistence so long sessions survive)
and ideally M2 (tools, because tool loops are what push context
usage up fast). Before M1 and M2, compaction has no customers.

Landing compaction before M5/M6 (resources and extensions) because
those layers want to hook into compaction. Better to stabilise the
compaction behaviour first, then expose hooks on a known surface
than to negotiate both at once.
