# M7 Compaction for web-agent — Exploration Report

## 1. Compaction Algorithm (coding-agent)

**Files:**
- `/packages/coding-agent/src/core/compaction/compaction.ts` (lines 1–823)
- `/packages/coding-agent/src/core/compaction/branch-summarization.ts` (lines 1–355)
- `/packages/coding-agent/src/core/compaction/utils.ts` (lines 1–171)

### Trigger Condition
- `shouldCompact()` (line 219): `contextTokens > contextWindow - reserveTokens`
- Default settings: `reserveTokens=16384`, `keepRecentTokens=20000` (lines 121–125)
- Called when context usage crosses a threshold before sending the next prompt

### Compaction Payload to LLM
1. **Messages to summarize** (line 652): `messagesToSummarize` — all messages from previous compaction boundary to cut point
2. **Turn prefix messages** (line 659): if cutting mid-turn, summarize the prefix separately to provide context for the retained suffix
3. **File operations** (line 668): extracted from assistant tool calls (read/write/edit) and previous compaction entries
4. **Two-prompt strategy** (line 737–755):
   - If splitting a turn: generates both a history summary and a turn-prefix summary in parallel
   - Otherwise: single history summary
5. **Prompts used** (line 454 & 693):
   - `SUMMARIZATION_PROMPT`: initial structure + format rules
   - `UPDATE_SUMMARIZATION_PROMPT` (line 487): if iterating from previous summary, preserves existing info
   - `TURN_PREFIX_SUMMARIZATION_PROMPT`: for split-turn context

### CompactionEntry Persistence
- Type definition: `/packages/web-agent/src/web-agent/core/session/types.ts` (lines 65–72)
- **Fields:**
  - `type: 'compaction'` — discriminator
  - `id`: 8-char UUID short ID
  - `parentId`: tree link (previous entry)
  - `timestamp`: ISO string
  - `summary`: LLM-generated text (preserves structured format + file lists)
  - `firstKeptEntryId`: UUID of first retained entry (enables message window rebuild)
  - `tokensBefore`: tokens in context before compaction (for metrics)
  - `details?: T`: extension-specific data (default: `{ readFiles, modifiedFiles }`)
  - `fromHook?: boolean`: flag for session-file compatibility

### Message Window Rebuild After Compaction
1. **Discarded entries removed:** All entries before `firstKeptEntryId` are logically deleted (not persisted in the message window)
2. **Compaction entry inserted:** A `CompactionEntry` replaces the discarded history in the conversation flow
3. **Rebuild via `buildSessionContext()`** (session-manager.ts, lines 245–261):
   - Walks the branch from root to leaf, collecting messages
   - Skips non-message entries (changes, settings) during context build
   - For message entries: extracts and pushes to context
   - For `type === 'compaction'`: converts to `createCompactionSummaryMessage()` (message.ts) which becomes a user or assistant message in context
   - Final context contains: messages before cut + compaction summary message + messages after cut
4. **Message extraction** (compaction.ts lines 79–100):
   - `getMessageFromEntry()`: handles `'message'`, `'custom_message'`, `'branch_summary'`, `'compaction'` types
   - `getMessageFromEntryForCompaction()`: excludes compaction entries from the to-be-summarized batch (avoids double-wrapping)

---

## 2. web-agent Current Structure

### WorkerAgentHost (session lifecycle, write chain)
**File:** `/packages/web-agent/src/web-agent/worker/worker-host.ts` (lines 36–402)

**Session Lifecycle:**
- Constructor (line 62–91): receives `AgentSession`, `SessionStore`, hooks message_end events
- **Write chain** (line 55): `Promise<unknown>` serializes appends to prevent lost parent links
- `loadSession(sessionId)` (line 245–254): awaits write chain, aborts streaming, rebuilds tree from store, resets + restores agent messages, emits synthetic `session_loaded` event
- `newSession(parentSession)` (line 256–268): similar flow for fresh sessions
- `navigateToLeaf(entryId)` (line 294–304): ephemeral leaf pointer move, rebuilds context
- `forkSession(fromEntryId)` (line 275–287): copies root-to-entryId path to new session

**Message End → Persistence Chain** (line 76–90):
```
message_end event → writeChain.then(appendMessage) → SessionManager.appendMessage() → store.appendMessage()
```
- Filters by role (only user/assistant/toolResult)
- Calls `emitSessionLoaded()` to notify main thread of new state

**SessionManager Access:**
- Stored as `this.sessionManager: SessionManager | null` (line 47)
- Used in lifecycle methods to call `sm.appendMessage()`, `sm.buildSessionContext()`, etc.

