# M4 phase B — agent-handled built-in slash commands

## Context

Phase A (commit `7bc96d59`) shipped vault-sourced slash commands: `<mount>/.pi/commands/**/*.md` discovered by the worker, advertised over ACP `available_commands_update`, expanded agent-side in `prompt()` before the LLM call. Phase B adds **built-ins that bypass the LLM**: the user types `/help`, the worker recognises it, produces a reply, and that reply flows back into the conversation without touching the model.

Initial set: `/help`, `/version`, `/session`, `/copy`. The contract:

1. Round-trip through the worker (built-ins ride normal `session/prompt`).
2. Both user input and reply appear in the transcript, and survive reload.
3. Built-in turns are persisted, excluded from LLM-visible history on subsequent prompts (verified across fresh + post-`session/load`).
4. The frontend can tell built-ins apart from real turns; the marker survives wire + persistence.
5. Built-ins appear in the picker alongside vault commands without reshaping `ChatInput` / `CommandPicker`.
6. A discriminator on the wire is general enough that future client-action built-ins (`/share`, `/export-html`, `/feedback`) slot in without a wire change.

Stays ACP-canonical (principles § 2, § 6): no new RPC verbs, no parallel "list-builtins" surface. Built-ins ride existing `available_commands_update` (advertisement) and `session/update` with `_meta.bodhi.builtin` (delivery + render distinction + client-action dispatch) — same posture as the existing `_meta.bodhi.mcp` lifecycle (principle § 15 — `_bodhi/*` namespacing, but here as `_meta` keys, no new method constants needed).

## Wire shape

**Advertisement.** Already `available_commands_update`. Built-ins merged into the same emit alongside vault commands. `CommandPicker` is a black-box consumer of `AvailableCommand[]` — no shape change.

**Delivery.** When `prompt()` matches a built-in:
1. Worker emits the assistant reply chunk(s), each stamped with `_meta.bodhi.builtin = { command, action? }`. **Worker does not stamp user-message meta** — user-side bubble tagging is purely client-side (see Render flag).
2. Worker persists a **new entry kind `'builtin'`** (see below) — *not* `'turn'` — so `loadSession()` replays the bubbles via the new branch but `inline.restoreMessages()` (which only consumes the last `'turn'`) never feeds them to the LLM.
3. Worker returns `PromptResponse { stopReason: 'end_turn' }`. No `inline.prompt(text)` call. No `recordTurn()`.

On `loadSession()` replay, the worker re-emits the user_message_chunk *without* meta (plain text) plus the assistant chunk(s) with `_meta.bodhi.builtin`. The user bubble's tagging falls out of the same client-side rule used at send time.

**Client-action discriminator** — `_meta.bodhi.builtin.action = { kind: 'copy' }` (no payload — keeps wire/storage minimal). `kind` is the open-ended discriminator; `/share`, `/export-html`, `/feedback`, … add new kinds without touching the envelope. The client derives the copy payload from its own `messages` state at action-dispatch time: filter out non-conversational entries (tool calls, built-ins themselves, system rows), render the remaining user/assistant pairs as a simple markdown conversation, hand to `clipboard.writeText`. Action dispatch lives on the client in `useAcp.ts`, in the early-return block sibling to the existing `_meta.bodhi.mcp` handler.

**Render flag.** Two sources, one rule:
- Assistant bubble: `message.builtin` is set from `_meta.bodhi.builtin` on the agent chunk.
- User bubble: client checks input text against `availableCommands` and tags `message.builtin = { command }` locally — at send time and on reload-time replay alike. Worker stays out of user-message meta entirely (per user direction).

Rendering keys off `message.builtin` to apply a muted variant + "not sent to LLM" badge.

**No new `_bodhi/*` extension methods.** Activation, dispatch, persistence all ride existing surfaces.

## Built-in registry (worker)

New folder `packages/web-acp/src/agent/commands/builtins/`:

