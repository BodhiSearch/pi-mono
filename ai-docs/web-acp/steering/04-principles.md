# Principles — how we work on web-acp

## Why this document exists

These are the rules that survive across plans. When a plan
contradicts a principle, the plan is wrong. When a principle feels
in the way, revisit it — don't quietly bypass.

Each principle has a **why** (so edge cases can be judged) and a
**how** (so you can tell when you are violating it).

---

## 1. `packages/web-acp/` does not depend on `packages/web-agent/` or `packages/coding-agent/`

**Why.** Both are reference material. `web-agent` is a frozen spike
with known architectural compromises we are explicitly moving away
from; importing from it drags its bespoke RPC types and its
mixed-responsibility boundaries back in. `coding-agent` pulls node
`fs` / `child_process` / jiti / `pi-tui`, bundle-breaking in a
browser target. Either import would block the eventual library
extraction.

**How to apply.** Copy the pattern, re-derive the types. The source
trees are crib sheets, not modules. `grep -r
"packages/web-agent\|packages/coding-agent" packages/web-acp/src/`
must always return zero. An architectural lint rule enforces this
once the tree has shape; until then, reviewers enforce it by eye.

## 2. ACP is the wire protocol

**Why.** The whole point of the pivot. If we invent a sibling RPC
for "one small thing ACP doesn't cover yet", we end up with
web-agent's three-parallel-protocols problem again. Worse, we lose
the property that any ACP-speaking client can sit on top of us.

**How to apply.**

- Every client ↔ agent message is an ACP request, notification, or
  response as defined by `agent-client-protocol/schema/schema.json`.
- When ACP appears silent on something we need, the first option is
  an ACP extension via `_meta` fields or a notification in our
  namespace. The second option is contributing upstream. The **last
  resort** is a sub-protocol — and that lands as a decision entry
  explaining why ACP couldn't carry it.
- No bespoke RPC types in `packages/web-acp/src/`. If you are
  tempted to write one, stop and re-read this principle.

## 3. Transport is swappable

**Why.** The browser Worker is the default deployment, not the only
one. ACP is a network-shape protocol; we must be able to frame it
over HTTP/SSE or WebSocket for remote-agent deployments without
touching the framing, the protocol, or the agent. If `MessagePort`
leaks into the framing code today, the remote transport is a
rewrite later.

**How to apply.**

- The framing layer (JSON-RPC 2.0 encode/decode + message dispatch)
  imports nothing from `Worker`, `MessagePort`, the DOM, or Node's
  `stream`. It takes a minimal transport adapter as a constructor
  argument.
- At least two transport implementations exist by the end of M0.b:
  the real `MessageChannel` one and an in-memory test double. The
  second proves the boundary is where we think it is.
- A CI grep must assert:
  `grep -r "MessagePort\|new Worker" packages/web-acp/src/<framing-path>/`
  returns zero.

## 4. Storage is IndexedDB, not OPFS

**Why.** Unchanged from web-agent. OPFS does not serialise writes
across tabs; concurrent writes produce torn bytes with no error
surface. We will not ship a library that corrupts user state when
the user opens a second tab. IndexedDB transactions serialise
naturally and abort atomically.

**How to apply.** All app-owned storage (`/sessions`, `/extensions`,
any future app-owned mount) uses the `@zenfs/core` IndexedDB backend.
`/vault` is the exception — user's real disk via FSA, concurrent-tab
writes are the user's problem. If a proposal reaches for OPFS, the
answer is no unless a new decision entry explains what changed about
the concurrency story.

## 5. Agent subtree imports inward only

**Why.** Library extraction. If the agent-side code imports from
`@/lib/bodhi-models` (app code) or from React context providers
(client-side), the agent package can't ship without dragging the
reference app along. The agent takes its dependencies as
constructor arguments, not as side-imports.

**How to apply.**

- Inside the agent subpath under `packages/web-acp/src/` (exact
  directory settled at M0), no import may start with `@/` or cross
  into the client side.
- Allowed imports: `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`,
  `@sinclair/typebox`, the ACP library (once chosen), standard
  browser globals that exist in both Worker and Window scopes.
- Anything the agent needs that isn't in that list is a constructor
  argument.

## 6. ACP extensibility before sub-protocols

**Why.** We will want affordances ACP doesn't yet cover — fork,
branch, compact, skills. The temptation is to add a second channel.
Resist it.

**How to apply.** Order of preference:

1. Can it be expressed with existing ACP methods? Use them.
2. Can it be an ACP extension (`_meta`, a notification in our
   namespace)? Prefer this.
