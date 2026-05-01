# web-acp e2e refactor — Phase 1 (source + POM, tests untouched-by-logic)

## Context

The previous attempt at the web-acp e2e blackbox migration (stashed at
`stash@{0}`, plan archived at
`.cursor/plans/web-acp_e2e_blackbox_d95f7daa.plan.md`) bundled four
workstreams into one stash:

1. **A** — naming pass (`data-teststate` → `data-test-state`).
2. **B** — `btn-stop` UI affordance in `ChatInput`.
3. **C** — POM split + fixtures + flows.
4. **D** — five thematic spec files replacing the existing 13.

Workstream **D** rewrote every test, deleted the legacy specs, and the
combined diff turned out to be impossible to land green — too many
test failures, too entangled to bisect, abandoned and stashed.

**Phase 1 strips out workstream D.** We replay only the source-code
and POM changes from the stash. The 13 existing spec files keep their
structure, control flow, fixtures, and method calls — the only test
edits are the mechanical selector-string renames that follow from the
source rename. After Phase 1 the suite still has 13 specs (each in
its current shape), but the codebase is structurally ready for
workstream D to land in a later phase as an isolated, reviewable
change.

The intended outcome is: `npm run test:e2e` passes after Phase 1
with the same 13 specs running the same scenarios, the source
attribute naming is consistent at `data-test-state`, the new POMs
exist alongside `ChatPage.ts` as unused-but-ready scaffolding, and
the `btn-stop` button is wired up.

## Scope

### In

- Source rename `data-teststate` → `data-test-state` across 10
  components.
- Source rename `data-testsessions={N}` → `data-test-state={String(N)}`
  in `SessionPicker.tsx` (the SessionPicker also gets the rename, this
  bullet is the dual-attribute collapse).
- Add `btn-stop` button in `ChatInput.tsx` (visible only while
  `isStreaming === true`); `ChatDemo.tsx` passes `stop` and
  `isStreaming` through.
- `eslint.config.js` — disable `react-hooks/rules-of-hooks` for
  `e2e/**/*.ts` so Playwright's fixture `use(value)` callback is not
  flagged.
- `playwright.config.ts` — set `timeout`, `expect.timeout`,
  `actionTimeout`, `navigationTimeout` all to 30 000 ms.
- Mechanical selector-string updates in `ChatPage.ts` (5
  `data-teststate` + 1 `data-testsessions` occurrences) and 10 spec
  files (29 `data-teststate` occurrences).
- Move admin POMs `LoginPage.ts`, `ApiModelsPage.ts`, `McpsPage.ts`
  into `e2e/tests/pages/admin/`; update `e2e/tests/global-setup.ts`
  imports.
- Add 9 new POMs as additive files (no spec yet imports them):
  `AuthPage`, `SetupOverlayPage`, `StatusBar`, `MessagesView`,
  `SessionPickerComponent`, `VolumesPanelComponent`,
  `FeaturePanelComponent`, `McpPanelComponent`,
  `CommandPickerComponent`.
- Add `e2e/tests/fixtures.ts` (custom `test` exporting all POMs as
  fixtures) and `e2e/tests/flows.ts` (`appReady` etc.) as additive
  files. Not imported by any current spec.

### Out (deferred to a later phase)

- The slim refactored `ChatPage.ts` from the stash. We **keep** the
  existing `ChatPage.ts` and only update its selector strings —
  preserving every method (`login`, `loadModels`, `waitForSessionCount`,
  `clickSession`, `deleteSession`, `getAssistantText`, etc.) so the
  current 13 specs continue to compile and run.
- Spec consolidation: deletion of the 13 legacy specs and creation
  of the 5 thematic specs (`chat`, `sessions`, `builtins`,
  `tools-and-volumes`, `mcp`).
- `e2e/CLAUDE.md` documenting the blackbox stance — lands with the
  spec rewrite phase.
- The minor `chat.spec.ts` and `builtins.spec.ts` content edits in
  the stash (those are part of the spec rewrite, not Phase 1).