### SessionManager + SessionStore Interface
**Files:**
- Manager: `/packages/web-agent/src/web-agent/core/session/session-manager.ts` (lines 1–450+)
- Store: `/packages/web-agent/src/web-agent/core/session/store.ts` (interface definition)
- Types: `/packages/web-agent/src/web-agent/core/session/types.ts` (lines 1–185)

**SessionManager:**
- Owns in-memory tree state (fileEntries, byId index, leaf pointer)
- Public methods for append:
  - `appendMessage(message)` (line 267–279)
  - `appendModelChange(provider, modelId)` (line 281–294)
  - `appendThinkingLevelChange(thinkingLevel)` (line 296–308)
  - `appendSessionInfo(name)` (line 310–324)
  - `appendCustomEntry(customType, data)` (line 326–339)
  - `appendCustomMessageEntry(customType, content, display, details)` (line 341–365)
  - **`appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook)`** (line 367–393) ← **already wired**
  - `appendBranchSummary(branchFromId, summary, details, fromHook)` (line 395–419)
  - `appendLabelChange(targetId, label)` (line 421–444)

**SessionStore Interface:** delegates to store.ts (Dexie backend) — mirrors append methods but async

**Where CompactionEntry lands:**
- SessionManager: `_cacheEntry(entry)` (line 367–393) caches it in memory (byId, fileEntries)
- SessionStore: `appendCompaction()` writes to Dexie IDB
- On rebuild: `buildSessionContext()` collects branch entries and converts to messages; compaction entries become `createCompactionSummaryMessage()` in the message window

### AgentSession
**File:** `/packages/web-agent/src/web-agent/core/agent-session.ts` (lines 1–122)

**State Tracking:**
- Wraps `Agent` from `pi-agent-core`
- `getMessages(): AgentMessage[]` (line 53–55)
- `getState(): RpcSessionState` (line 44–51) returns `{ isStreaming, messageCount, hasModel, errorMessage }`
- `restoreMessages(messages)` (line 91–93) — replaces message buffer without firing events

**Token Usage / Context Size Observation:**
- **NOT directly exposed** in current AgentSession surface
- The Agent's `state.messages` array can be introspected, but usage metrics come from turn-end `usage` field in AssistantMessage
- **Model context window:** stored in `Model` object (passed via `setModel()`), visible only after `setModel()` is called in the Worker
- **Decision point:** compaction logic needs access to:
  1. Current model's `contextWindow` property (from the Model object set via RPC)
  2. Current message list length (available via `getMessages()`)
  3. Token estimation or LLM-provided usage (available from recent AssistantMessage)

### RPC Command List (rpc-types.ts)
**File:** `/packages/web-agent/src/web-agent/rpc/rpc-types.ts` (lines 19–52)

**Current Commands:**
```typescript
type RpcCommand =
  | { id, type: 'prompt'; message }
  | { id, type: 'abort' }
  | { id, type: 'get_state' }
  | { id, type: 'get_messages' }
  | { id, type: 'set_model' }
  | { id, type: 'set_system_prompt' }
  | { id, type: 'reset' }
  | { id, type: 'set_auth_token' }
  | { id, type: 'mount_vault' }
  | { id, type: 'unmount_vault' }
  | { id, type: 'set_mcp_tools' }
  | { id, type: 'tool_call_response' }
  | { id, type: 'list_sessions' }
  | { id, type: 'load_session' }
  | { id, type: 'new_session' }
  | { id, type: 'delete_session' }
  | { id, type: 'set_session_name' }
  | { id, type: 'get_session_meta' }
  | { id, type: 'fork_session' }
  | { id, type: 'navigate_to_leaf' }
```

**Where `compact` command fits:**
- After message_end event, worker-side auto-compaction check could trigger a new `{ type: 'compact' }` command sent to Worker
- Or: compaction triggered entirely in Worker, with no RPC command (preferred to keep hot path local)
- Alternatively: main-thread could send `{ type: 'compact'; settings?: CompactionSettings }` if manual compaction UI is added

**RPC Server Handler Pattern** (rpc-server.ts, lines 129–274):
- Switch on `type`, call session method, send response
- New command would follow: `case 'compact': ... await this.session.compact?.(args) ... send ok(id, 'compact')`
- RPC Client would add mirror method: `compact(settings?): Promise<void> { return this.send(...) }`

### useAgent Hook
**File:** `/packages/web-agent/src/hooks/useAgent.ts` (lines 1–309)

**Surface for Main Thread:**
- Returns object with:
  - `messages`, `streamingMessage`, `isStreaming`
  - `selectedModel`, `setSelectedModel`
  - `sendMessage(prompt)`, `stop()`, `clearMessages()`
  - `sessions` sub-object: `{ current, list, load, newSession, delete, rename, fork, navigateToLeaf, messageEntryIds }`
  - `models`, `isLoadingModels`, `loadModels()`
  - `error`, `clearError`

