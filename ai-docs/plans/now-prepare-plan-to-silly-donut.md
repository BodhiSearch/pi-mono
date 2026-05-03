# Plan — implement spec-review fixes (web-acp / web-acp-agent)

## Context

Five parallel reviews of the post-`21e04fbc` agent/client spec split landed at
`ai-docs/web-acp/reviews/` (`00-summary.md` + `01..05`). Verdict: the split is
sound, but ~2 critical inversions, ~25 major factual errors, and a long tail of
minor / nitpick items need fixing before the specs are reliable as a reading
guide. This plan executes the fixes in scope-clustered phases, plus the
cross-cutting deduplication (collapse the 245-line wire-types twin, dedupe
url-canonical / permissions / wire-utils, resolve `wire/methods.ts`), plus
related source-code cleanups (stale comment, broken `./test-utils` export,
misplaced runtime dep), plus `/session` → `/info` rename in the non-spec docs.

End-state: every fact in the new specs grounds in code; one canonical home
for shared wire types; `npm run test:e2e` from `packages/web-acp/` passes
post-change at parity with the pre-change baseline.

## Working references

The detailed line-cited findings live in:
- `ai-docs/web-acp/reviews/00-summary.md` — prioritized synthesis (43 items)
- `ai-docs/web-acp/reviews/01-web-acp-agent-wire.md` — agent acp/agent/sessions/features
- `ai-docs/web-acp/reviews/02-web-acp-agent-runtime.md` — agent volumes/tools/commands/mcp/startup
- `ai-docs/web-acp/reviews/03-web-acp-client-wire.md` — host acp/transport/hooks/startup
- `ai-docs/web-acp/reviews/04-web-acp-client-runtime.md` — host storage/volumes/mcp/commands/features
- `ai-docs/web-acp/reviews/05-cross-cutting.md` — duplication / org / consistency

The implementer should keep these open while editing — every plan-phase
bullet below is paired with a `(#NN issue M)` pointer back to the source
finding for resolving ambiguity.

## Phase 0 — Baseline e2e

Run from `packages/web-acp/`:

```bash
npm run test:e2e
```

Record pass/fail counts. Capture any pre-existing failures to a scratch file
so the post-change run can distinguish drift from existing flake. **Do not
proceed if baseline catastrophically fails** — the e2e harness must be
healthy before refactoring source code.

## Phase 1 — Critical spec fixes (2 items, same-PR)

Both are behavioural inversions a reader would act on.

### 1.1 `requestPermissionStub` returns vs throws

