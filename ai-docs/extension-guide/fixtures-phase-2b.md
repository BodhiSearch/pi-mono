# Phase 2b fixtures

Six extensions that live under
`packages/web-agent/e2e/data/sample-with-extensions/.pi/extensions/`.
They exercise Phase 2b's additions: the widened `session_loaded.reason`
union, compaction reducer + observer hooks, `pi.registerProvider` /
`pi.registerSkill`, the read-only session forwarder, and the expanded
`pi.ui.*` channel (`setTitle`, `setWidget`, `editor`, `setEditorText`).

- [`title-marker`](#title-marker)
- [`progress-widget`](#progress-widget)
- [`note-editor`](#note-editor)
- [`echo-provider`](#echo-provider)
- [`compaction-nudger`](#compaction-nudger)
- [`skill-nudge`](#skill-nudge)

---

## `title-marker`

Path: `title-marker/index.js`

**Capability demonstrated:** `pi.ui.setTitle` — a chat-header slot
owned by the extension. Combined with the widened
`session_loaded.reason` union to show which transition triggered the
last title update.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/title-set <text>` | Set the extension title to `<text>` (empty string → `title-marker: manual`). |
| `/title-clear` | Clear the extension title. |

**Hooks**

- `pi.on('session_loaded', event => pi.ui.setTitle('title-marker: '
  + event.reason))` — updates on `mount`, `reload`, `switch`, `fork`,
  `new`, `navigate`.
- `pi.on('message_end', () => pi.ui.setTitle('title-marker: <reason>
  (idle)'))` — regression guard that re-applies the title after every
  message, even if another extension cleared it mid-turn.

**How to try it**

1. Load the app. The chat header should show
   `title-marker: mount` immediately.
2. Create a new chat — title switches to `title-marker: new`.
3. Switch to an existing session in the picker — title switches to
   `title-marker: switch`.
4. Run `/title-set hello` — title switches to `hello`.
5. Run `/title-clear` — the slot disappears entirely.

**What to look for**

- Slot renders at `data-testid="extension-title"` with
  `data-extension-path=".pi/extensions/title-marker"`.
- Title is per-extension; other extensions' titles stack alongside.

---

## `progress-widget`

Path: `progress-widget/index.js`

**Capability demonstrated:** `pi.ui.setWidget(widgetId, widget |
null)` — a closed enum of widget kinds (`progress | info | choice`)
rendered as transient transcript bubbles keyed by `widgetId`. A single
extension can manage multiple slots.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/progress-show progress` | Show a progress bar widget at 42%. |
| `/progress-show info` | Show an info card widget. |
| `/progress-show choice` | Show a choice widget with Apple / Pear buttons. |
| `/progress-clear` | Remove the widget. |

**Hooks**

- `pi.on('turn_start', () => pi.ui.setWidget('progress-main', null))`
  — clears the widget at the start of every turn so widgets don't
  leak across unrelated turns.

**How to try it**

1. `/progress-show progress` — a progress bar bubble appears above
   the chat input.
2. `/progress-show info` — the same slot is replaced with an info
   card (the widget is keyed by `widgetId`, so `setWidget` replaces
   rather than stacks).
3. `/progress-show choice` — buttons become clickable; clicking one
   round-trips through `sendExtensionUIResponse` back to the worker
   (the fixture currently ignores the choice; see the e2e spec for a
   full round-trip assertion).
4. `/progress-clear` — widget disappears.
5. Send a chat message after showing a widget — `turn_start` clears
   it automatically.

**What to look for**

- Widgets render at `data-testid="extension-widget"` with
  `data-widget-kind="progress"` / `"info"` / `"choice"`.
- Open-ended widget kinds are *not* available in 2b — only the three
  listed above.

---

## `note-editor`

Path: `note-editor/index.js`

**Capability demonstrated:** `pi.ui.editor` (a modal textarea dialog
that resolves with `string | undefined`) plus `pi.ui.setEditorText`
(fire-and-forget buffer mutation for the currently open editor).
The fixture also chains in `setStatus`, `setTitle`, and `notify`
to prove the result flowed back to the worker.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/edit-note [prefill]` | Open the editor with the supplied prefill (default `initial`); surface the result via status chip, title slot, and toast. |
| `/edit-note-async` | Open the editor prefilled with `before`, then `setEditorText('after')` after 50ms. |

**Hooks**

None.

**How to try it**

1. `/edit-note hello` — a modal dialog opens with `hello` in the
   textarea. The status chip reads `editing…`.
2. Press **Save** (or Cmd/Ctrl+Enter). The dialog closes; the title
   slot now reads `edit-note: hello` and a toast says `note-editor:
   saved hello`.
3. `/edit-note` again and press **Cancel** (or Escape). Title
   switches to `edit-note: cancelled`; warning toast `note-editor:
   cancelled` appears.
4. `/edit-note-async` — the dialog opens with `before`; after a
   moment the textarea content is replaced with `after` by the
   extension. Press Save.

**What to look for**

- Dialog renders at `data-testid="extension-editor"` with a
  `<textarea>` inside. Save is `[data-test-role="save"]`, Cancel is
  `[data-test-role="cancel"]`.
- Canceling resolves the awaited promise with `undefined`; saving
  resolves with the textarea's string value.
- `setEditorText` is fire-and-forget — if no editor is open it's a
  silent no-op.

---

## `echo-provider`

Path: `echo-provider/index.js`

**Capability demonstrated:** `pi.registerProvider(id, provider)` —
contribute an `LlmProvider` that the host composes with Bodhi. The
composite uses `model.provider` to pick which provider to route to;
extension catalogs are merged into the model picker.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/echo-provider-ping` | Toast listing the contributed model ids. |

**Provider registered**

- `providerId: 'echo'` returning two canned models:
  `echo-small` (1024 context, 256 max-tokens) and
  `echo-large` (4096 / 1024). `getApiKeyAndHeaders` intentionally
  throws so stray streaming calls fail loudly; the spec only asserts
  catalog state.

**How to try it**

1. Enable the extension via the popover (or have it enabled by
   default when the vault mounts).
2. Click "Refresh models" next to the model picker. `echo-small`
   and `echo-large` appear alongside the regular Bodhi / OpenAI
   catalogs.
3. `/echo-provider-ping` — toast `echo-provider:
   echo-small,echo-large`.

**What to look for**

- Selecting an `echo` model and sending a message produces a stream
  error (by design). Re-select your real provider to resume.
- The main thread listens for `extension_providers_changed` events
  and re-runs `get_available_models` whenever a provider is added
  or removed.

---

## `compaction-nudger`

Path: `compaction-nudger/index.js`

**Capability demonstrated:** the compaction hook pair. `before_compact`
is a reducer — handlers may return `{ cutIndex?: number,
preserveEntries?: AgentEntry[] }` to influence how much history the
summariser sees. `after_compact` is an observer — runner reports the
summary, before-count, and after-count.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/compact-stats` | Status chip `before=N after=M` + toast with the full counter snapshot. |

**Hooks**

- `pi.on('before_compact', event => ({ cutIndex: event.cutIndex > 0 ?
  event.cutIndex - 1 : 0 }))` — shaves one entry off the cut index so
  the summariser sees one more message.
- `pi.on('after_compact', event => { afterFires += 1; lastAfter =
  {...}; })` — records the summary metadata.

**How to try it**

1. Enable the extension; send several chat messages (10+) so
   compaction has something to do.
2. Click the "Compact conversation" button (broom icon) next to the
   chat input. A summary bubble appears in the transcript.
3. Run `/compact-stats` — toast
   `compaction-nudger: before=1 after=1 cut=<N> after=<before>→<after>`.
4. Compact again; counters increment each time.

**What to look for**

- `before_compact` handlers cannot cancel compaction — they can only
  reduce the cut or preserve more entries. That's intentional; the
  host keeps compaction correctness.
- The `after_compact` hook runs after the summariser has written the
  summary but before the UI repaints.

---

## `skill-nudge`

Path: `skill-nudge/index.js`

**Capability demonstrated:** `pi.registerSkill({ name, description,
body, disableModelInvocation? })` — contribute skills backed by an
in-memory `body` (SKILL.md-style content). The main-thread palette
lists them under `source: 'extension-skill'`, and invoking one
expands the body exactly like a filesystem-backed skill.

**Skills registered**

| Skill | `disableModelInvocation` | Body snippet |
|-------|-------------------------|--------------|
| `nudge` | `false` (default) | "Before answering, restate the user request…" |
| `nudge-disabled` | `true` | "This skill should be flagged as disableModelInvocation." |

**How to try it**

1. Type `/skill:` in the chat input. Both `skill:nudge` and
   `skill:nudge-disabled` appear in the palette with
   `data-command-source="extension-skill"`.
2. Select `skill:nudge`. The composer is staged with a
   `<skill>` block containing the nudge body. Send it to the model.
3. `skill:nudge-disabled` also appears in the palette but is
   intentionally excluded from the `<available-skills>` section of
   the system prompt.

**What to look for**

- Palette options carry `data-command-source="extension-skill"` (as
  opposed to `"skill"` for vault-backed SKILL.md entries and
  `"extension"` for command-handler extensions).
- Name collisions between extension skills and filesystem skills
  currently follow first-registered-wins silently; there is no UI
  warning yet (flagged for Phase 3).
