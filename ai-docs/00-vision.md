# Vision — web-agent

## One-line

A browser-native agent harness any web app can embed to gain coding-agent-class capabilities over a user-mounted local folder, customised through downloadable extensions, publishable as a standalone library.

## Why this exists

Modern "copilot"-style features inside web apps keep rebuilding the same harness from scratch: a turn loop, streaming, tool calls, message compaction, session persistence, a forkable transcript, model switching, an extension surface. Each team pays that cost separately, and each ends up with a bespoke tangle that is hard to swap models through, hard to extend, and hard to test.

Meanwhile, two browser primitives have matured enough that an in-browser coding agent is finally practical:

- **Chrome File System Access API** — the user picks a local folder and the web app gets persistent read/write access to it.
- **ZenFS** — a consistent `fs/promises`-shaped abstraction over that handle (and over IndexedDB for app-owned storage), so tooling written against "a filesystem" works without knowing where the bytes actually live.

Nothing on npm bundles those primitives into a drop-in agent harness with the ergonomics of `packages/coding-agent`. `web-agent` is that bundle.

## What it is

`web-agent` is a React + TypeScript package that gives a host web app:

1. A **session** — running a model-backed conversation with streaming, tool calls, queued steering and follow-up messages, mid-run abort, forkable history.
2. A **filesystem context** — a user-picked local folder mounted at `/vault` via Chrome FSA, plus app-owned mounts at `/extensions` and `/sessions` via IndexedDB.
3. A **tool surface** — read, write, edit, ls, glob, grep operating over `/vault`.
4. An **extension surface** — downloadable, persisted, sandboxed modules that can register new tools, intercept tool calls, provide skills, plug in custom model providers, and hook into session/compaction lifecycle events.
5. An **RPC boundary** — the agent runtime is deliberately separated from the UI by a structured-clone-safe transport so it can live in a Web Worker (or, eventually, further out) without API churn in the host app.

## Who it's for

- **Primary** — this monorepo's web app embedding. The immediate consumer is the React app living in `packages/web-agent/`, wired through `@bodhiapp/bodhi-js-react` to a Bodhi-hosted LLM.
- **Secondary** — any third-party web app that wants a local-folder-aware agent without implementing the loop. The API shape is chosen with that in mind from day one; we are not "making it a library later."

## What "done" looks like

1. A separately versioned npm package — working name `@bodhiapp/bodhi-web-agent` — built from `packages/web-agent/src/worker-agent/`.
2. Its public API consists of:
   - `<WebAgentProvider>` React component wiring the transport, session, and vault hooks.
   - `useAgent()` hook returning messages, streaming state, `sendMessage`, `abort`, `fork`, etc.
   - Headless `AgentSession` + `RpcServer` + `RpcClient` classes for non-React consumers.
3. `peerDependencies` are narrow: `react`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`. Everything else is either an internal implementation detail or a `dependencies` entry.
4. A consumer can, in under 50 lines of wiring, get a folder picker, a chat UI, streaming replies with tool calls, and a downloadable extension that adds a new capability.
5. The Phase 6 extraction is mechanical — `src/worker-agent/` is already self-contained under our own conventions, so graduating to a separate package is a build-config change, not a rewrite.

## Explicit non-goals

- **Not a generic multi-modal agent.** Coding-agent-shaped: text turns, file tools, extensions. Voice, video, embedding, RAG-over-web-scrapes are deliberately out of scope.
- **Not a replacement for `packages/coding-agent`.** That lives on node with full shell/process/network power. Web-agent is the *browser cousin* with a different capability set; the overlap is architectural, not feature-for-feature.
- **Not a model-training or fine-tuning environment.** The agent consumes any OpenAI/Anthropic/bodhi-served model via `pi-ai`; model ownership is someone else's problem.
- **Not a backend.** It runs in the user's tab. The only "server" is whatever the host app chose to route LLM traffic through (Bodhi, direct provider, etc.).

## What this document is for

If you are a future session (AI or human) picking up this project, this is the north star. When you have to decide between two designs, ask: which one gets us closer to a drop-in library that any web app can embed over a user's local folder? Pick that one.

When something in a plan contradicts this document, the plan is wrong and needs updating — not this document.