- `types.ts`
  ```ts
  interface BuiltinCommand {
    name: string;                   // 'help' | 'version' | 'session' | 'copy'
    description: string;
    inputHint?: string;
    handler: (args: string, ctx: BuiltinHandlerCtx) => BuiltinResult | Promise<BuiltinResult>;
  }
  interface BuiltinHandlerCtx {
    sessionId: string;
    modelId: string | null;
    serverUrl: string | null;
    sessionStats: { turnCount: number; messageCount: number };
    mcpServersConnected: string[];
    advertisedCommands: AvailableCommand[];   // for /help
    inlineMessages: AgentMessage[];           // for /copy
  }
  interface BuiltinResult {
    replyText: string;
    action?: { kind: string; payload: unknown };
  }
  ```
- `help.ts`, `version.ts`, `session.ts`, `copy.ts` — one handler each.
- `index.ts` — exports `BUILTIN_COMMANDS: BuiltinCommand[]`, `findBuiltin(text): { cmd, args } | null`, `toAvailableCommand(cmd): AvailableCommand`.

### Per-command behaviour

- **`/help`** — markdown table over `ctx.advertisedCommands` (built-ins + vault, post-merge). Columns: name, description, input hint. No action.
- **`/version`** — reads `__WEB_ACP_VERSION__`, `__ACP_SDK_VERSION__` (Vite `define`); current model id + server URL from ctx. No action.
- **`/session`** — prints session id, turn count, message count, connected MCP servers. Shape inspired by `packages/coding-agent/src/modes/interactive/interactive-mode.ts` ~4695; tokens/cost omitted (not yet tracked in web-acp). No action.
- **`/copy`** — checks `ctx.inlineMessages` for at least one assistant message (built-ins are absent from this list by construction — see step 2 of Delivery). On hit: `replyText = 'Copied conversation to clipboard.'`, `action = { kind: 'copy' }` (no payload). On miss: `replyText = 'Nothing to copy yet.'`, no action. Client builds the markdown payload from its own `messages` state when it sees the action.

## Adapter changes — `packages/web-acp/src/acp/agent-adapter.ts`

1. **`#refreshAvailableCommands()`** — prepend `BUILTIN_COMMANDS.map(toAvailableCommand)` to the vault `defs` before mapping/emitting. Single emit, single advertised list. Idempotent.
2. **`prompt()`** — between `#applySlashCommandExpansion(params)` (~line 304) and `#extractPromptText(params)` (~line 305), insert `await this.#tryHandleBuiltin(params)`. Logic:
   - Extract raw text without expansion side-effects (built-ins are matched on the *original* prefix; expansion stays vault-only).
   - `findBuiltin(text)` → null ⇒ fall through to existing path.
   - Hit ⇒ build `BuiltinHandlerCtx` from adapter state (`#inline.getMessages()` for `inlineMessages`, MCP pool for connected servers, `#currentModelId`, etc.), run handler, emit assistant chunk(s) stamped with `_meta.bodhi.builtin` (no user_message_chunk emit — client already rendered the input locally), call new `store.recordBuiltin(...)`, return `{ stopReason: 'end_turn' }`. **Skip** the LLM path entirely.
3. **`loadSession()`** — entry replay loop already handles `'notification'` (re-emit verbatim) and uses the last `'turn'`'s `finalMessages` for `inline.restoreMessages()`. Add a `'builtin'` case that emits a plain user_message_chunk for `userText` (no meta) plus an assistant chunk for `replyText` carrying `_meta.bodhi.builtin = { command, action? }`. The client tags the user bubble at replay time using the same `availableCommands` lookup it uses at send time. `inline.restoreMessages()` is unchanged — it never sees built-ins, so the LLM-blindness invariant is preserved post-reload.

## Session-store changes — `packages/web-acp/src/agent/session-store.ts`

1. Extend `SessionEntryKind = 'notification' | 'turn' | 'builtin'`.
2. Add `BuiltinPayload`:
   ```ts
   interface BuiltinPayload {
     command: string;
     userText: string;
     replyText: string;
     action?: { kind: string; payload: unknown };
   }
   ```
