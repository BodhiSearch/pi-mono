# compaction

**Source of truth:** `packages/web-agent/src/worker-agent/core/compaction/`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

Context compaction shrinks a session's in-context message history when it approaches the active model's context window. Two trigger paths:

- **Automatic:** after every persisted message-end, if `estimateContextTokens(messages) > contextWindow − reserveTokens`.
- **Manual:** `compactNow()` forces a compaction regardless of the token threshold.

The pipeline is pure-before-LLM: a preparation step computes the cut point and the payload; a summarisation step calls the LLM; a persistence step appends a `CompactionEntry` and rebuilds the agent context.

### Core decisions

- **Cut on user-message turn boundaries only.** Never mid-turn. Keeps the assistant/tool-result continuity intact on both sides of the cut.
- **Preserve a recent tail.** `keepRecentTokens` worth of message tokens from the tail are never summarised.
- **Iterative updates.** When the branch already contains a prior compaction, use its `summary` + `details` as input to an update prompt so the new summary is a refinement, not a fresh start.
- **File-op continuity.** `read` / `modified` file lists extracted from discarded messages plus any prior `CompactionDetails` carry into the new summary for write-path traceability.
- **Single-flight.** `WorkerAgentHost.compactionInFlight` + a per-run `AbortController` make sure session swaps abort cleanly.

## Technical reference

### Files

| File | Contents |
| --- | --- |
| `types.ts` | `CompactionSettings`, `DEFAULT_COMPACTION_SETTINGS`, `CompactionPreparation`, `CompactionResult`, `CompactionDetails`. |
| `token-estimate.ts` | `estimateTokens`, `estimateContextTokens`, `shouldCompact`. |
| `prepare.ts` | `prepareCompaction(path, settings, opts)` (pure). |
| `summarize.ts` | `compactSummarize(preparation, model, options)` (LLM call). |
| `serialize.ts` | `serializeConversation(messages)` — flattens messages into the text sent to the LLM. |
| `file-ops.ts` | `extractFileOpsFromMessage`, `createFileOps`, `computeFileLists`, `formatFileOperations`. |
| `prompts.ts` | `SUMMARIZATION_SYSTEM_PROMPT`, `SUMMARIZATION_PROMPT`, `UPDATE_SUMMARIZATION_PROMPT`, `COMPACTION_SUMMARY_PREFIX`, `COMPACTION_SUMMARY_SUFFIX`. |
| `index.ts` | Barrel. |

### `CompactionSettings`

Defined in `types.ts`. Fields:

- `enabled: boolean` — master switch.
- `reserveTokens: number` — headroom from the context window (trigger above `contextWindow − reserveTokens`). Default `16384`.
- `keepRecentTokens: number` — tail never summarised. Default `20000`.
- `minEntriesToCompact: number` — skip compaction if the branch is shorter. Default `4`.
- `contextWindow?: number` — override the model's `contextWindow`. Tests use a small value to exercise the auto path on short transcripts.

`DEFAULT_COMPACTION_SETTINGS` exports `{ enabled: true, reserveTokens: 16384, keepRecentTokens: 20000, minEntriesToCompact: 4 }`.

### `token-estimate.ts`

- `estimateTokens(message)` — char/4 heuristic per role:
  - `user`: sum text-content lengths.
  - `assistant`: sum `text`, `thinking`, and `toolCall` (`name + JSON.stringify(arguments)`) lengths.
  - `toolResult`: sum text lengths; images count as 4800 chars (rough byte-to-token proxy).
  - Return `ceil(chars / 4)`.
- `estimateContextTokens(messages)` — prefers the most recent assistant `usage` (`totalTokens`, or `input + output + cacheRead + cacheWrite`) plus trailing-message estimates. Falls back to summed `estimateTokens` when no usage is available.
- `shouldCompact(messages, contextWindow, settings)` — returns `settings.enabled && tokens > contextWindow - settings.reserveTokens`.

### `prepare.ts::prepareCompaction`

Pure; returns `CompactionPreparation | null`. Algorithm:

1. Early-out if `path.length < minEntriesToCompact` or the last entry is already a `compaction`.
2. `findBoundaryStart(path)` — scan backwards for the last `compaction`. If found, resume from its `firstKeptEntryId` (or `i + 1` if the kept id can't be resolved) and capture `previousSummary` + `priorDetails`.
3. `findCutIndex(path, boundaryStart, keepRecentTokens)` — walk backwards from `path.length - 1` down to `boundaryStart`, accumulating `estimateTokens` for each message. Once `accumulated >= keepRecentTokens`, snap **forward** to the first entry that satisfies `isUserMessageEntry`. Returns that index, or `-1` if no user boundary exists.
4. Force fallback: when `cutIdx < 0 || cutIdx <= boundaryStart` and `opts.force`, use `findLastUserMessageIndex(path, boundaryStart)` — the last user-message entry strictly after `boundaryStart`.
5. Return `null` if still no cut or cut collapses onto the boundary start.
6. Collect `messagesToSummarize` from `[boundaryStart, cutIdx)` (messages only; other entry types skipped).
7. File ops: seed from `priorDetails.readFiles / modifiedFiles`, then `extractFileOpsFromMessage` across each discarded message, then `computeFileLists`.
8. `tokensBefore = estimateContextTokens(allMessages)` — the full-branch estimate, not just the discarded slice.
9. Return `{ firstKeptEntryId, messagesToSummarize, tokensBefore, previousSummary, readFiles, modifiedFiles }`.

### `summarize.ts::compactSummarize`

Shape: `compactSummarize(preparation, model, options: CompactSummarizeOptions)`, where `CompactSummarizeOptions = { authProvider: LlmAuthProvider, signal?: AbortSignal }`.

Flow:

1. Pick prompt template: `UPDATE_SUMMARIZATION_PROMPT` when `previousSummary` exists, else `SUMMARIZATION_PROMPT`.
2. `conversation = serializeConversation(messagesToSummarize)` — produces the XML-ish transcript embedded in the prompt.
3. Assemble `promptText`:
   - With prior summary: `<conversation>…</conversation>\n\n<previous-summary>…</previous-summary>\n\n${basePrompt}`.
   - Without: `<conversation>…</conversation>\n\n${basePrompt}`.
4. `auth = await authProvider.getApiKeyAndHeaders(model)` — auth resolution is delegated; see [`llm-auth.md`](./llm-auth.md).
5. `maxTokens = floor(0.8 * (model.maxTokens ?? 4096))`.
6. `completeSimple(model, { systemPrompt: SUMMARIZATION_SYSTEM_PROMPT, messages: [user-message with promptText] }, { maxTokens, signal, apiKey: auth.apiKey, headers: auth.headers })`.
7. On `stopReason === 'error'`, throw.
8. Extract text blocks, join with `\n`.
9. Append `formatFileOperations(readFiles, modifiedFiles)` to produce the final `summary`.
10. Return `{ summary, firstKeptEntryId, tokensBefore, details: { readFiles, modifiedFiles } }`.

No auth-header synthesis. pi-ai's per-format provider code handles that.

### `file-ops.ts`

- `createFileOps()` — `{ read: Set<string>, edited: Set<string> }`.
- `extractFileOpsFromMessage(message, fileOps)` — inspects assistant tool calls (`read` / `write` / `edit` / tool-result messages) to update `read` and `edited`.
- `computeFileLists(fileOps)` — returns `{ readFiles, modifiedFiles }` (arrays, dedup'd, stable order).
- `formatFileOperations(readFiles, modifiedFiles)` — appendable text block with the file lists for the final summary body.

### `serialize.ts`

`serializeConversation(messages)` flattens the message list into the prompt body. Assistant `text` / `thinking` / `toolCall` blocks, user text + image blocks (text only for the prompt), and tool-result blocks are each rendered with role-tagged headers.

### Lifecycle (executed by `WorkerAgentHost`)

The orchestrator is `WorkerAgentHost.runCompaction` (see [`worker-host.md`](./worker-host.md)). Pipeline from the compaction module's perspective:

1. **Preparation** — `prepareCompaction(path, settings, { force })`.
2. **Summarisation** — `compactSummarize(preparation, model, { authProvider, signal })`.
3. **Persistence** — `SessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details)`.
4. **Context rebuild** — `SessionManager.buildSessionContext()` emits the synthetic summary message; `AgentSession.restoreMessages(ctx.messages)` swaps the in-memory buffer.
5. **Emissions** — host emits `session_loaded` (refreshed messages + meta) and `compaction_end{success, tokensBefore}`.

### Lifecycle events

Flow through the host event sink → transport → `RpcClient.onCompactionEvent`:

- `compaction_start` — emitted before summarisation.
- `compaction_end` — emitted after append, with `success: true, tokensBefore`. On error, `success: false, errorMessage`. Suppressed on abort.

### Synthetic summary message in context

`buildSessionContext` wraps the stored summary in a single user message:

```
COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX
```

and emits a `UiMessageMeta{ kind: 'compaction-summary', tokensBefore, firstKeptEntryId, entryId }`. The UI renders this as a distinct "compacted" marker rather than a real user turn.

## Constraints

1. **No direct LLM auth.** `compactSummarize` only goes through `LlmAuthProvider`. No Bodhi-specific imports allowed here.
2. **No side effects in `prepare.ts`.** It is pure so unit tests can exercise edge cases deterministically.
3. **Abort discipline.** Any caller that may swap sessions must hold the `AbortController` and cancel it before starting a new compaction.

## Tests

- `core/compaction/prepare.test.ts` — cut-point selection, force fallback, iterative-update boundary, file-op continuity.
- `core/compaction/summarize.test.ts` — prompt composition, error handling, auth-provider delegation.
- `core/compaction/token-estimate.test.ts` — per-role char counts, usage-based fallback, threshold check.
- `worker/worker-host.test.ts` (integration) — end-to-end auto-compaction + manual trigger + abort on session swap.

## Change procedure

Any plan that edits `core/compaction/` must update this file in the same PR. When settings or prompt templates change, verify both the auto path (`maybeCompact` → `runCompaction({ force: false })`) and the manual path (`compactNow` → `runCompaction({ force: true })`) still produce a correct `CompactionPreparation`.

See [`./index.md` § Change procedure](./index.md#change-procedure).