3. Does the ACP project have an RFD for this? Contribute upstream.
4. Last resort — a sub-protocol, documented in a decision entry
   with the explicit reason ACP couldn't carry it.

## 7. Test-driven, black-box, Playwright-first

**Why.** Carried from web-agent. The library will be embedded in
consumer apps. Tests reaching into internals via `page.evaluate` /
`exposeFunction` / `window.*` singletons prove nothing about
consumer-visible behaviour.

**How to apply.**

- Playwright specs interact via locators, clicks, visible assertions
  only. No `page.evaluate` into ZenFS, the transport, or the ACP
  client.
- Pre-render state priming via `page.addInitScript` + the
  `import.meta.env.DEV`-gated `useDevSeedBoot` seam **is allowed**:
  feeds inputs in before the app runs, doesn't sidestep the app's
  paths.
- **Testable internal state via `data-testid` + `data-test-state`.**
  Components that carry runtime state expose a `data-testid` for
  selection and a `data-test-state="…"` attribute for state
  assertions (e.g. `data-test-state="idle|mounting|mounted|error"`
  on a volumes panel; `data-test-state="running|completed|failed"`
  on a tool-call bubble). This is how internal state becomes
  observable without `page.evaluate`.
- **No `page.waitForTimeout` in new specs.** Wait on observable
  state via `expect(locator).toHaveAttribute('data-test-state',
  '<value>')` or equivalent assertions. If you reach for
  `waitForTimeout`, either the product is missing a
  `data-test-state` hook (add one) or the test is over-reaching
  (tighten the assertion).
- **DEV-only deterministic test toggles are allowed** when they
  replace a `page.evaluate` workaround. The `forceToolCall`
  feature in M2 is the canonical example: a DEV-gated toggle
  that passes `tool_choice: 'required'` to pi-ai so a benign
  prompt reliably triggers a tool call. Production builds
  hide the toggle; the e2e harness stays black-box.
- Unit tests (vitest) may go deeper — they test pieces. Framing
  round-trips, transport double, tool-operation adapters,
  session-store behaviour.
- Rule of thumb: if deleting a test would let the e2e silently pass
  on a broken product, keep it.

## 8. Few high-value e2e tests, `test.step` per concern

**Why.** E2E is slow and brittle. A flood of thin specs is worse
than a handful of rich ones because each failure involves Bodhi +
Chrome + real LLM traffic.

**How to apply.**

- One spec per milestone is the default, not the floor.
- Inside each spec, use `test.step("does X", …)` liberally. Each
  step carries its own assertions and shows up as a report line
  item.
- Prefer asserting observable consequences (file exists with
  content Y, chat panel shows text Z) over intermediate state.

## 9. Unit tests earn their keep

**Why.** Trivial glue tests rot fast. Meanwhile, ACP framing, tool
operations, transport boundary correctness, session-store semantics
are subtle enough to warrant unit coverage.

**How to apply.** Write unit tests for ACP envelope round-trips,
transport adapter behaviour against a test double, tool-operation
adapters against an InMemory ZenFS, session-store serialisation,
permission-policy edge cases. Do not write unit tests for pass-through
hooks with no logic or trivial getters.

## 10. Plans disposable, steering durable, decisions append-only

**Why.** Carried from web-agent. Plans change every session; if
they live next to steering they churn it. Decisions that get
revisited lose their rationale if overwritten.

**How to apply.**

- Per-milestone plans at `ai-docs/web-acp/plans/mN-<name>.md`.
  Disposable.
- Steering at `ai-docs/web-acp/steering/*.md` — vision, goals,
  architecture, principles. Durable. Update in place.
- Decisions append-only at `ai-docs/decisions/` (shared with
  web-agent's historical log; new entries are dated and scoped
  `web-acp:`).
- Milestone previews at `ai-docs/web-acp/milestones/mN-*.md` —
  non-committal one-pagers. Detail lives in the per-milestone plan
  when that milestone is picked up.

## 11. Ask before widening scope

**Why.** Silent scope creep breaks the phased contract and makes
diffs unreviewable.

**How to apply.**

- The milestone's plan file lists in-scope and out-of-scope items.
  Notice something outside? Either add it to the plan (and get
  approval) or file it as an explicit follow-up.
- Use `AskUserQuestion` with two branches when unsure. Never
  "just do it" silently.
- "It'll only take a minute" is exactly the wrong reason to widen
  scope. If it's that small, it's also cheap to do in a follow-up.

