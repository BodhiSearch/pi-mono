# Vision — web-acp

## One-line

A browser-native agent that speaks the **Agent Client Protocol
(ACP)** as its internal wire protocol, embeddable in any web app,
operating over a user-mounted local folder, with a transport layer
swappable from in-browser Worker to remote HTTP for future remote-agent
deployments.

## Why this exists

`packages/web-agent/` proved the shape: a browser-native coding-agent
harness over Chrome File System Access + ZenFS works. But along the
way the wire protocol between the React host and the worker-side
agent grew outwards from the UI rather than inwards from a stable
contract. By M8 we had three parallel RPCs (session, ZenFS tunnel,
extension UI) and mixed responsibilities across threads. See
`ai-docs/web-agent/README.md` for the list of specific drifts that
motivated the pivot.

**ACP is the stable contract we were missing.** It is designed for
exactly this split: a thin client that renders UI, a rich agent that
streams events, with filesystem/permission/terminal delegation flowing
the other way as protocol primitives. If the client only speaks ACP
and the agent only speaks ACP, every future feature becomes "how
does this map onto ACP?" instead of "invent a new RPC verb".

Beyond that, ACP being a network-shaped protocol (JSON-RPC 2.0 with
clear request/notification/response envelopes) makes the transport
replaceable without touching the framing code. Today we run the
agent in a Web Worker and frame ACP over `MessageChannel`; tomorrow
we can frame the same ACP messages over HTTP/SSE or WebSocket and
run the agent on a backend. The app code above the transport does
not change.

## What it is

`web-acp` is a React + TypeScript package (`packages/web-acp/`) that
gives a host web app:

1. An **ACP client** that renders streamed agent events, serves
   filesystem reads/writes on the agent's behalf, and mediates
   permission prompts.
2. An **ACP agent** running in a Web Worker, driving the turn loop,
   calling the LLM via `@mariozechner/pi-ai`, and emitting ACP events
   (`session/update`, `tool_call`, permission requests).
3. A **swappable transport layer** framing ACP JSON-RPC 2.0 over
   whatever channel the deployment provides. Browser default:
   `MessageChannel`. Future: HTTP/SSE, WebSocket.
4. A **filesystem context** — the user picks a local folder; the
   client mounts it at `/vault` via ZenFS + Chrome FSA, and serves
   ACP `fs/*` requests from the agent against it. App-owned mounts
   at `/extensions` and `/sessions` via IndexedDB.
5. A **session surface** — create, persist, reload, fork, branch,
   compact. ACP sessions are the object of record.
6. An **extension surface** (late milestone) — starts from "how does
   ACP extend?" rather than from web-agent's Blob-URL loader.

## Who it's for

- **Primary.** This monorepo's web-acp reference app, wired through
  `@bodhiapp/bodhi-js-react` to a Bodhi-hosted LLM, with a real-LLM
  e2e test as the headline M0 deliverable.
- **Secondary.** Any third-party web app that wants a folder-aware
  agent speaking a documented, open protocol. The eventual
  extractable library (name TBD; `@bodhiapp/bodhi-web-acp` is a
  placeholder) targets this audience.
- **Tertiary.** Future remote deployments. Because the transport is
  swappable, the same client can consume a backend-hosted agent over
  HTTP when that makes product sense — without a rewrite.

## What "done" looks like

1. A separately versioned npm package built from
   `packages/web-acp/src/` (agent side) that any web app can embed.
2. Public API:
   - `<WebAcpProvider>` React component wiring the ACP client,
     transport, and vault hooks.
   - `useAcp()` hook returning session state, streaming events,
     `sendPrompt`, `cancel`, `fork`, etc.
   - Headless `AcpClient` / `AcpAgent` / `Transport` classes for
     non-React consumers and for running the agent off-browser.
3. Narrow `peerDependencies` — `react`, `@mariozechner/pi-ai`, the
   ACP library (either the reference TS impl or a hand-rolled subset
   — decided at M0).
4. A consumer can wire up a working folder-aware chat in ≤50 lines.
5. Swapping `MessageChannel` for an HTTP transport is a one-file
   change on the consumer side; the framing and protocol layer do
   not care.

## Explicit non-goals

- **Not a backend.** The default deployment is in-tab. We support a
  future remote-agent transport, but we are not building a server
  product.
- **Not a replacement for `packages/coding-agent`.** That is the
  Node/stdio sibling with shell/process/network. web-acp is the
  browser cousin — overlap is architectural, not feature-for-feature.
- **Not a multi-modal agent.** Coding-agent-shaped: text turns, file
  tools, extensions. Voice, video, embeddings-RAG explicitly out.
- **Not a fine-tuning or model-training environment.** `pi-ai` owns
  model adapters; we consume.
- **Not a coding-agent-on-the-web port.** We borrow shapes from
  `packages/coding-agent/` and from `svkozak/pi-acp` (the reference
  "ACP agent in TypeScript"), but every line in `packages/web-acp/`
  is written fresh with the ACP contract in mind.
- **Not a migration target for `packages/web-agent/`.** That package
  is frozen (see `ai-docs/web-agent/README.md`). No code flows across
  the boundary; we re-derive everything.

## Relationship to neighbours

- **`packages/web-agent/`** — reference spike, frozen. Its specs at
  `ai-docs/specs/worker-agent/` remain a useful crib sheet for
  session shape, tool-operations, extension hook surface. Do not
  import.
- **`packages/coding-agent/`** — upstream library; we study the
  session/tool/extension patterns, do not depend.
- **`agentclientprotocol/agent-client-protocol`** (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/`)
  — ground truth for wire shapes (`schema/schema.json`) and the
  conceptual model (`docs/protocol/`).
- **`svkozak/pi-acp`** (cloned at
  `/Users/amir36/Documents/workspace/src/github.com/svkozak/pi-acp/`)
  — the closest existing "ACP agent in TypeScript" (Node/stdio).
  Prior art, not a dependency. We crib the shape of `src/acp/*`;
  the stdio plumbing doesn't port.

## What this document is for

When you are deciding between two designs, ask: which one gets us
closer to a drop-in library where the client speaks only ACP, the
agent speaks only ACP, and the transport between them is trivially
replaceable? Pick that one.

When a plan contradicts this document, the plan is wrong and needs
updating — not this document.
