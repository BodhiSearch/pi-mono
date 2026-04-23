# M0 — Foundation

**Status:** shipped (commits from `web-acp_m0_phased_rework_eb57e580.plan.md`,
phases A–D).

**Canonical specs:** [`../specs/web-acp/`](../specs/web-acp/) —
especially [`startup-sequence.md`](../specs/web-acp/startup-sequence.md)
for end-to-end "what happens when" across boot, auth, catalog,
and first prompt.

## What this milestone delivered

The smallest end-to-end proof that `packages/web-acp/` works: a
user logs into Bodhi, the UI fetches the model catalog from a
Web Worker over ACP, picks a model, sends a prompt, and sees a
streaming answer — with the existing Playwright e2e
(`chat.spec.ts`) green against a real LLM at every commit.

Shipped in four phases (A–D in the rework plan, not M0.a / M0.b
as originally proposed):

- **Phase A — MCP removal.** Stripped the M0-unsafe MCP surface
  (hooks, components, deps) from the pre-rework `useAgent`
  runtime. MCP requirement deferred to
  [`m2-tools.md § M2.3`](m2-tools.md#m23--mcp-proxy-tools-over-acp).
- **Phase B — Inline agent extraction.** Moved
  `BodhiProvider` + `createStreamFn` + the `pi-agent-core`
  wrapper out of the hook into `src/agent/*`. `useAgent`
  became a thin adapter over `InlineAgent` on the main
  thread (no worker yet, no ACP framing).
- **Phase C — ACP scaffolding.** Added
  `@agentclientprotocol/sdk@0.17.0`; stubbed `src/acp/*`,
  `src/transport/worker-stream.ts`, `src/agent/agent-worker.ts`
  with type-checked but un-wired shells so Phase D could
  flip the pivot in one reviewable step.
- **Phase D — Worker + ACP pivot (the one protocol step).**
  Filled in `AcpAgentAdapter`; wired `AcpClient`;
  renamed `useAgent` → `useAcp`; routed
  `initialize` / `authenticate` / `bodhi/listModels` /
  `session/new` / `session/prompt` / `session/update` /
  `session/cancel` through `ClientSideConnection` +
  `MessageChannel`. `ChatDemo` swapped its import; the UI
  contract stayed unchanged.

## ACP surface shipped

Phase D wired these methods end-to-end:

- `initialize` (main → worker) — capability negotiation;
  advertises the `bodhi-token` auth method.
- `authenticate` (main → worker) — accepts `{token, baseUrl}`
  through `_meta`; Bodhi-specific via
  `BODHI_AUTH_METHOD_ID = 'bodhi-token'`.
- `session/new` — creates `bodhi-${crypto.randomUUID()}`
  session ids; persistence is deferred to M1.
- `session/prompt` — carries `modelId` through
  `_meta.bodhi.modelId`.
- `session/update` (`agent_message_chunk`) — streams
  assistant deltas with a per-message-id cursor.
- `session/cancel` — aborts the current turn; returns
  `stopReason: 'cancelled'`.
- `bodhi/listModels` (extension method via
  `AgentSideConnection.extMethod`) — serves the Bodhi
  catalog fetch from inside the worker.

Standard JSON-RPC 2.0 error envelope on every failure path.

## Deliberately deferred out of M0

The original M0 milestone in earlier revisions of this file
bundled `/vault` mount and a second (test-double) transport
into M0.b. The phased rework dropped both to keep the diff
small and the e2e green at every commit:

| Scope removed from M0 | Moved to |
| --- | --- |
| Vault mount (FSA handle + ZenFS + dev seed, Playwright `installVault` seed). | [`m2-tools.md § M2.1`](m2-tools.md#m21--vault-mount-fsa--zenfs--dev-seed). |
| `fs/*` delegation + built-in `read/write/edit/ls/glob/grep`. | [`m2-tools.md § M2.2`](m2-tools.md#m22--fs-delegation--built-in-tools). |
| MCP proxy tools over ACP. | [`m2-tools.md § M2.3`](m2-tools.md#m23--mcp-proxy-tools-over-acp). |
| Second (test-double) transport + worker-boundary e2e assertion. | M0 hardening follow-up (this file, see below). |

## Out of scope (unchanged from original plan)

- Session persistence — M1.
- Permission / confirmation prompts — M2.
- Session tree, compaction, skills, extensions — M3–M6.
- HTTP/SSE transport — M7 or later.

## Gate items met at phase D exit

Standard gate:

- `npm run check` clean at the package root.
- `npm run ci:test:e2e` green in CI with `.env.test`
  credentials (real LLM round-trip).
- `chat.spec.ts` unchanged between Phase A and Phase D;
  DOM-witness assertions only.

Phase-D-specific:

- Grep gate zero: `'new Worker'` appears only in
  `useAcp.ts` (main-side spawn) and
  `agent-worker.ts` guard; `'MessagePort'` appears only in
  `transport/worker-stream.ts` + the `init` payload.
- Type-check clean for both TypeScript strict mode and the
  SDK's own types.

## M0 hardening follow-up (not yet in a milestone)

Two items from the original M0.b gate that phase D did not
carry, kept as an explicit follow-up so they're not forgotten:

1. **Second transport implementation.** A minimal in-memory
   test-double transport paired with `createMessagePortStream`
   so unit tests can frame-round-trip the ACP stack without a
   real `MessageChannel`. Forces the interface boundary to be
   real (see Principle 3, transport swappable).
2. **Worker-boundary e2e assertion.** One Playwright step
   asserting the worker boundary is real — e.g., a
   worker-only global is not on `window`, or the worker's
   module graph doesn't leak into the page's.

Both can ship as a small follow-up plan before or during M1.
Neither is blocking for M1 itself: M1's persistence work gives
us a second consumer of the client, which is the real test of
swappability.

## Open questions — now resolved

Recorded for traceability; the resolution is baked into the
specs above.

- **ACP library choice.** Resolved at Phase C:
  `@agentclientprotocol/sdk@0.17.0`, consumed as a dep. No
  vendoring, no hand-roll.
- **Schema stability.** Resolved at Phase C: tracking
  `schema.json` (stable). No reliance on unstable methods
  today.
- **Transport interface shape.** Resolved at Phase C/D: the
  SDK's `{readable, writable}` byte-stream pair via
  `ndJsonStream`. See
  [`../specs/web-acp/transport.md`](../specs/web-acp/transport.md).
- **Permission policy defaults.** Deferred to M2 — M0 has no
  destructive tools to gate. `requestPermission` throws in the
  main-thread `Client` handler today.
- **`.env.test` location.** Resolved: copied from
  `packages/web-agent/e2e/` to `packages/web-acp/e2e/` at
  Phase A.

## Success criteria — met

- A fresh browser session logs into Bodhi, sees the model
  catalog populate, sends a prompt, and watches streaming
  output render.
- The agent runs in a Web Worker; ACP JSON-RPC 2.0 flows over
  `MessageChannel` via `ndJsonStream`.
- `npm run check` clean; e2e green; the UI contract of
  `ChatDemo` is unchanged between Phase A and Phase D.