## 12. Don't silently bypass the phase gate

**Why.** The gate is what makes each commit shippable. Working
around a gate failure with `// @ts-ignore` or a skipped test breaks
the milestone contract, and the next milestone starts from a broken
foundation.

**How to apply.** Every gate item must pass before a milestone is
declared done. If a real reason makes a gate item impossible, write
it into `ai-docs/decisions/` with the tradeoff explained; update the
gate, don't bypass it. New `any`, new `@ts-ignore`, new skipped
tests require the same decision record.

## 13. Extensions are a late milestone

**Why.** web-agent's extension runtime consumed a full milestone
(M8) and closed Phase 3 by dropping isolation entirely. The trust
model works only because extensions are manually installed into the
user's vault. None of that reasoning should constrain M0–M2's ACP
design. Extensions re-enter **after** sessions, tools, compaction
are solid, and they re-enter by asking "how does ACP extend?"

**How to apply.** Do not pre-design the extension runtime into the
M0–M4 ACP surface. When extensions re-enter, the starting question
is: what ACP extension mechanism carries tool registration,
lifecycle hooks, custom providers? Blob-URL loading is an
implementation detail of web-agent, not a requirement we inherit.

## 14. Agent owns all tool surfaces; filesystem ownership follows the richest tool's interface

**Why.** ACP puts tool execution on the agent by design. Moving
tool execution to the client (Variation C in
[`02-architecture.md`](./02-architecture.md#acp-architectural-postures))
inverts the spec and forces a non-ACP wire for every tool
invocation.

Filesystem ownership is a corollary, not an independent choice.
ACP's `fs/*` surface defines only two primitives
(`fs/read_text_file`, `fs/write_text_file`) — an editor-buffer
bridge, not a general VFS. If the agent's richest tool needs an
FS interface that `fs/*` cannot carry — as just-bash's `IFileSystem`
(~25 methods) demonstrably does — then the agent owns the
filesystem directly. Forcing a rich shell tool through 12 custom
`_bodhi/fs/*` extension methods is worse for ACP compliance than
mounting the FS on the agent and advertising `fs/*` as an
IDE-integration seam.

**How to apply.**

- Every LLM-facing tool lives in the agent. Clients render and
  gate; they do not execute. If a proposal reaches for
  client-side execution of a generic tool, revisit this principle
  first.
- Filesystem primitives (`fs/read_text_file`, `fs/write_text_file`)
  stay advertised from M2.4 onward even when the default agent
  tools don't use them. The advertisement preserves compliance;
  the non-use is documented.
- When a new tool's FS needs exceed what `fs/*` can carry, do not
  add `_bodhi/fs/readdir`, `_bodhi/fs/stat`, etc. Mount the FS on
  the agent and document the divergence in
  [`02-architecture.md`](./02-architecture.md).

## 15. Extension methods are `_`-prefixed and namespaced

**Why.** ACP 0.6+ reserves `_`-prefixed method names for
application-specific extensions per
`agent-client-protocol/docs/protocol/extensibility.mdx`. Collisions
with future upstream method names are prevented by namespacing
under a vendor prefix.

**How to apply.**

- All web-acp extension methods start with `_bodhi/` and use
  slash-separated sub-namespaces, e.g. `_bodhi/mcp/setServers`,
  `_bodhi/skills/activate`, `_bodhi/providers/nativeTools`,
  `_bodhi/log`.
- `_meta` fields on standard ACP methods follow the same prefix
  rule for custom keys (`_meta._bodhi/*`).
- Extension methods declared constants in `acp/index.ts` —
  never inlined at the call site — so a single rename sweep
  fixes them when an upstream ACP method covers the same
  ground.
- When upstream ACP adds a native method for something we
  currently ship as `_bodhi/*`, the migration is:
  1. Advertise both for one milestone (capability-gated on
     the client).
  2. Switch to upstream.
  3. Remove the `_bodhi/*` in the next release after a
     decision entry documenting the swap.

## 16. When evidence surprises you, write it down

**Why.** Non-obvious discoveries rot the moment the session ends.
"ACP schema field X is actually required" / "`MessageChannel`
transfers semantics surprised us" — costs the next session an hour
to rediscover.

**How to apply.**

- Short comment in code for micro-surprises, commit message note
  for one-off cross-session ones, decision entry for
  permanent-behaviour ones.
- If a build step has side-effects beyond what its name suggests,
  document it (web-agent's `packages/ai` `build` regenerating
  `models.generated.ts` from live APIs is the canonical example).