**Current Model Selection Flow** (lines 195–223):
1. User selects model ID + API format via `setSelectedModel(id, fmt)`
2. `sendMessage()` calls `buildModel(selectedModel, serverUrl, selectedApiFormat)` to construct Model object
3. Calls `rpcClient.setModel(model)` to push to Worker
4. Worker-side AgentSession receives it via `setModel()`

**For M7: What's Missing**
- No hook-exposed method to access current model's `contextWindow`
- No hook-exposed method to manually trigger compaction
- No display of "context usage %" to the user
- Could add: `getContextUsageInfo()` hook that Worker-side populates after each turn

### Model Info Source
**File:** `/packages/web-agent/src/lib/agent-model.ts` (lines 39–52)

**Current buildModel():**
```typescript
export function buildModel(modelId, serverUrl, fmt): Model<PiApi> {
  return {
    id: modelId,
    contextWindow: 128000,  // ← HARDCODED for all models
    maxTokens: 4096,
    ...
  };
}
```

**Issue:** Context window is **hardcoded to 128000** for all models, regardless of the actual model selected.

**BodhiModelInfo Type** (bodhi-models.ts, lines 9–12):
```typescript
export interface BodhiModelInfo {
  id: string;
  apiFormat: ApiFormat;
}
```

**Missing:** `contextWindow` field is not in BodhiModelInfo — would need to be added to Bodhi API response or looked up from a model registry.

**Decision for M7:**
1. Either: Update Bodhi API to include model metadata (context window, max tokens)
2. Or: Maintain a local model registry mapping (modelId → contextWindow)
3. Or: Query Bodhi's model metadata endpoint separately
4. For MVP: could fall back to hardcoded map or use default (e.g., 128000)

---

## 3. CompactionEntry Type Already Defined

**Confirmed:** `/packages/web-agent/src/web-agent/core/session/types.ts` (lines 65–72)

```typescript
export interface CompactionEntry<T = unknown> extends SessionEntryBase {
  type: 'compaction';
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: T;
  fromHook?: boolean;
}
```

**Details** field defaults to `unknown` — matches coding-agent's `{ readFiles: string[], modifiedFiles: string[] }` pattern from compaction.ts line 35.

---

## 4. Existing Test Patterns

### session-manager.test.ts
**File:** `/packages/web-agent/src/web-agent/core/session/session-manager.test.ts` (lines 1–150+)

**Patterns:**
- Mocks: `MemorySessionStore()` for in-memory persistence
- Helpers: `userMessage(text)`, `assistantMessage(text)` factory functions
- Tests append flow: create → appendMessage → verify leafId advances
- Tests tree state: getBranch, buildSessionContext, getTree
- Describe blocks: "SessionManager — factories + header", "SessionManager — tree state"
- Assertions on header, branch walk, message extraction, model tracking

**Test Pattern for Compaction:**
1. Create a session with MemorySessionStore
2. Append several messages to build context
3. Call `sm.appendCompaction(summary, firstKeptEntryId, tokensBefore, details)`
4. Assert leafId advances, entry cached, buildSessionContext includes compaction message
5. Verify compaction entry structure (id, parentId, timestamp)

### worker-host.test.ts
**File:** `/packages/web-agent/src/web-agent/worker/worker-host.test.ts` (lines 1–150+)

**Patterns:**
- Fake AgentSession with mocked methods (prompt, abort, reset, etc.)
- Tracks calls: `abortCount.current`, `resetCount.current`, `restoredCalls`
- FakePort: MessagePort from MessageChannel
- Tests message_end subscription: emit event, verify appendMessage called
- Tests session swap: loadSession → aborts, resets, restores, emits session_loaded
- Tests writeChain serialization: two events don't race

**Test Pattern for Compaction RPC:**
1. Create WorkerAgentHost with fake session + store
2. Trigger compaction (simulate context threshold or manual command)
3. Verify `sm.appendCompaction()` was called with correct args
4. Verify session_loaded event emitted with updated context
5. Verify message window rebuild includes compaction summary

---

## 5. Integration Points for M7

### Data Flow
```
[Main Thread: useAgent hook]
  ↓ (setSelectedModel) → store selected model
  ↓ (sendMessage)
  ↓ (RPC: setModel + prompt)
    
[Worker: WorkerAgentHost + AgentSession]
  ↓ (message_end event)
  ↓ (appendMessage to SessionManager)
  ↓ (buildSessionContext)
    
[DECISION POINT: Estimate tokens, check if compaction needed]
  ↓ if shouldCompact(contextTokens, contextWindow, settings):
  ↓ (Worker: prepareCompaction + compact from coding-agent)
  ↓ (appendCompaction to SessionManager)
  ↓ (buildSessionContext returns messages with CompactionEntry as message)
  ↓ (emitSessionLoaded with updated branch)
  ↓ (RPC: session_loaded event to main thread)

[Main Thread: useAgent updates UI]
  ↓ (setMessages with compaction summary visible)
```

