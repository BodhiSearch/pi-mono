# M3 — Session Tree

## What this milestone delivers

The user can fork from any prior message in a session. Forking
creates a new branch inheriting the prefix up to that message; the
original session is untouched. The UI lets the user navigate
branches (parent ↔ child ↔ sibling). All branches persist.

User-facing feature set is what web-agent M6 shipped —
`forkSession`, branch-navigation UI, per-message Fork/Branch
affordances. The ACP-level question is **how do we represent this
on the wire?**

## ACP surface touched

- Likely an **ACP extension.** The reference schema does not carry
  fork/branch semantics. Options to evaluate during the plan:
  - `session/new` with a `parent` parameter in `_meta` → server
    clones history up to a given message ID, returns new session
    ID. App-level UI then navigates between the two.
  - Pure client-side fork — client re-plays the prefix into a new
    `session/new` without any ACP extension. Simplest, but costs
    an LLM round-trip of the prefix.
  - A namespaced notification (`x-bodhiapp/session-fork`) that the
    ACP agent recognises and handles natively.

The plan picks one, documents the choice in `ai-docs/decisions/`.
Principle 6 (ACP extensibility before sub-protocols) applies.

## Depends on

- **M1** — sessions must exist to be forked.
- **M2** — tools must work, because forked branches can continue
  issuing tool calls.

## Out of scope

- Merging branches back together. Not in v1.
- Cross-session forking (fork session A's prefix into session B's
  tail). Not in v1.
- Collaborative branching. Single user.

## Why this ordering

Branching is an amplifier over M1 + M2. It makes sessions and tools
dramatically more useful but adds complexity that would mask bugs
in the underlying layers. Land the flat-session product first; layer
the tree on top.

Flag: this is the first milestone that clearly goes beyond ACP's
shipped surface. It is the canonical test of principle 6 —
demonstrating we can extend without forking the protocol. The
decision here sets precedent for M4 compaction and M5 resources.
