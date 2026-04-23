# M0 — Foundation

## What this milestone delivers

The smallest possible end-to-end proof that `packages/web-acp/`
works: a user mounts a local folder, opens a chat, asks a real LLM
a narrow question, and sees the answer. Shipped in two sub-steps so
the ACP framing can enter without blocking the first real-LLM e2e.

- **M0.a** — scaffold + `/vault` mount + real-LLM e2e. Agent runs
  **inline** on the main thread. No ACP framing yet; the goal is to
  prove the wiring (React + ZenFS + FSA + LLM call + Playwright
  real-LLM harness) end-to-end.
- **M0.b** — agent moves **behind a Worker boundary**. The
  `MessageChannel` between main and Worker carries JSON-RPC 2.0
  ACP frames, not a bespoke protocol. The same M0.a e2e still
  passes; one additional e2e proves the Worker boundary is real.

Both sub-steps live in this milestone because M0.a alone isn't
enough to claim "ACP-based agent" — M0.b is where the protocol
actually enters.

## ACP surface touched

- **M0.a** — **none.** Agent calls `pi-ai` directly, in-process. No
  ACP client, no ACP agent, no framing. This is deliberate: we do
  not build ACP wiring against an inline agent only to rewrite it at
  M0.b.
- **M0.b** —
  - `initialize` (client → agent on startup, capability negotiation).
  - `session/new` (client creates a session).
  - `session/prompt` (client sends user input).
  - `session/update` notifications (agent streams tokens back).
  - `session/cancel` (client aborts the turn).
  - Errors via standard JSON-RPC 2.0 error envelope.

No `fs/*` delegation yet — file tools enter at M2. Until then,
M0.b's agent answers prompts that don't require vault reads.

## Depends on

Nothing. This is the first milestone.

## Out of scope

- Session persistence. Sessions live in memory; page reload loses
  them. That's M1.
- Filesystem tools. The agent does not read or write `/vault` files
  in M0; it just answers the prompt. Tools are M2.
- Permission / confirmation prompts. No destructive operations to
  guard yet.
- Session tree, compaction, skills, extensions. Later milestones.
- HTTP/SSE transport. M0.b ships the `MessageChannel` transport
  and one test-double transport — the swappability **discipline** is
  a gate item, but the remote transport itself is not in M0.

## Why this ordering

**M0.a before M0.b.** Building the FSA + ZenFS + Playwright real-LLM
harness is substantial. Bolting on Worker + ACP framing before that
harness is proven adds failure modes to a single PR. We take a
cheap shortcut (inline agent) to get the hardest-to-test bits
landed, then do the ACP wiring against a known-good baseline.

**ACP framing at M0.b, not M1.** Once we have a working inline
agent, the temptation is to ship sessions (M1) before moving to ACP.
Resist. Adding ACP to an agent that already has session semantics
in its bespoke shape means re-deriving those semantics a week later.
Do the protocol pivot **before** the protocol has consumers.

**Two transport implementations at M0.b.** Principle 3 (transport
swappable). If only the `MessageChannel` transport exists, we cannot
know if the framing leaks `MessagePort`. A minimal in-memory
test-double transport (used in vitest) forces the interface
boundary to be real.

## Gate items specific to M0

Standard gate (`npm run check` clean, e2e green) plus:

- **M0.a** — real-LLM e2e passes in CI with `.env.test` credentials.
  DOM-witness assertions only. `packages/web-agent/e2e/` conventions
  carried in spirit (page objects, `installVault` seed).
- **M0.b** — all of M0.a's e2e, plus:
  - grep for `MessagePort\|new Worker` in the framing subpath returns
    zero.
  - framing round-trip vitest using the test-double transport.
  - one Playwright spec step asserting the Worker boundary is real
    (e.g., a worker-only global is not on `window`).

## Open questions (resolve during the plan, not here)

- Exact directory layout under `packages/web-acp/src/` — one agent
  subtree vs a top-level split (`client/`, `agent/`, `transport/`,
  `acp/`). Propose at plan time; the steering doc is deliberately
  silent.
- ACP library dependency — consume reference TS impl, vendor a
  subset, or hand-roll. Recommend + get sign-off at M0.a plan.
- Permission policy defaults — settle before M0.a has any
  destructive-tool UI. M0.a probably has no destructive tools, so
  this may slip to M2; note it in the plan.
- `.env.test` location — copy `packages/web-agent/e2e/.env.test`
  (or its committed `.example`) across to `packages/web-acp/e2e/`
  at plan time, provided the 001-explore constraint allows it.

## Success criteria summary

- **M0.a complete** when: a fresh browser session can pick a
  folder, see it mounted at `/vault`, send a prompt, see streaming
  output, and the Playwright e2e passes in CI against a real LLM.
- **M0.b complete** when: the same user flow works with the agent
  running in a Web Worker and ACP JSON-RPC 2.0 framed over
  `MessageChannel`; the framing is transport-agnostic (second
  transport impl proves it); `npm run check` clean.
