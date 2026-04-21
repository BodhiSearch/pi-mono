# Where they are aligned (ported patterns)

These are the surfaces web-agent explicitly copied from coding-agent to keep extension authors, session files, and RPC clients fluent across both.

## Session format (wire-compatible ports)

`packages/web-agent/src/worker-agent/core/session/types.ts` is a 1:1 port of the session shapes in `packages/coding-agent/src/core/session-manager.ts`:

- `CURRENT_SESSION_VERSION = 3`.
- `SessionHeader`, `SessionEntryBase`, `SessionMessageEntry`, `ModelChangeEntry`, `ThinkingLevelChangeEntry`, `CompactionEntry<T>`, `BranchSummaryEntry<T>`, `CustomEntry<T>`, `LabelEntry`, `SessionInfoEntry`, `CustomMessageEntry<T>`.
- `buildSessionContext`-style replay semantics (last `model_change` wins; compaction entries swap head-of-branch).
- A `ReadonlySessionManager` contract mirroring coding-agent's extension-facing read surface (`getCwd`, `getEntries`, `getLeafId`, `getBranch`, `getTree`, etc.) — extensions written against coding-agent will eventually read session state through this contract in web-agent too.

Several of these variants (`ThinkingLevelChangeEntry`, `BranchSummaryEntry`, `LabelEntry`, `CustomEntry`, `CustomMessageEntry`) are **ported up front but not yet written by the runtime** — the goal is that a future extension host (M8) can read coding-agent sessions and vice versa without a format break.

## RPC command vocabulary

Both harnesses run the same core turn / session verbs (names differ in casing only):

| Verb | coding-agent (`packages/coding-agent/src/modes/rpc/rpc-types.ts`) | web-agent (`packages/web-agent/src/worker-agent/rpc/rpc-types.ts`) |
| --- | --- | --- |
| Prompt turn | `prompt` | `prompt` |
| Abort | `abort` | `abort` |
| Query state | `get_state` | `get_state` |
| Messages | `get_messages` | `get_messages` |
| Set model | `set_model { provider, modelId }` | `set_model { provider, modelId }` |
| List models | `get_available_models` | `get_available_models` |
| Session list | (SessionManager APIs via mode glue) | `list_sessions` |
| New session | `new_session { parentSession? }` | `new_session { parentSession? }` |
| Switch session | `switch_session { sessionPath }` | `load_session { sessionId }` |
| Fork | `fork { entryId }` | `fork_session { fromEntryId }` |
| Navigate tree | (in-process `navigateTree` API on `AgentSession`) | `navigate_to_leaf { entryId }` |
| Session name | `set_session_name { name }` | `set_session_name { name }` |
| Compact | `compact { customInstructions? }` | `compact_now` |
| System prompt | (in-memory property on `AgentSession`) | `set_system_prompt { prompt }` |
| Reset | (implicit via `new_session`) | `reset` |

Both use typed `RpcResponse` envelopes correlated by `id`, and both emit unsolicited events (agent events + synthetic events) on the same channel.

## Tool "operations" pattern

Both define filesystem tools through an **operations interface** that the tool consumes, so the same tool logic runs against different back ends:

- coding-agent: `ReadOperations`, `WriteOperations`, `EditOperations`, `LsOperations`, `GrepOperations`, `FindOperations`, `BashOperations` — Node `fs` implementation via `createLocalBashOperations` etc. (`packages/coding-agent/src/core/tools/`).
- web-agent: the same operations interfaces, wired to **ZenFS** through `createZenfsVaultOperations` (`packages/web-agent/src/worker-agent/fs/zenfs-operations.ts:createZenfsVaultOperations`) and exposed via `createVaultTools` (`packages/web-agent/src/worker-agent/core/tools/index.ts:createVaultTools`). Tool definitions (`read.ts`, `write.ts`, `edit.ts`, `ls.ts`, `glob.ts`, `grep.ts`) mirror the coding-agent shape so extension prompts remain identical.

## Compaction pipeline

Both implement the same 4-stage pipeline (token estimation → cut-point selection → summarisation → entry persistence):

- coding-agent: `packages/coding-agent/src/core/compaction/{estimate,findCutPoint,generateSummary,compact}`.
- web-agent: `packages/web-agent/src/worker-agent/core/compaction/{token-estimate,prepare,summarize,serialize,file-ops}`.

Both surface a lifecycle — `compaction_start` → `compaction_end` events — and both persist a `CompactionEntry` that subsequent `buildSessionContext` calls use to swap the head of the branch with a summary message.

## Agent core

Both harnesses are thin wrappers over `@mariozechner/pi-agent-core`'s `Agent`:

- coding-agent: `AgentSession` (~3077 loc, `packages/coding-agent/src/core/agent-session.ts`) owns the `Agent`, composes tools/streamFn/extensions, persists messages via `SessionManager`.
- web-agent: `AgentSession` (~127 loc, `packages/web-agent/src/worker-agent/core/agent-session.ts`) is a minimal plain-data wrapper; persistence, streamFn wiring, event fan-out, and session replay live in `WorkerAgentHost` (`packages/web-agent/src/worker-agent/worker/worker-host.ts`).

The division is deliberate — see `divergence.md` for the rationale behind the split.