3. Add `recordBuiltin(id, payload, at?)` to the `SessionStore` interface + `createStoreFromDb` impl. Updates `sessions.updatedAt`; does **not** bump `turnCount` (it's not a model turn) and does **not** set `title` (first real prompt still wins).
4. **No Dexie version bump.** `entries` is keyed `[sessionId+seq]` with a polymorphic `payload`; existing v1→v3 migrations don't touch the column shape. `'builtin'` is a new discriminator value, not a schema change. Add a one-line code comment near the `SessionEntryKind` union recording this property (principle § 16 — write surprises down).

## Build constants — `packages/web-acp/vite.config.ts`

Extend the existing `define` block:
```ts
__WEB_ACP_VERSION__: JSON.stringify(pkg.version),
__ACP_SDK_VERSION__: JSON.stringify(acpPkg.version),
```
Source both via `JSON.parse(readFileSync(...))` at config eval. Declare ambient `__*__` globals next to the existing `__WEB_ACP_DEV__` declaration (`src/vite-env.d.ts` or wherever the project keeps it — confirm at impl).

## Client changes

1. **`packages/web-acp/src/hooks/useAcp.ts`** — in the `session/update` handler, **add a sibling block before** the existing `_meta.bodhi.mcp` early-return (file currently 328–399):
   - If `notification._meta?.bodhi?.builtin` is present on an `agent_message_chunk`: mirror the flag onto the local message during chunk accumulation so the bubble carries `builtin: { command, action? }`.
   - If the meta carries an `action`, dispatch a small handler map. `kind: 'copy'` → build a markdown transcript from the client's current `messages` state (filter non-conversational: tool calls, built-ins themselves, system rows; render user/assistant pairs as `**You:**`/`**Assistant:**` blocks separated by blank lines), then `await navigator.clipboard.writeText(markdown)`; success → `toast.success('Copied to clipboard')`; failure → `toast.error(...)`. Unknown kind → `toast.error('Unknown built-in action')` + console warn. The in-transcript "Copied last assistant message…" line still renders regardless of clipboard outcome (transcript = optimistic agent record; toast = actual client outcome) — matches the brief.
2. **`packages/web-acp/src/hooks/useAcp.ts` (user-bubble tagging)** — single client-side rule applied at two seams:
   - **Send time** (`sendPrompt`): run `findBuiltinFromCommands(input, availableCommands)` (lightweight string-prefix check against advertised names) and tag the locally-appended user message with `builtin: { command }`.
   - **Replay time** (the existing `user_message_chunk` accumulation path used by `loadSession()`): run the same lookup against the current `availableCommands` and tag the bubble. This keeps the worker out of user-message meta entirely (per user direction). One helper, two callsites.
3. **`packages/web-acp/src/components/chat/MessageBubble.tsx`** — when `message.builtin`, render with a muted variant (e.g. `text-muted-foreground`, smaller header pill) and a small "not sent to LLM" badge. Add `data-test-state="builtin"` on the bubble for Playwright. Style follows the tone-down used by tool-call bubbles.
4. **`ChatInput.tsx` + `CommandPicker.tsx`** — verified no shape change needed: built-ins arrive as ordinary `AvailableCommand` items via the same notification. Existing tests should stay green.

## Testing

**Unit (vitest):**
- `commands/builtins/help.test.ts` — given a fake ctx with mixed advertised commands, reply lists every command with description.
- `commands/builtins/version.test.ts` — reply contains build-defined strings + ctx model id + server URL.
- `commands/builtins/session.test.ts` — counts and MCP server names match ctx.
- `commands/builtins/copy.test.ts` — picks the last assistant message; emits action with that payload; "nothing to copy" path returns no action.
- `acp/agent-adapter.test.ts` (extend):
  - **Advertisement merge** — built-ins + vault commands appear in a single `available_commands_update` payload.
  - **No LLM call on built-in** — mock `inline.prompt`; assert not called when `/help` is sent.
  - **History filter** — send `/help`, then a real prompt; assert `inline.prompt` called once with the real prompt only and `inline.getMessages()` does not contain the `/help` exchange.
  - **Replay history filter** — same after a `loadSession()` round-trip: built-in entries replay as chunks but do not enter LLM-visible history.
- `agent/session-store.test.ts` (extend) — `recordBuiltin` round-trips through Dexie; `readEntries` returns the new kind.

**Playwright e2e** — single new spec `e2e/builtins.spec.ts`, structured with `test.step`:
- `'/help renders muted with badge'` — type `/help`, both bubbles carry `data-test-state="builtin"`; reply contains a known command name.
- `'/copy success path'` — send a deterministic prompt that yields a clear assistant reply; type `/copy`; assert `clipboard.readText()` equals the assistant text; sonner toast `Copied to clipboard` visible.
- `'/copy nothing-to-copy path'` — fresh session; type `/copy`; in-transcript `Nothing to copy yet.`; no clipboard write attempted.
- `'reload preserves built-ins and excludes them from LLM history'` — send `/help`; send a real prompt whose reply would *measurably* change if `/help` text were in context (e.g. ask the model to count occurrences of a token only present in `/help`'s output); reload; assert (a) both built-in bubbles reappear, (b) the LLM reply does not reference `/help` content. Tool-observation alternative if prompt-shaping proves flaky: instrument an assertion on the wire that `session/prompt` follow-on never carries built-in text in `inlineMessages` snapshot via a DEV-only test seam.
- `'clipboard failure surfaces in toast'` — stub `navigator.clipboard.writeText` to reject; toast error visible; in-transcript record still present.

**Gate:** `npm run check` clean from repo root; `npm test` green from `packages/web-acp/`; `npm run test:e2e` green from `packages/web-acp/` against `.env.test` LLM.

## Out of scope (record on M4 milestone close)

- `/name`, `/model`, `/new`, `/resume`, `/settings`, `/login`, `/logout` — state-mutation built-ins; next slice.
- `/compact` (M7), `/fork` + `/tree` (M6), `/reload` (M5), `/scoped-models` (post-M5).
- `/export`, `/import`, `/share`, `/quit` — incompatible with the browser; deferred.
- `/mcp`, `/volumes`, `/features` — fold in once built-ins infrastructure is settled.
- A separate "command catalog" UI distinct from the picker.

## Critical files

Modify:
- `packages/web-acp/src/acp/agent-adapter.ts`
- `packages/web-acp/src/agent/session-store.ts`
- `packages/web-acp/src/hooks/useAcp.ts`
- `packages/web-acp/src/components/chat/MessageBubble.tsx`
- `packages/web-acp/vite.config.ts`
- `packages/web-acp/src/vite-env.d.ts` (or equivalent ambient-globals file)

New:
- `packages/web-acp/src/agent/commands/builtins/{types,help,version,session,copy,index}.ts`
- `packages/web-acp/src/agent/commands/builtins/*.test.ts`
- `packages/web-acp/e2e/builtins.spec.ts`

Test extensions (existing files):
- `packages/web-acp/src/acp/agent-adapter.test.ts`
- `packages/web-acp/src/agent/session-store.test.ts`

## Verification

1. `npm run check` from repo root — biome + tsgo + browser-smoke clean.
2. `npm test` from `packages/web-acp/` — vitest green including new files.
3. `npm run test:e2e` from `packages/web-acp/` — Playwright green including the new builtins spec, against a real Bodhi LLM via `.env.test`.
4. Manual smoke (`npm run dev` in `packages/web-acp/`): type `/`, picker includes `help` / `version` / `session` / `copy` alongside vault commands; run each; reload, confirm transcript persists and LLM-blindness via a follow-up real prompt; verify clipboard + toast on `/copy`.