### Required Changes for M7

**Worker-side (automatic, no RPC):**
1. Import compaction module: `@mariozechner/pi-coding-agent/core/compaction`
2. On message_end: check `shouldCompact(estimateContextTokens(messages), model.contextWindow, settings)`
3. If true:
   - Call `prepareCompaction(sessionManager.getEntries(), settings)`
   - Call `compact(preparation, model, apiKey, ...)`
   - Call `sessionManager.appendCompaction(result.summary, result.firstKeptEntryId, ...)`
   - Calls to buildSessionContext automatically include compaction summary

**Main Thread (UI feedback, optional for M7 MVP):**
1. No RPC command needed if compaction is worker-local
2. Could add UI display of context usage % by tracking message counts + selected model window
3. Could add manual "Compact Now" button that sends RPC command if needed

**SessionManager already supports:**
- `appendCompaction()` method (line 367–393)
- `buildSessionContext()` includes compaction messages (lines 245–261)

**Still needed:**
1. **CompactionSettings import** into Worker code (or define locally with defaults)
2. **Context window resolution:** how does Worker know selected model's window?
   - Option A: AgentSession.getModel() method to expose current model
   - Option B: Update setModel to also cache contextWindow separately
   - Option C: Pass contextWindow as separate RPC command
3. **API key for summarization LLM:** already available via AgentSession's streamFn closure or separate getApiKey callback
4. **AbortSignal** for cancellation during summarization
5. **Tests:** add to worker-host.test.ts and session-manager.test.ts

---

## Summary of Key File Locations & Line Numbers

| Component | File | Lines | Purpose |
|-----------|------|-------|---------|
| **Compaction Logic** | `packages/coding-agent/src/core/compaction/compaction.ts` | 1–823 | Trigger detection, payload prep, LLM summary, CompactionResult |
| **Branch Summarization** | `packages/coding-agent/src/core/compaction/branch-summarization.ts` | 1–355 | Fork/branch summaries (M6, not M7) |
| **Compaction Utils** | `packages/coding-agent/src/core/compaction/utils.ts` | 1–171 | File tracking, message serialization |
| **CompactionEntry Type** | `packages/web-agent/src/web-agent/core/session/types.ts` | 65–72 | Entry definition (already in place) |
| **SessionManager** | `packages/web-agent/src/web-agent/core/session/session-manager.ts` | 367–393 | `appendCompaction()` method |
| **WorkerAgentHost** | `packages/web-agent/src/web-agent/worker/worker-host.ts` | 55–90, 245–304 | Write chain, session lifecycle, message_end subscription |
| **RPC Types** | `packages/web-agent/src/web-agent/rpc/rpc-types.ts` | 19–52 | Current command union (compact not yet added) |
| **RPC Server** | `packages/web-agent/src/web-agent/rpc/rpc-server.ts` | 129–274 | Command dispatch pattern |
| **Model Building** | `packages/web-agent/src/lib/agent-model.ts` | 39–52 | Hardcoded 128000 contextWindow (ISSUE) |
| **useAgent Hook** | `packages/web-agent/src/hooks/useAgent.ts` | 1–309 | Main thread API (no context usage exposed yet) |
| **Session Manager Tests** | `packages/web-agent/src/web-agent/core/session/session-manager.test.ts` | 1–150+ | Test patterns for append/tree operations |
| **WorkerHost Tests** | `packages/web-agent/src/web-agent/worker/worker-host.test.ts` | 1–150+ | Test patterns for session lifecycle |

---

## Critical Decisions for M7 Implementation

1. **Compaction Trigger:** Worker-local (automatic on message_end) vs. RPC-driven (main thread sends command)
   - **Recommendation:** Worker-local (keep hot path in one thread, simpler state management)

2. **Model Context Window Source:** 
   - **Issue:** Currently hardcoded to 128000; need actual model metadata
   - **Options:** Bodhi API extension, local registry, or query per-model
   - **Recommendation:** For MVP, query Bodhi once per model selection; fallback to 128000

3. **API Key Access for Summarization:**
   - Already available via AgentSession's `getApiKey()` callback or auth token stashed in streamFn
   - **Recommendation:** Pass same apiKey used for main LLM calls to compaction summarizer

4. **Persistence of Compaction Settings:**
   - Should settings be stored in SessionHeader or be global?
   - **Recommendation:** Start global (DEFAULT_COMPACTION_SETTINGS), allow per-session override in future (M8)

5. **UI Feedback (optional for MVP):**
   - Context usage % indicator
   - Manual "Compact Now" button
   - Compaction history / timeline view
   - **Recommendation:** Defer to M7.2; MVP just makes it work silently