- `ai-docs/web-acp/specs/web-acp-agent/acp.md` § Permissions (lines ~300-301)
  — rewrite from "Always returns `{ outcome: { allow: true } }`" to "Throws
  an Error — the M0 permission bridge is deferred; the bash tool runs without
  invoking it." Source: `packages/web-acp-agent/src/acp/permissions.ts:15-17`.
  (#00 critical 1, #01 critical 1.)
- `ai-docs/web-acp/specs/web-acp-client/acp.md` line ~263 — same rewrite.
  Source: `packages/web-acp/src/acp/permissions.ts:15-17`. (#03 minor m7.)

### 1.2 `useAcp()` return shape

- `ai-docs/web-acp/specs/web-acp-client/hooks.md` § `useAcp` facade (lines
  ~45-52) — replace the flat `mcpInstances/mcpStates/mcpToggles/setMcpToggle/
  dispatchAction` listing with the actual nested shape:
  ```
  mcp: { instances, states, toggles, isLoading, error, refresh, setToggle }
  ```
  Drop `dispatchAction` from the public-return list. Source:
  `packages/web-acp/src/hooks/useAcp.ts:142-178`. Consumer:
  `packages/web-acp/src/components/chat/ChatDemo.tsx:33`. (#00 critical 2,
  #03 critical C1.)

## Phase 2 — `/session` → `/info` rename in non-spec docs

The agent's command handler renamed `/session` → `/info` (lives at
`packages/web-acp-agent/src/agent/commands/builtins/info.ts`). Only
`web-acp-agent/commands.md` was updated. Sweep these 8 lines:

- `CLAUDE.md:258`
- `ai-docs/web-acp/milestones/index.md:53, :69 (×2), :258`
- `ai-docs/web-acp/milestones/m4-commands-and-skills.md:9, :68, :222`
- `ai-docs/web-acp/steering/02-architecture.md:27`

Search-and-replace `/session` → `/info` in slash-command-list contexts only
(do not touch unrelated `/session` prose, e.g. ACP method names).
(#00 item 29, #05 issue 12.)

## Phase 3 — Agent-side spec fixes

Cluster by file. Reference the per-file review for nitpick wording.

### 3.1 `web-acp-agent/acp.md`

- ext-methods table (Group A): fix `host.features.setKey` → `host.features.set`
  (#01 issue 2); fix `host.mcpToggles.set` → "dispatches to `setServer` /
  `setTool` based on `toolName`" (#01 issue 3); fix builtin-dispatch call
  path: `runtime.sendRawNotification` → `conn.sessionUpdate` (#01 issue 4);
  fix `sessionsDelete` ordering: prepend `mcpPool.releaseAll` and the
  inline-clear step (#01 issue 5).
- `loadSession` description: add the "only releases prior config when
  `existing` is set, and only the previously-held servers" nuance.
  (#01 issue 10.)
- `AcpSessionRuntime` MCP-pool subscription: clarify the wrapper closure
  vs. direct `broadcastMcpPoolEvent` reference. (#01 issue 12.)
- Permissions: see Phase 1.1.

### 3.2 `web-acp-agent/agent.md`

- `BodhiProvider` line numbers (Group B, 6 lines):
  `buildApiAliasModel:122` → 112, `buildLocalAliasModel:145` → 130,
  `apiFormatOfModel:246` → 227, `extractApiModelId:171` → 154,
  `extractApiModelDisplayName:183` → 166, `extractApiModelLimits:194` → 177.
  (#01 issue 7.)
- `InlineAgent.clearMessages` description: extend caller list to include
  `prompt-driver.ts:rehydrateInlineFromStore` and `sessions-delete.ts:26`.
  (#01 issue 13.)

### 3.3 `web-acp-agent/commands.md`

- Front-matter `#` inversion: rewrite "treated as keys and rejected" →
  "skipped as comments". (#02 major 2.)
- `/info` field list: drop "server URL" and "mounted volumes"; keep `Id`,
  `Turns`, `Messages`, `Model`, `MCP servers` (matches `info.ts:7-22`).
  (#02 major 3.)
- Line ~279: replace `acp/wire-utils.ts:extractMcpMeta` with the correct
  helper (most likely `extractSessionMeta`) or drop the reference.
  (#02 major 4.)
- Loader step 2: change "lexicographically" → "locale-aware
  (`localeCompare`)". (#02 nitpick 9.)
- Loader fallback parenthetical: note the empty-body fallback returns
  `'(no description)'`. (#02 nitpick 10.)
- `tokenizeBash` double-quote escapes: extend list from `\\`, `\"` to all
  four (`\\`, `\"`, `\$`, `` \` ``). (#02 nitpick 11.)
- `BuiltinHandlerCtx` source phrasing: distinguish `mcpInstances` /
  `requestedMcpUrls` (per-session) from `sessionStats` /
  `mcpServersConnected` (runtime accessors). (#02 nitpick 13.)

### 3.4 `web-acp-agent/mcp.md`

- Connection-pool auth fingerprint: rewrite "JSON.stringify(headers...)
  with canonical sort" → "fingerprints the `Authorization` header value
  only (case-insensitive name match)". Note that other header changes do
  not evict. (#02 major 1.)
- `acquire` step 3 wording: drop "releases refs" — `#evict` deletes the
  entry without iterating refs. (#02 nitpick 4.)
- Tool adapter return-shape: surface that `content` is filtered to text
  blocks before the success return. (#02 nitpick 12.)
- `_meta.bodhi.mcp` envelope: document the `state: event.type` key shape +
  conditional `error`/`tools` fields, citing `session-runtime.ts:201-209`.
  (#02 nitpick 14.)
- `releaseAll` description: split into `dispose()` + `sessions-delete.ts`
  callsites; note `loadSession` calls `releaseMcpConnections`, not
  `releaseAll`. (#02 nitpick 25.)
- `deriveSlugFromUrl`: add the `localhost` skip case at
  `url-canonical.ts:60`. (#02 nitpick 34.)

### 3.5 `web-acp-agent/tools.md`

- `bashInputSchema`: change "four optional fields" → "three optional fields
  + one required (`script`)". (#02 nitpick 5.)
- `execute` step 5: change `signal` → `combined.signal` (the linked
  controller's signal — without it the timeout never fires).
  (#02 nitpick 6.)
- `VolumeFileSystem` method enumeration: drop `copyFile`; tighten the
  count from "~25 methods" to "21 methods" (or list them).
  (#02 nitpicks 7-8.)

### 3.6 `web-acp-agent/volumes.md`

- `unmount` log level: note `console.warn` for `umount` failures vs
  `console.error` for `mountAll` failures. (#02 nitpick 18.)
- Add the volume-control sidechannel pointer (Lifecycle events § —
  cite `web-acp-client/transport.md`). (#05 issue 14.)

### 3.7 `web-acp-agent/index.md`

- Folder layout: `wire/methods.ts` description — change "barrel re-export
  root" → "partial barrel" (or delete the file in Phase 5). (#01 issue 7.)
- ext-methods comment: distinguish `_bodhi/*` vs legacy `bodhi/*` prefix
  (3 handlers use the legacy form). (#01 issue 8.)
- Public-surface enumeration: add missing commands-group exports
  (`tokenizeBash`, `InvalidCommandPathError`, `isValidSegment`,
  `FrontMatterError`, `CanonicalNameInput`, `BUILTIN_COMMANDS`).
  (#01 issue 23, #05 issue 41.)
- Storage-interfaces note: tighten language so the "no browser-only deps"
  claim is reconciled with `bodhi-js-react` (call out `import type` only).
  (#05 issue 13.)
- Add a one-line note that `PromptTurnDriver`, `AcpSessionRuntime`, etc.
  are engine internals not on the public barrel. (#01 issue 23.)
- Test-utils export note: align with whatever Phase 6.1 chooses (rename
  dir or remove export).

### 3.8 `web-acp-agent/sessions.md`

- No issues flagged. Re-verify after Phase 6.1 in case the test-utils
  decision affects the section.

### 3.9 `web-acp-agent/features.md`

- "`Defaults — :15`" heading: clarify that line 15 is the `FeatureDefaults`
  interface; `FEATURE_DEFAULTS` value object is at line 20. (#01 issue 16.)

### 3.10 `web-acp-agent/startup-sequence.md`

- Phase 6 narrative: trim duplication with `acp.md` § prompt-driver — pick
  `acp.md` as canonical, replace the 11-step recap with a one-line link.
  (#05 issue 10.)

## Phase 4 — Host-side spec fixes

### 4.1 `web-acp-client/commands.md`

- Picker filter: change "case-insensitive substring match" → "case-
  insensitive prefix match" (`startsWith`). (#04 major M1.)
- Picker keymap: drop `Tab = (same as Enter)` row. (#04 major M2.)
- Helper table: drop `extractText` (private) and `narrowBuiltinAction`
  (private), or split the table into "exported" vs "private". (#04 major
  M5, nitpick n5.)
- `MessageBubble` style: change `bg-gray-200` → `bg-blue-100` (user) /
  `bg-gray-100` (assistant). (#04 nitpick n6.)
- `withBuiltinTag` motivation: rewrite the cast rationale (discriminated-
  union spread, not narrowing). (#04 minor m13.)
- Built-in dispatch table: replace re-stated table with a pointer to
  `acp.md`. (#05 issue 11.)

### 4.2 `web-acp-client/mcp.md`

- Status panel: drop "Add server affordance: textarea + button" and
  "Remove affordance: per-row trash icon" — neither exists. Replace with
  a sentence: "the panel renders status + per-server / per-tool toggles
  only; mutation flows through `/mcp add` / `/mcp remove` slash commands
  via `dispatchBuiltinAction`." (#04 majors M3, M4.)
- Optional: cross-link the agent-side type rename (`McpPoolEvent.type` →
  `McpConnectionMeta.state`). (#04 minor m1.)

### 4.3 `web-acp-client/hooks.md`

- `useAcp` return shape: see Phase 1.2.
- `composeCurrentMcpServers` signature: change
  `(token, baseUrl, mcpInstances?)` → `(toggles?: McpToggleSnapshot)`.
  Note token + baseUrl are read inside the closure. (#03 minor m15.)
- `streamingMessageRef` mechanism: rewrite "the reducer kept up to date"
  → "synced via `useEffect` on `state.streamingMessage`; the reducer is
  pure, the ref is a side-effect of the consuming hook." (#03 major M10.)
- `useAcpFeatures.featureDefaults` source: change "mirrors the agent's
  `FEATURE_DEFAULTS`" → "populated by `refreshFeatures` from the worker's
  per-call response (`payload.defaults`)". (#03 major M11.)
- `useAcpSession` boot effects: split the description into two effects —
  `refreshSessions` (no auth gate) and auto-`ensureSession` (gated).
  (#03 minor m16.)
- Slice mount order: relabel `useReducer` as a primitive React call (not
  a slice hook); list 8 slice hooks + 1 reducer. (#03 major M4, minor m11.)
- `setMcpToggles` description: clarify it's a React setter consumed by
  `useAcpSession.ts:213` after `getSession`. (#03 minor m14.)

### 4.4 `web-acp-client/volumes.md`

- Drop "Called once per worker boot from `agent-worker.ts:startAgent`" —
  no `startAgent` function. Replace with "called inside the worker's
  `init`-message handler in `agent-worker.ts`". (#04 minor m3.)
- Boot-effect step 6: rewrite "real state transitions land via volume-
  control replies" — the hook never reads volume-control replies; real
  transitions come from the awaited `mount()` promise inside
  `addVolume`/`restoreAccess`. (#04 minor m8.)
- `MainZenfs.mount` symmetry note: tighten "same `InMemory.create + seed
  loop`" — agent side seeds via `VolumeInit.initialize`, host seeds inline
  in `mount()`. Same outcome, different mechanism. (#04 minor m2.)
- `addVolume` failure handling: note `recordsRef.current` and
  `saveHandles` are not touched on failure. (#04 minor m7.)

### 4.5 `web-acp-client/storage-dexie.md`

- `fake-indexeddb/auto`: change "declared in `vitest.config.ts`'s setup
  script" → "imported per-test in each `*.test.ts` file". (#04 minor m5.)
- Dexie v3 schema sample: tighten phrasing (`+ mcpToggles: '&sessionId'`
  is shorthand; source explicitly re-declares all four tables in
  `version(3)`). (#04 nitpick n2.)
- agent-worker.ts factory: clarify `createStoreFromDb(openSessionDb())`
  vs `createSessionStore`. (#04 minor m6.)

### 4.6 `web-acp-client/startup-sequence.md`

- Phase 6 step 1 auth-promise wait: move the `await getAuthPromise()`
  description from `ensureSession` to `useAcpStreaming.sendMessage`
  (where it actually happens). (#03 minor m19.)
- Agent-worker.ts line count: change "~75 lines" → "96 lines"
  (or drop the figure). (#03 major M6.)

### 4.7 `web-acp-client/index.md`

- Folder-layout block: add missing files (App.test.tsx, App.css,
  index.css, components/Header.tsx, Layout.tsx, StatusIndicator.tsx,
  components/chat/{BashToolCall,ChatInput,ChatMessages,CommandPicker,
  MessageBubble,ModelCombobox,SessionPicker}.tsx, components/volumes/
  VolumeRow.tsx, components/ui/* (12 shadcn files), test/setup.ts,
  runtime/storage-dexie/agent-adapter.test.ts). (#03 major M5.)
- Public surface SDK re-exports: replace "etc." with the full enumerated
  list from `acp/index.ts:1-23` (21 items + 3 values). Also add
  `BodhiFeatureBag`. (#03 major M1, M2; #05 issue 42.)
- `streaming-reducer.ts` exports: change "plus initial-state factories"
  → "plus the `initialStreamingState` constant". (#03 major M1.b,
  #00 item 25.)
- agent-worker.ts annotation: confirm "Web Worker entry — calls
  startAcpAgent from agent package". (#03 minor m1.)

### 4.8 `web-acp-client/acp.md`

- `AcpClient.signal` docs: note no internal code currently consumes it.
  (#03 minor m3.)
- `AcpRuntime.volumeControl.dispose()` lifecycle: document the dispose
  path (currently silent). (#03 major M3.)
- Permissions: see Phase 1.1.
- `'reset'` action wording: rewrite "reset everything except
  `availableCommands` / `mcpStates`" → "reset to `initialStreamingState`,
  fresh `Map` for `toolCalls`. Live `availableCommands` accumulated
  during a session **are** discarded." (#03 major M8.)
- `mcp-add` / `mcp-remove` dispatch: clarify error-then-info-toast order.
  (#03 major M9.)

### 4.9 `web-acp-client/transport.md`

- Worker boot shim line count: change "~75 lines" → "96 lines"
  (or drop the figure). (#03 major M6.)
- `createMessagePortStream` chunk types: note silent drop for
  unrecognised types. (#03 minor m8.)
- Build-time constants: tighten `BUILD_VERSION` / `ACP_SDK_VERSION`
  default-string description. (#03 minor m9.)

### 4.10 `web-acp-client/features.md`

- Verify cross-link to `clearFeatures` from
  `useAcpSession.clearMessages` resolves to a real call site.
  (#04 minor m12.)

## Phase 5 — Cross-package source-code dedup

This is the structural refactor; biggest blast-radius — do after the
spec edits so reviewers can read both halves.

### 5.1 Delete dead host `wire-utils.ts`

`packages/web-acp/src/acp/wire-utils.ts` has zero importers (verified by
grep). Delete the file. Update spec mention in `web-acp-client/acp.md`
§ wire helpers — rewrite to "host re-imports from
`@bodhiapp/web-acp-agent` (wire-utils helpers live agent-side)".
(#05 issue 6.)

### 5.2 Re-export instead of duplicate: `mcp/url-canonical.ts`

Replace `packages/web-acp/src/mcp/url-canonical.ts` with a single-line
re-export:
```ts
export { canonicalizeMcpUrl, deriveSlugFromUrl } from '@bodhiapp/web-acp-agent';
```
Verify all importers (host side) compile. Update specs:
`web-acp-client/mcp.md:127` and `web-acp-agent/mcp.md:199` to reflect
the canonical home. (#05 issue 7.)

### 5.3 Re-export instead of duplicate: `acp/permissions.ts`

Replace `packages/web-acp/src/acp/permissions.ts` with:
```ts
export { requestPermissionStub } from '@bodhiapp/web-acp-agent';
```
Update specs (already covered in Phase 1.1). (#05 issue 8.)

### 5.4 Collapse wire-types twin

The largest item. `packages/web-acp/src/acp/index.ts` (244 lines) is
byte-identical to `packages/web-acp-agent/src/wire/index.ts` (240
lines) modulo whitespace + one comment. Replace the host file's
constants/types block with a wildcard re-export from the agent
package:
```ts
export * from '@bodhiapp/web-acp-agent';
// keep host-specific SDK re-exports below if any
```
Then verify:
- Every import from `@/acp` in host code still resolves.
- `tsc -b` passes.
- Spec text in both `index.md` files: drop the "duplicated 1:1"
  caveat. (#00 item 30, #05 issue 5.)

### 5.5 Resolve `wire/methods.ts`

`packages/web-acp-agent/src/wire/methods.ts` is a partial barrel with
zero importers. Two options — pick **delete** unless there is a known
consumer that pins the file path:
- (a) Delete the file. Update `web-acp-agent/index.md` folder layout
  to drop the `wire/methods.ts` row.
- (b) Complete the barrel: add the missing constants
  (`BODHI_MCP_TOGGLES_SET_METHOD`, `BODHI_SESSIONS_DELETE_METHOD`,
  `BODHI_LIST_SESSIONS_METHOD`) + the `BodhiBuiltinAction*` family.
  Update spec.

Recommend (a). (#00 item 32, #05 issue 2.)

## Phase 6 — Source-code cleanups

### 6.1 Fix `packages/web-acp-agent/package.json` `./test-utils` export

Current: points at `./src/test-utils/index.ts` which does not exist.
`src/test/` exists with `seed-volume.ts` and `setup.ts` (no `index.ts`).

Pick:
- (a) Rename `src/test/` → `src/test-utils/` and add `src/test-utils/
  index.ts` re-exporting `seed-volume`. Update Vitest config
  (`vite.config.ts:setupFiles` or similar) to point at the renamed
  setup script. Update `web-acp-agent/index.md` folder layout.
- (b) Remove the `./test-utils` export from `package.json` (if no
  external consumer needs it). Update `web-acp-agent/index.md`.

Recommend (a) — the export was clearly intended; rename is mechanical
and unblocks consumers. (#05 issues 3 + 15.)

### 6.2 Move `@bodhiapp/bodhi-js-react` to `devDependencies`

Confirmed: zero non-`import type` usages in
`packages/web-acp-agent/src/`. Move from `dependencies` →
`devDependencies` so the runtime claim "no browser-only deps" holds
verbatim. Update `web-acp-agent/index.md` allowed-deps list.
(#05 issue 13, #00 item 34.)

### 6.3 Fix stale `applyRequestedMcpsUpdate` reference

`packages/web-acp/src/hooks/useAcpMcp.ts:71-77` docblock references a
function that doesn't exist (verified — single grep hit). Investigate
the actual sync mechanism (likely the inline `setRequestedMcpUrls` /
ref mutation in the `/mcp add` / `/mcp remove` dispatch); rewrite the
docblock to match real behaviour. **Do not delete** — the docblock
documents real state. (#04 minor m4.)

## Phase 7 — Cross-cutting org / nav cleanups

### 7.1 README extraction-target callout

Add a one-line note to `ai-docs/web-acp/specs/README.md` clarifying
that `web-acp-agent` is the (already-extracted) library, `web-acp` is
the extraction-pending reference app. (#05 issue 20.)

### 7.2 Historical paths preservation note

Add a paragraph to `ai-docs/web-acp/specs/README.md` (or a header
comment in each affected file) explaining that `prompts/002-*.md`,
`003`, `004`, `005`, and `plans/m1-sessions.md` reference the
deleted `specs/web-acp/` tree because they are immutable historical
artifacts; readers should resolve old paths to the new
`specs/web-acp-agent/` + `specs/web-acp-client/` layout.
(#00 item 38, #05 issue 16.)

### 7.3 Milestone link fix

`ai-docs/web-acp/milestones/m3.5-followups.md:40` — the link reads
`[useMcpInstances](../specs/web-acp-agent/mcp.md)`. Repoint to
`../specs/web-acp-client/mcp.md` (the host hook). (#05 issue 1.)

### 7.4 Volume-control sidechannel pointer

Already covered in Phase 3.6 (agent-side volumes.md) — ensure
the cross-link to `web-acp-client/transport.md` is present.
(#05 issue 14.)

### 7.5 Boundary-claim consolidation

Both index files claim "ACP-only across the boundary". Either move the
shared text to `specs/README.md` and have both halves link, or leave
duplicate but reword the agent index to acknowledge the volume-control
sidechannel between host main thread and worker (the agent itself
sees only the stream pair). (#05 issue 24.)

### 7.6 Streaming-contract single-page (deferred decision)

Items 36/#05 issue 25 propose a single `streaming-contract.md`. This
is a bigger doc-restructure call. **Deferred** to a follow-up plan;
note the intent in `web-acp-agent/index.md` § Change procedure.

### 7.7 `bootstrap.ts` end-to-end (deferred decision)

Items 37/#05 issue 22 propose a dedicated `bootstrap.md` topic file
covering `startAcpAgent` + `onAdapter`. **Deferred** to a follow-up
plan unless drafting the page proves trivial during Phase 3.

## Phase 8 — Verification

Run from `packages/web-acp/`:

```bash
npm run test:e2e
```

Compare against the Phase 0 baseline:
- All baseline-passing tests must still pass.
- New failures: retry up to **3 attempts** (full `npm run test:e2e`
  re-run, no `--grep` filter) to rule out flake.
- If failures persist after 3 attempts, **stop and report**: list the
  failing tests + the most recent failure trace. Do not patch tests
  to make them pass.

Also run from repo root before the final commit:

```bash
npm run check                      # biome + tsgo + browser-smoke
```

In `packages/web-acp/`:

```bash
npm test                           # unit
npm run check                      # lint + typecheck
```

In `packages/web-acp-agent/`:

```bash
npm test
npm run check
```

## Out of scope (explicitly)

- `specs/cli-acp-client/` — its own scope.
- Any net-new feature work or refactor not driven by the review findings.
- Deleting the historical `prompts/`/`plans/` files — they are immutable.
- Migrating `streaming-contract.md` / `bootstrap.md` page splits
  (deferred per 7.6/7.7).

## Critical files this plan touches (summary)

Spec edits:
- `ai-docs/web-acp/specs/web-acp-agent/{index,acp,agent,sessions,features,volumes,tools,commands,mcp,startup-sequence}.md`
- `ai-docs/web-acp/specs/web-acp-client/{index,acp,transport,hooks,startup-sequence,storage-dexie,volumes,mcp,commands,features}.md`
- `ai-docs/web-acp/specs/README.md`
- `ai-docs/web-acp/milestones/{index,m4-commands-and-skills,m3.5-followups}.md`
- `ai-docs/web-acp/steering/02-architecture.md`
- `CLAUDE.md`

Source edits / file moves:
- `packages/web-acp/src/acp/wire-utils.ts` (delete)
- `packages/web-acp/src/acp/permissions.ts` (re-export only)
- `packages/web-acp/src/acp/index.ts` (collapse to wildcard re-export)
- `packages/web-acp/src/mcp/url-canonical.ts` (re-export only)
- `packages/web-acp/src/hooks/useAcpMcp.ts` (rewrite docblock at :71-77)
- `packages/web-acp-agent/src/wire/methods.ts` (delete or complete)
- `packages/web-acp-agent/src/test/` → `src/test-utils/` (rename + add index)
- `packages/web-acp-agent/package.json` (`./test-utils` export path,
  `bodhi-js-react` → `devDependencies`)
- `packages/web-acp/vite.config.ts` (setupFiles path if test/ renamed)

## Sequencing rationale

Phases 0 → 1 → 2 are isolated, low-blast-radius, and resolve the
critical user-facing inversions first. Phases 3 → 4 are the bulk of
the spec work and can run in parallel chunks (each `.md` file is
independent). Phase 5 is the source-code refactor — sequenced after
specs so spec text already references the post-refactor topology.
Phase 6 is small isolated source cleanups. Phase 7 is cross-cutting
nav/org polish. Phase 8 verifies end-to-end.
