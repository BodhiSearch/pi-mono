# agent-session

**Source of truth:** `packages/web-agent/src/worker-agent/core/agent-session.ts`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

`AgentSession` is a thin wrapper over `@mariozechner/pi-agent-core`'s `Agent`. It exposes:

- **Plain-data surface** safe to drive from the RPC server (no closures, no non-serialisable types in arguments or return values).
- **Host-only surface** for non-serialisable state (`tools`, `streamFn`, event subscriptions) that can only be wired inside the Worker context.

Responsibilities:

- Own the `Agent` instance and the currently-selected `Model<Api>`.
- Produce state snapshots for the RPC `get_state` / `get_messages` / `isStreaming` / `getStreamingMessage` / `getErrorMessage` queries.
- Let the Worker host install tools, the stream function, and event subscribers directly.

Explicit non-responsibilities:

- **Auth is not owned here.** The session accepts a `StreamFn` at construction or via `setStreamFn`; the Worker composes it from an injected `LlmAuthProvider` in `worker/agent-worker.ts`.
- **Persistence is not owned here.** The session does not read or write session entries; that's [`sessions.md`](./sessions.md) and [`worker-host.md`](./worker-host.md).

## Technical reference

### Type

- `AgentSession` — class.
- `AgentSessionOptions` — `{ streamFn?, getApiKey? }`, pass-through to `pi-agent-core`'s `Agent` constructor.

Exported from the public barrel at `packages/web-agent/src/worker-agent/index.ts`.

### Plain-data surface (RPC-safe)

| Method | Behaviour |
| --- | --- |
| `prompt(message)` | Delegates to `agent.prompt`. |
| `abort()` | Delegates to `agent.abort`. |
| `reset()` | Delegates to `agent.reset`. |
| `getState()` | Returns `RpcSessionState` (`isStreaming`, `messageCount`, `model`, `errorMessage`). The `model` is the memoised `currentModel` field (see below). |
| `getMessages()` | Shallow-clones `agent.state.messages`. |
| `getStreamingMessage()` | Returns `agent.state.streamingMessage`. |
| `getErrorMessage()` | Returns `agent.state.errorMessage`. |
| `isStreaming()` | Returns `agent.state.isStreaming`. |
| `setSystemPrompt(prompt)` | Assigns `agent.state.systemPrompt`. Not persisted. |
| `setModel(model)` | Assigns `agent.state.model = model` and memoises on `currentModel` when a model is provided; `undefined` is accepted as a "cleared" signal (used by session-restore paths when the catalog cannot yet resolve the identifier). |
| `getModel()` | Returns the memoised `currentModel`. Compaction reads this for `contextWindow` and for the `completeSimple` call. |
| `restoreMessages(messages)` | Replaces `agent.state.messages` without replaying lifecycle events. Used by session load / navigate / compaction so restored messages are not double-persisted. |

### Host-only surface (non-serialisable state)

| Method | Behaviour |
| --- | --- |
| `setTools(tools)` | Assigns `agent.state.tools`. |
| `setStreamFn(fn)` | Assigns `agent.streamFn`. |
| `subscribe(handler)` | Forwards to `agent.subscribe`; returns an unsubscribe function. |

These are called from inside the Worker by `worker/agent-worker.ts` and `worker-host.ts`. They must not be exposed over the RPC.

### Why the `currentModel` memo exists

`pi-agent-core` exposes `model` on `Agent.state`, but re-assigning it also wipes it in certain control-flow paths in older versions. The memoised `currentModel` is the source of truth `AgentSession` returns through `getState` and `getModel`, keeping the RPC snapshot stable.

### Tests

- `packages/web-agent/src/worker-agent/core/agent-session.test.ts` covers the plain-data surface: prompt flow, abort, state snapshots, model memoisation, `restoreMessages` non-event semantics. Auth-related tests were removed when auth ownership moved out of `AgentSession`.

## Change procedure

If a plan changes `core/agent-session.ts`, update this file in the same PR. See [`./index.md` § Change procedure](./index.md#change-procedure).
