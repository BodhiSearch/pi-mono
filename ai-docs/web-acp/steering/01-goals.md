# Goals — web-acp capability checklist

Concrete, verifiable capabilities `packages/web-acp/` must carry at
v1. Feature set largely mirrors `packages/web-agent/` — that's the
product bar we've already proven a user wants. The difference is
**how**: every capability rides on ACP, not on a bespoke RPC.

The rule carries: **a capability is not shipped until it has a test
seam that fails when it breaks.** "It works on my machine" is never
sufficient.

ACP surface citations below refer to
`/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/schema/schema.json`
and the method index in `docs/protocol/`.

## Session & transcript

| # | Capability | ACP surface | Test seam |
|---|---|---|---|
| S1 | `session/new` → `session/prompt` → streamed `session/update` chunks → final response | `session/new`, `session/prompt`, `session/update` | vitest (framing round-trip) + Playwright (chat spec) |
| S2 | Cancel an in-flight prompt; assistant message finalises with a cancelled stop reason | `session/cancel` | vitest |
| S3 | Queue a follow-up prompt that runs after the current turn ends | ACP notification TBD (extension needed) | vitest (later milestone) |
| S4 | Persist a session; reload the tab and resume | app-level (`/sessions` mount) | Playwright |
| S5 | List persisted sessions; switch between them | app-level | Playwright |
| S6 | Fork from any entry in a persisted transcript; new session inherits prefix | app-level + ACP `session/new` | Playwright |

## Context & compaction

| # | Capability | ACP surface | Test seam |
|---|---|---|---|
| C1 | Auto-compact on context-threshold crossover | agent-internal + `session/update` summary | vitest |
| C2 | Manual compact via explicit API/UX | agent-internal | vitest |
| C3 | Compaction summary persisted in history and survives reload | app-level | vitest + Playwright |
| C4 | Extension hook: before-compact / after-compact | web-acp extension API (late milestone) | vitest |

## Models

| # | Capability | ACP surface | Test seam |
|---|---|---|---|
| M1 | Switch active model mid-session | agent-internal; ACP `_meta` or notification | Playwright |
| M2 | Thinking-level control where provider supports it | agent-internal | vitest |
| M3 | Custom model providers from extensions | extension API | vitest (late) |

## Tools (filesystem via ACP delegation)

All filesystem tools must be expressed via ACP `fs/*` delegation —
the agent requests the read/write, the client serves it against its
ZenFS-mounted `/vault`. This is the structural fix for web-agent's
dual-MessageChannel ZenFS tunnel.

| # | Tool | ACP surface | Test seam |
|---|---|---|---|
| T1 | `read` — file content, optional offset/limit | `fs/read_text_file` | vitest + Playwright |
| T2 | `write` — overwrite/create, auto-mkdir | `fs/write_text_file` | vitest + Playwright |
| T3 | `edit` — string-based patch | `fs/read_text_file` + `fs/write_text_file` | vitest + Playwright |
| T4 | `ls` — directory listing | agent-internal (served via `fs/*` reads) or ACP extension | vitest |
| T5 | `glob` — glob match against `/vault` | agent-internal | vitest |
| T6 | `grep` — regex content search | agent-internal | vitest |
| T7 | *deferred* `bash`/`exec` — browsers have no shell. ACP `terminal/*` is out of scope for v1. |

## Permission / confirmation flow

| # | Capability | ACP surface | Test seam |
|---|---|---|---|
| P1 | Agent requests permission for a destructive tool call; UI prompts; user allow/deny flows back | ACP `tool_call` permission flow | Playwright |
| P2 | Pre-approval policy (auto-allow read-only, prompt on write) | client-side policy | vitest |
| P3 | Denied permission surfaces to the agent as a structured error without crashing the turn | ACP `tool_call` response | vitest |

## Extensions (late milestone)

| # | Capability | Test seam |
|---|---|---|
| X1 | Install a locally bundled extension at startup | vitest |
| X2 | Register a new tool; the LLM sees its schema and can call it | vitest + Playwright |
| X3 | Hook into session lifecycle: pre-prompt, post-turn, pre/post-tool-call | vitest |
| X4 | Fully trusted trust model (carried from `ai-docs/web-agent/milestones/deferred.md` § Extension sandboxing) | n/a (architectural) |
| X5 | Register a custom model provider | vitest |

Deferred to post-v1: third-party extension marketplace, sandboxed
execution, manifest permission system. The extension re-entry plan
starts with "how does ACP extend?" — not with web-agent's Blob-URL
loader.

## Storage

| # | Constraint | Rationale |
|---|---|---|
| ST1 | `/vault` — Chrome FSA handle, persisted via IndexedDB (`idb-keyval`) | direct user-local access, reload-safe |
| ST2 | `/sessions` — IndexedDB-backed ZenFS mount | app-owned, multi-tab-safe |
| ST3 | `/extensions` — IndexedDB-backed ZenFS mount | app-owned, multi-tab-safe |
| ST4 | **No OPFS.** | OPFS does not coordinate across tabs; concurrent writes corrupt state. IndexedDB transactions serialise naturally. Rationale carried from web-agent. |

## Transport

| # | Constraint | Verification |
|---|---|---|
| TR1 | ACP framing code contains zero `MessagePort`/`Worker` references | grep check in CI |
| TR2 | Default browser transport frames ACP JSON-RPC 2.0 over `MessageChannel` | vitest framing round-trip |
| TR3 | A second transport implementation (even if only a test double) demonstrates swappability before M0.b gate | vitest — two transport impls behind one interface |
| TR4 | Future HTTP/SSE transport ships without touching framing or agent code | audit at the milestone that introduces it |

## Packaging

| # | Requirement | Verification |
|---|---|---|
| P1 | Agent code lives under `packages/web-acp/src/` (subpath TBD — `agent/`, `acp-agent/`, or similar) and imports only inward | architectural lint rule (late milestone) |
| P2 | `peerDependencies` are narrow: `react`, `@mariozechner/pi-ai`, the chosen ACP library | `package.json` review |
| P3 | Consumer wires working chat in ≤50 lines | reference implementation in `packages/web-acp/src/App.tsx` |
| P4 | Playwright e2e exercises the consumer surface, not internals | `packages/web-acp/e2e/*.spec.ts` — no `page.evaluate` reaching into ZenFS/transport |

## Non-goals for v1

- ACP `terminal/*` delegation. Browsers have no shell. An extension
  may ship a Worker-based evaluator if it wants one; not our
  concern.
- Multi-user collaboration. Single user, single tab at a time.
  Multi-tab is a concurrency correctness concern for app-owned
  storage, not a feature.
- Remote-agent deployment. **The transport must be swappable**, but
  actually shipping an HTTP/SSE transport is post-v1.
- Multi-modal input (voice, image understanding at tool level).
  Image-as-LLM-input is fine — `pi-ai`'s job.
- Search-over-embeddings. No vector store. A future extension can
  add one.

## Reading order

If you are new: read this after `00-vision.md`, before
`02-architecture.md`.
