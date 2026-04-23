# Goals — web-agent capability checklist

Concrete, verifiable capabilities the library must carry at v1. Mostly mirrors `packages/coding-agent`; rows marked *deferred* are explicitly out of v1 scope. Each row's "test seam" column says how we verify it — vitest for unit-testable surfaces, Playwright `e2e/*.spec.ts` for end-to-end behaviour.

The rule: **a capability is not shipped until it has a test seam that fails when it breaks.** "It works on my machine" is never sufficient.

## Session & transcript

| # | Capability | Test seam |
|---|---|---|
| S1 | Send prompt, receive streamed assistant response, observe message lifecycle events (`agent_start` → `message_update*` → `message_end` → `turn_end` → `agent_end`) | vitest RPC round-trip + Playwright chat spec |
| S2 | Abort an in-flight turn; assistant message is finalised with `stopReason: "aborted"` | vitest |
| S3 | Steer: queue a message that is injected after the current tool-call batch settles | vitest (Phase 4+) |
| S4 | Follow-up: queue a message that runs after the agent would otherwise stop | vitest (Phase 4+) |
| S5 | Fork from an entry in the transcript; new session inherits history up to that point | Playwright (Phase 4+) |
| S6 | Persist a session to IndexedDB under `/sessions/<id>/`; reload the app and resume | Playwright (Phase 5) |
| S7 | List persisted sessions; switch between them | Playwright (Phase 5) |

## Context & compaction

| # | Capability | Test seam |
|---|---|---|
| C1 | Automatic context compaction when context usage crosses a threshold (configurable) | vitest |
| C2 | Manual compaction via explicit API call | vitest |
| C3 | Extension hook: `session_before_compact` (can block or replace compaction payload) | vitest (Phase 5) |
| C4 | Compaction result persisted in session history so it survives reload | vitest + Playwright (Phase 5) |

## Models

| # | Capability | Test seam |
|---|---|---|
| M1 | Switch active model mid-session; subsequent turns use the new model | Playwright |
| M2 | Cycle through a configurable list of models (UI affordance + API method) | vitest |
| M3 | Per-session thinking level: `off`/`minimal`/`low`/`medium`/`high`/`xhigh` where the model supports it | vitest |
| M4 | Custom model providers registered through the extension surface | vitest (Phase 5) |

## Tools (filesystem, v1 surface)

All tools operate on ZenFS-backed paths. By default only the user-mounted `/vault` is writable from tools; `/extensions` and `/sessions` are read-only from tool context.

| # | Tool | Test seam |
|---|---|---|
| T1 | `read` — read file, optional offset/limit, line-capped | vitest (unit) + Playwright (agent round-trip) |
| T2 | `write` — overwrite or create file, auto-mkdir parents | vitest + Playwright |
| T3 | `edit` — patch-based edit with before/after string matching | vitest + Playwright |
| T4 | `ls` — directory listing, optional recursion | vitest |
| T5 | `glob` — glob match against `/vault` | vitest |
| T6 | `grep` — regex content search | vitest |
| T7 | *deferred* `bash`/`exec` — not in v1; browsers don't have a shell. Extensions may ship a Web-Worker-based evaluator if they want one |

## Extensions

The extension system is the customisation surface. A capability is only reachable if an extension can add/mutate/intercept it.

| # | Capability | Test seam |
|---|---|---|
| X1 | Load a locally bundled extension at startup (static registration) | vitest (Phase 5) |
| X2 | Download a remote extension manifest, persist the bundle to `/extensions/<name>/` in IndexedDB | Playwright (Phase 5) |
| X3 | Reload a persisted extension across page loads without re-downloading | Playwright (Phase 5) |
| X4 | Run each extension in its own Web Worker; host exposes capabilities via RPC | vitest (Phase 5) |
| X5 | Extension hook surface: `before_agent_start`, `turn_start`, `turn_end`, `tool_call` (pre), `tool_result` (post), `session_before_compact`, `model_select` | vitest |
| X6 | Register a new tool from an extension; the LLM sees its schema and can call it | vitest + Playwright (Phase 5) |
| X7 | Register a new custom model provider from an extension | vitest (Phase 5) |
| X8 | Block or mutate a tool call from `before_tool_call`; mutate result from `after_tool_call` | vitest (Phase 5) |

## Skills

Skills are validated *as* extensions — there is no separate skill loader. This forces the extension surface to be expressive enough that a skill is not a special case.

| # | Capability | Test seam |
|---|---|---|
| K1 | A skill can register a prompt template | vitest (Phase 5) |
| K2 | A skill can register one or more tools scoped to the skill | vitest (Phase 5) |
| K3 | A skill can request activation from the extension API when a user command matches | vitest (Phase 5) |
| K4 | Two independently shipped skills coexist without colliding on tool names | Playwright (Phase 5) |

## Storage

| # | Constraint | Rationale |
|---|---|---|
| ST1 | `/vault` — Chrome FSA handle, persisted across reloads via IndexedDB (`idb-keyval`) | direct user-local access, reload-safe |
| ST2 | `/extensions` — IndexedDB-backed ZenFS mount | app-owned, must tolerate multi-tab |
| ST3 | `/sessions` — IndexedDB-backed ZenFS mount | app-owned, must tolerate multi-tab |
| ST4 | **No OPFS.** All app-owned storage is IndexedDB. | OPFS does not coordinate across tabs; concurrent writes corrupt state. IndexedDB transactions serialise naturally. See `decisions/index.md` for related entries (D12, D14). |

## Packaging

| # | Requirement | Verification |
|---|---|---|
| P1 | Entire agent code lives under `packages/web-agent/src/worker-agent/` and imports only inward | architectural lint rule (Phase 6) |
| P2 | `peerDependencies` in the extracted package are limited to `react`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core` | `package.json` review at Phase 6 |
| P3 | Consumer can wire up a working chat in ≤ 50 lines | reference implementation in `packages/web-agent/src/App.tsx` |
| P4 | Playwright e2e runs against the consumer wiring, not against private internals | `e2e/*.spec.ts` — no `page.evaluate` hacks |

## Non-goals for v1

- Multi-modal input (voice, image understanding at tool level). Image-as-input to the LLM is fine — that's `pi-ai`'s job.
- Multi-user collaboration. Single user, single browser tab at a time. Multi-tab is a concurrency correctness concern, not a feature.
- Distributed execution. No remote RPC; everything runs in the user's browser.
- Search-over-embeddings. No vector store. A future extension can add one.

## Reading order

If you are new: read this after `00-vision.md`, before `02-architecture.md`.
