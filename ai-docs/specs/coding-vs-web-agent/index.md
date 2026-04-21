# coding-agent vs web-agent

**Scope:** architectural comparison between the two in-repo agent harnesses, split into topic files so each section stays readable on its own.

- `packages/coding-agent/` — mature Node-runtime coding agent (stdin/stdout RPC, pi-tui interactive mode, local filesystem, child-process bash, file-backed auth + sessions).
- `packages/web-agent/` — browser-runtime coding-agent harness built around a Web Worker, an RPC wire protocol, ZenFS over File System Access, IndexedDB sessions, and a single pluggable `LlmProvider`. The worker-side runtime under `packages/web-agent/src/worker-agent/` is the extraction target for the future `@bodhiapp/bodhi-web-agent` library.

**Hard rule (from `CLAUDE.md`):** `packages/web-agent/` must not import from `packages/coding-agent/`. coding-agent pulls Node-only deps (`fs`, `child_process`, `jiti`, `pi-tui`) that would break browser bundling and block Phase 6 extraction. web-agent studies coding-agent's patterns — session shape, RPC schema, extension hooks, tool "operations" — and **ports** them, accepting short-term duplication.

This folder is a map of **where those ports are aligned, where they intentionally diverge, and what is still missing on either side**. It does not spec either harness in depth — see [`worker-agent/`](../worker-agent/index.md) and [`worker-bodhi/`](../worker-bodhi/index.md) for the web-agent specs; coding-agent does not (yet) have a matching spec folder in this repo.

## Table of contents

- [`alignment.md`](./alignment.md) — ported patterns both harnesses share (session format, RPC vocabulary, tool operations, compaction, agent core).
- [`divergence.md`](./divergence.md) — where the two harnesses intentionally differ (transport, auth/models, session storage, filesystem, tool hosting, UX, `AgentSession` sizing).
- [`feature-gaps.md`](./feature-gaps.md) — features in one harness that are missing from the other (coding-agent → web-agent and vice versa).
- [`guidance.md`](./guidance.md) — shared vocabulary, practical porting guidance, invariants, and open questions.

## High-level shape

| Axis | `coding-agent` | `web-agent` |
| --- | --- | --- |
| Runtime target | Node 20+ CLI binary (`main.ts`) | Browser — React host + Web Worker (`worker-agent/worker/agent-worker.ts`) |
| Process model | Single process, pi-tui for interactive, stdin/stdout for RPC, one-shot for print | Main thread ↔ Worker over `MessagePort`; in-process `MessageChannel` fallback for dev/tests |
| Entry points | `main()` → `InteractiveMode` / `runPrintMode` / `runRpcMode` (`src/modes/`) | `getAgentWorker()` (main-thread boot) + `agent-worker.ts` (Worker entry); React app in `packages/web-agent/src/` is one consumer |
| Extraction target | Standalone npm published from this folder | `@bodhiapp/bodhi-web-agent` (future) carved out of `src/worker-agent/` — everything outside that folder is host code |
| Concrete provider scope | In-tree: file-system auth storage, OAuth providers, JSON-defined providers/models (`model-registry.ts`) | In-tree provider abstraction only; concrete impl lives in sibling `src/worker-bodhi/` (or any host-supplied `LlmProvider`) |

## Change procedure

This document set compares the *shape* of both harnesses, not their individual implementations. Update it when:

- A feature listed in `feature-gaps.md` under "missing from web-agent" is ported — move it out into `alignment.md`.
- A feature listed under "web-agent only" lands in coding-agent too — same move.
- One of the divergence axes in `divergence.md` is changed (e.g. the transport, the session store, the auth seam) — update the relevant row and the "Why" below it.
- A new architectural axis appears that neither alignment nor divergence covers — add it to the right file.

Small implementation-level drift (new RPC commands, new session entry variants) only needs an update here if the *architecture* shifted — otherwise it belongs in the per-module spec under `worker-agent/` or `worker-bodhi/`.