### Hard constraints

- `npm run test:e2e` from `packages/web-acp/` must pass after Phase 1
  with the same 13 specs running the same scenarios as today.
- No spec file gets a logic change — only the mechanical
  `data-teststate` → `data-test-state` substring edit where
  applicable.
- No new POM, fixture, or flow file is referenced by any existing
  spec; they sit dormant until Phase 2 wires them in.

## Step-by-step

### Step 1 — Source: naming pass + btn-stop + config

Mirror the stash diffs verbatim for these files. All are at
`packages/web-acp/`:

| File | Edit |
| --- | --- |
| `src/components/Header.tsx` | `data-teststate` → `data-test-state` (line ~84). |
| `src/components/StatusIndicator.tsx` | `data-teststate` → `data-test-state` (line ~15). |
| `src/components/chat/BashToolCall.tsx` | `data-teststate` → `data-test-state` (line ~22). |
| `src/components/chat/ChatMessages.tsx` | `data-teststate` → `data-test-state` (line ~85). |
| `src/components/chat/MessageBubble.tsx` | `data-teststate` → `data-test-state` (line ~35). |
| `src/components/chat/SessionPicker.tsx` | drop `data-testsessions={sessions.length}` and emit `data-test-state={String(sessions.length)}` on the `<aside>`; rename `data-teststate` → `data-test-state` on the row `<button>`. |
| `src/components/features/FeaturePanel.tsx` | `data-teststate` → `data-test-state` on the `<section>` (line ~51) and on each `<li>` (line ~64). |
| `src/components/volumes/VolumeRow.tsx` | `data-teststate` → `data-test-state` (line ~22). |
| `src/components/volumes/VolumesPanel.tsx` | `data-teststate` → `data-test-state` (line ~25). |
| `src/mcp/McpPanel.tsx` | `data-teststate` → `data-test-state` (line ~66 only — the rest of the file already uses `data-test-state`). |
| `src/components/chat/ChatInput.tsx` | accept `onStop` and `isStreaming` props; replace the lone send-button with a `isStreaming ? <stopButton/> : <sendButton/>` ternary; stop button uses `data-testid="btn-stop"`, `aria-label="Stop streaming"`, lucide `Square` icon, calls `onStop`. |
| `src/components/chat/ChatDemo.tsx` | destructure `stop` from `useAcp()` (already returned at line ~150 of `useAcp.ts`); pass `onStop={stop}` and `isStreaming={isStreaming}` to `<ChatInput>`. |
| `eslint.config.js` | inside the `files: ['e2e/**/*.ts']` block, add `'react-hooks/rules-of-hooks': 'off'`. |
| `playwright.config.ts` | add `timeout: 30_000`, `expect: { timeout: 30_000 }`, and inside `use:` add `actionTimeout: 30_000` and `navigationTimeout: 30_000`. |

### Step 2 — Existing ChatPage selector strings (mechanical)

Edit `packages/web-acp/e2e/tests/pages/ChatPage.ts` in place — keep
every method, only update selector strings:

- `selectors.authenticated`: `data-teststate` → `data-test-state`.
- `selectors.clientReady`: `data-teststate` → `data-test-state`.
- `selectors.serverReady`: `data-teststate` → `data-test-state`.
- `waitForSessionCount(...)` body — change
  `${this.selectors.sessionPicker}[data-testsessions="${expected}"]`
  to `${this.selectors.sessionPicker}[data-test-state="${expected}"]`.
- `clickSession(...)` body — change `[data-teststate="active"]` to
  `[data-test-state="active"]`.
- `waitForActiveSession(...)` body — same `[data-teststate="active"]`
  → `[data-test-state="active"]` substitution.

No new methods added, no methods removed, no signature changes.

### Step 3 — Spec selector strings (mechanical)

Across the 10 spec files listed below, run a literal-string find +
replace `data-teststate` → `data-test-state`. Do not touch method
calls, control flow, comments, imports, or anything else.

Counts come from the current tree:

| Spec | Occurrences |
| --- | --- |
| `e2e/builtins.spec.ts` | 7 |
| `e2e/volumes.spec.ts` | 6 |
| `e2e/bash-smoke.spec.ts` | 3 |
| `e2e/features.spec.ts` | 2 |
| `e2e/mcp-roundtrip.spec.ts` | 2 |
| `e2e/prompt-templates.spec.ts` | 2 |
| `e2e/mcp-toggles.spec.ts` | 1 (the rest already use kebab) |
| `e2e/sessions-persist.spec.ts` | 1 |
| `e2e/sessions-resume.spec.ts` | 1 |
| `e2e/slash-commands.spec.ts` | 1 |

After this step, `grep -r "data-teststate" packages/web-acp/` must
return zero. `data-testsessions` is dropped at the source side too
(SessionPicker), so confirm with
`grep -r "data-testsessions" packages/web-acp/` → zero.

### Step 4 — Move admin POMs

```
git mv packages/web-acp/e2e/tests/pages/LoginPage.ts \
       packages/web-acp/e2e/tests/pages/admin/LoginPage.ts
git mv packages/web-acp/e2e/tests/pages/ApiModelsPage.ts \
       packages/web-acp/e2e/tests/pages/admin/ApiModelsPage.ts
git mv packages/web-acp/e2e/tests/pages/McpsPage.ts \
       packages/web-acp/e2e/tests/pages/admin/McpsPage.ts
```

Then update `packages/web-acp/e2e/tests/global-setup.ts` lines ~14–16
to import from `./pages/admin/...` instead of `./pages/...`.

`global-setup.ts` is the only file that imports these admin POMs
today (verified by grep). No other update needed.

### Step 5 — Add new POMs (additive)

Create the following files at `packages/web-acp/e2e/tests/pages/`,
copying their content verbatim from the stash. None of them are
imported by any existing spec; they sit dormant until Phase 2.

- `AuthPage.ts` — login / logout / mid-session re-auth.
- `SetupOverlayPage.ts` — first-boot setup walkthrough.
- `StatusBar.ts` — client/server ready badges.
- `MessagesView.ts` — message bubble queries + clipboard.
- `SessionPickerComponent.ts` — session row enumeration.
- `VolumesPanelComponent.ts` — volume row queries.
- `FeaturePanelComponent.ts` — feature toggle queries.
- `McpPanelComponent.ts` — MCP server/tool queries.
- `CommandPickerComponent.ts` — slash-command picker.

These all reference `data-test-state` (kebab) only — they are
correct against the post-Step-1 source tree.

### Step 6 — Add fixtures + flows (additive)

Create `packages/web-acp/e2e/tests/fixtures.ts` and
`packages/web-acp/e2e/tests/flows.ts`, copying verbatim from the
stash.

`fixtures.ts` exports a custom `test` and `expect`. No existing spec
imports from it; existing specs continue to import
`{ test, expect } from '@playwright/test'`. The fixture file
references the new POMs only.

### Step 7 — Verify

From `packages/web-acp/`:

```bash
npm run check          # biome + tsgo for the package
npm run test:e2e       # run all 13 existing specs
```

Expected:

- `npm run check` clean (the new POMs may need an
  `eslint-disable react-hooks/rules-of-hooks` comment, but the
  eslint change in Step 1 already covers `e2e/**/*.ts`).
- `npm run test:e2e` shows the same green it shows on `main`
  today.

If a spec fails, the only legitimate cause is a missed selector
rename — fix the rename, do not change spec logic. If a non-rename
failure surfaces, stop and re-evaluate: it likely means the source
rename touched something a spec was depending on in a way the diff
didn't make obvious, and that's a finding for the plan, not a
freelance fix.

## Critical files

Reused / modified:

- `packages/web-acp/src/components/Header.tsx`
- `packages/web-acp/src/components/StatusIndicator.tsx`
- `packages/web-acp/src/components/chat/BashToolCall.tsx`
- `packages/web-acp/src/components/chat/ChatDemo.tsx`
- `packages/web-acp/src/components/chat/ChatInput.tsx`
- `packages/web-acp/src/components/chat/ChatMessages.tsx`
- `packages/web-acp/src/components/chat/MessageBubble.tsx`
- `packages/web-acp/src/components/chat/SessionPicker.tsx`
- `packages/web-acp/src/components/features/FeaturePanel.tsx`
- `packages/web-acp/src/components/volumes/VolumeRow.tsx`
- `packages/web-acp/src/components/volumes/VolumesPanel.tsx`
- `packages/web-acp/src/mcp/McpPanel.tsx`
- `packages/web-acp/eslint.config.js`
- `packages/web-acp/playwright.config.ts`
- `packages/web-acp/e2e/tests/pages/ChatPage.ts` (selector edits only)
- `packages/web-acp/e2e/tests/global-setup.ts` (admin POM import paths)
- `packages/web-acp/e2e/*.spec.ts` (10 files, mechanical attribute
  rename only)

Reference (read-only):

- `packages/web-acp/src/hooks/useAcp.ts` — confirms `stop` is
  already returned in the `useAcp()` shape.
- `.cursor/plans/web-acp_e2e_blackbox_d95f7daa.plan.md` (in stash)
  — original plan that introduced workstreams A–E. Phase 1 here
  delivers A + B + the additive parts of C; the consolidated specs
  (D) and the `e2e/CLAUDE.md` (E) are deferred.

Moved:

- `packages/web-acp/e2e/tests/pages/{LoginPage,ApiModelsPage,McpsPage}.ts`
  → `e2e/tests/pages/admin/`.

Added (new files, all under `packages/web-acp/e2e/tests/`):

- `pages/AuthPage.ts`, `pages/SetupOverlayPage.ts`,
  `pages/StatusBar.ts`, `pages/MessagesView.ts`,
  `pages/SessionPickerComponent.ts`,
  `pages/VolumesPanelComponent.ts`,
  `pages/FeaturePanelComponent.ts`,
  `pages/McpPanelComponent.ts`,
  `pages/CommandPickerComponent.ts`,
  `fixtures.ts`, `flows.ts`.

## Verification

Manual checks at the end:

1. `grep -rn "data-teststate" packages/web-acp/` → zero.
2. `grep -rn "data-testsessions" packages/web-acp/` → zero.
3. `grep -rn "btn-stop" packages/web-acp/src/` → at least one hit
   in `ChatInput.tsx`.
4. `ls packages/web-acp/e2e/tests/pages/admin/` →
   `ApiModelsPage.ts`, `LoginPage.ts`, `McpsPage.ts`.
5. `ls packages/web-acp/e2e/tests/pages/` → `AuthPage.ts`,
   `ChatPage.ts`, `CommandPickerComponent.ts`,
   `FeaturePanelComponent.ts`, `McpPanelComponent.ts`,
   `MessagesView.ts`, `SessionPickerComponent.ts`,
   `SetupOverlayPage.ts`, `StatusBar.ts`,
   `VolumesPanelComponent.ts`, `admin/`.
6. From `packages/web-acp/`: `npm run check` clean,
   `npm run test:e2e` green across all 13 existing specs.

A green run confirms the source rename + the new files do not
regress the suite. A regression run on `main` (i.e. before Phase 1)
of the same specs gives the comparison baseline if anything looks
suspicious.

## What lands in a later phase (not Phase 1)

- **Phase 2** — replace `ChatPage.ts` with the slim refactored
  version; rewrite the 13 specs into the 5 thematic ones using
  `fixtures.ts` + `flows.ts` + the new POMs; delete
  `helpers/install-requested-mcps.ts`; add `e2e/CLAUDE.md`. This is
  the workstream-D + cleanup + workstream-E content from the
  archived plan.
- **Phase 3 (optional)** — `storageState` reuse to amortise the
  OAuth boot across the consolidated suite.
