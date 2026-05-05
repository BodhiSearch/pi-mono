# web-acp — 006 — M6 Extensions — Callback catalog

Read [`006-m6-extensions.md`](006-m6-extensions.md) and
[`006-m6-extensions-phases.md`](006-m6-extensions-phases.md) first.

This file enumerates the extension callbacks `coding-agent` supports,
marks each as **in scope / out of scope / deferred** for M6, and lists
the example extensions to port in order to drive each phase's e2e.

The user explicitly delegated callback grouping and ordering to the
exploration agent. The groupings below are a **starting hypothesis** —
challenge them in the research memo, regroup as your loader / runtime
research lands.

## Source of truth

- `packages/coding-agent/src/core/extensions/types.ts` — every event
  and the full `ExtensionAPI`. Read this once for breadth.
- `packages/coding-agent/docs/extensions.md` — user-facing version.
  Skim, don't re-read.
- `packages/coding-agent/src/core/extensions/runner.ts` — how handlers
  are dispatched, chain semantics, mutate-in-place vs return-patch.
  Decide which semantics you keep.

## In scope for M6 (port these)

These are pure callbacks: text/data in, text/data out. No UI primitives.

### Lifecycle

| Callback | Use | Suggested port |
| --- | --- | --- |
| `session_start` | Read vault files, prepopulate state, restore prior runs. | `claude-rules.ts` (loads a rules file from the volume root, prepends to system prompt). |
| `session_shutdown` | Persist state, close handles. | `auto-commit-on-exit.ts` minus the `pi.exec`-based git call (substitute a bash-tool equivalent or skip the side-effect). |

### Pre-turn

| Callback | Use | Suggested port |
| --- | --- | --- |
| `before_agent_start` | Inject a custom message; replace system prompt for this turn. | `pirate.ts` (replaces system prompt with a pirate persona; trivial e2e signal). |
| `input` | Rewrite user input or short-circuit it (`continue` / `transform` / `handled`). | `input-transform.ts` (`?quick foo` → `Respond briefly: foo`). |

### Per-turn

| Callback | Use | Suggested port |
| --- | --- | --- |
| `turn_start` / `turn_end` | Instrumentation, counters, telemetry. | Synthesize a small `turn-counter.ts` that bumps a counter and surfaces it via a custom message. |
| `context` | Filter / modify the message list non-destructively before each LLM call. | Synthesize a `prune-old-context.ts` dropping messages older than N turns. |
| `message_start` / `message_update` / `message_end` | Stream lifecycle hooks. | Optional; only port if you find a non-UI extension that benefits. |

### Provider-level

| Callback | Use | Suggested port |
| --- | --- | --- |
| `before_provider_request` | Inspect or replace the provider-specific payload right before it ships. | `provider-payload.ts` (logs payloads to a `_meta.bodhi.debug` channel). |
| `after_provider_response` | Status + headers, before stream consumption. | Synthesize a small `rate-limit-watch.ts` that surfaces 429s. |

### Tool-level

| Callback | Use | Suggested port |
| --- | --- | --- |
| `tool_call` | Mutate `event.input` in place; or block via `{ block: true, reason }`. | `protected-paths.ts` (block writes to `.env`, `node_modules/`). |
| `tool_result` | Modify the result via partial patches before it reaches the LLM. | Synthesize a `redact-secrets.ts` scrubbing API-key patterns from tool output. |
| `tool_execution_start` / `tool_execution_update` / `tool_execution_end` | Pure instrumentation. | Optional. |

### Registration callbacks

| Callback | Use | Suggested port |
| --- | --- | --- |
| `pi.registerTool({...})` | Register an LLM-callable tool. | `hello.ts` (greet tool); `truncated-tool.ts` (rewrite to use bash-tool semantics instead of `pi.exec`). |
| `pi.registerCommand("foo", { handler })` | Register a slash command (text-only handler). | `commands.ts`. |
| `pi.registerProvider(name, config)` | Register a model provider with optional OAuth. | `custom-provider-anthropic/index.ts` (minimal proxy); `custom-provider-gitlab-duo/index.ts` (OAuth). |

### Extension-to-extension

| Callback | Use | Suggested port |
| --- | --- | --- |
| `pi.events.on/emit` | Inter-extension event bus. | `event-bus.ts`. |

### Session metadata

| Callback | Use | Suggested port |
| --- | --- | --- |
| `pi.appendEntry(customType, data)` | Persist extension state alongside session entries. | Synthesize `session-counter.ts` (counter persists across reload). |
| `pi.setSessionName(name)` | Set session display name. | `session-name.ts`. |
| `pi.setLabel(entryId, label)` | Bookmark entries. | `bookmark.ts`. |
| `pi.sendMessage` / `pi.sendUserMessage` | Inject messages into the session. | Stripped-down version of `file-trigger.ts`. |

### Resource discovery (placeholder for M7)

| Callback | Use | Suggested port |
| --- | --- | --- |
| `resources_discover` | Contribute additional skill / prompt paths. | Wire the surface in M6 (no behavior; just routes through). The actual skill consumer lands in M7 templates + skills. |

## Out of scope for M6 (UI-bound)

These all touch `coding-agent`'s `ctx.ui.*`, `pi-tui`, or other
host-only primitives. **Do not port.** Document each in
`deferred.md` with a one-line rationale ("UI surface — out of M6").

- TUI rendering: `setStatus`, `setWidget`, `setHeader`, `setFooter`,
  `setTitle`, `setEditorComponent`, `setHiddenThinkingLabel`,
  `setWorkingMessage`, `setEditorText`, `pasteToEditor`,
  `setToolsExpanded`, theme APIs.
- Dialogs: `ctx.ui.confirm`, `select`, `input`, `editor`, `notify`,
  `custom`.
- Custom rendering: `pi.registerMessageRenderer`, tool `renderCall` /
  `renderResult`, `renderShell`.
- Keyboard shortcuts: `pi.registerShortcut`.
- CLI flags: `pi.registerFlag` (browser has no CLI).
- `pi.exec` (Node `child_process`) and `bash-spawn-hook` (depends on
  local `exec`).
- `ctx.ui.custom()` overlays / `OverlayHandle`.

## Deferred but not blocked (M7 / M8 / M9 / later)

- **`session_before_compact` / `session_compact`** — compaction is M9.
- **`session_before_fork` / `session_before_switch` /
  `session_before_tree`** — fork is M8.
- **`model_select`** — works in M6 if registration plumbing is ready,
  but no port mandatory until a consumer surfaces.
- **`user_bash`** — `!` / `!!` user-typed shell commands. Not a feature
  in web-acp's current input pipeline. Defer until/if the host gains
  this affordance.
- **Compaction hooks (`before_compact`, `after_compact`)** — M9.
- **Skills as first-class extension contribution** — M7. The
  `resources_discover` hook lands in M6 as a placeholder.

## Suggested groupings (the exploration agent re-validates)

These are starting hypotheses. Sort, split, or merge during the
research memo.

| Group | Callbacks | Suggested ports | Why these together |
| --- | --- | --- | --- |
| A — System prompt mutators | `before_agent_start`, `session_start` | `pirate.ts`, `claude-rules.ts` | Lowest e2e cost: assert a unique persona keyword appears in the assistant reply. |
| B — Tool gates | `tool_call`, `tool_result` | `protected-paths.ts`, `redact-secrets.ts` | Highest user value. e2e: ask LLM to write `.env`; assert blocked + reason. Sets up M10 permission bridge later. |
| C — Provider observability | `before_provider_request`, `after_provider_response` | `provider-payload.ts`, `rate-limit-watch.ts` | Pure instrumentation; e2e asserts a `_meta.bodhi.debug` channel recording. |
| D — Input transformation | `input` | `input-transform.ts` | Easiest to e2e-assert (input → assistant response shape). |
| E — Custom tools | `pi.registerTool` (+ `setActiveTools` / `getAllTools`) | `hello.ts`, `truncated-tool.ts` | LLM-facing; e2e: prompt invokes tool, tool-call bubble completes. |
| F — Slash commands | `pi.registerCommand` (text-only) | `commands.ts` | e2e: `/foo` advertised, handler runs, text injected. |
| G — Inter-extension | `pi.events` | `event-bus.ts` | Two extensions ping-pong; assert side effect. |
| H — Session metadata | `pi.appendEntry`, `setSessionName`, `setLabel`, `sendMessage` | `session-name.ts`, `bookmark.ts`, `session-counter.ts` | e2e: counter survives reload. |
| I — Custom providers | `pi.registerProvider` (full surface, OAuth) | `custom-provider-anthropic/`, optionally `custom-provider-gitlab-duo/` | Standalone phase due to OAuth complexity. |
| J — Toggle + reload | `_bodhi/extensions/reload`, `/extension on|off|list` | (no port — exercises existing extensions) | Persistence via `PreferenceStore`. |
| K — npm install | `/extension add <pkg>` | (research-driven pick from pi.dev catalog) | Research starts HERE, not before. |

## Real-world references for porting

These published packages exist on `pi.dev/packages`. Read source where
available; don't depend on them; study the **shape**.

- **`pi-web-access`** (`https://pi.dev/packages/pi-web-access`) —
  `web_search`, `fetch_content`, `code_search` tools. Heavy: chromium
  cookies, ffmpeg, GitHub clone. **Not portable as-is.** Useful for
  understanding what a "tool-heavy" extension looks like and how the
  package manifest declares `extensions: ["./index.ts"]` plus
  `skills: ["./skills"]` together.
- **`pi-mcp-adapter`** — interesting MCP adapter pattern; likely
  browser-friendly.
- **`pi-account-switcher`** — pure config mutation; portable.
- **`@gotgenes/pi-permission-system`** — permission gates; close to
  our `tool_call` block use case.
- **`@juicesharp/rpiv-ask-user-question`** — UI-heavy. **Not portable**
  (needs dialogs).
- **`pi-mermaid`** — TUI rendering. **Not portable**.
- **`pi-prompt-template-model`** — registers prompt-template variants;
  potentially portable.
- **`mitsuhiko/agent-stuff`** (`https://github.com/mitsuhiko/agent-stuff`) —
  read source directly. The `extensions/` folder has TS extensions;
  `skills/` has skill markdown. Useful for grounding "what do real
  users write". Pure-callback candidates: `whimsical.ts` (thinking-
  message replacer — borderline UI), `notify.ts` (desktop notifications
  — out, host-side), `loop.ts`, `review.ts`, `multi-edit.ts`.

The exploration agent should pick **at most 2-3 real-world packages**
to port (most will be UI-bound or Node-only). The bulk of the porting
work uses `coding-agent`'s `examples/extensions/` because the source
is right there.

## Where ported extensions live

Default location: `packages/web-acp-agent/examples/extensions/<name>/index.js`.

Each ported extension's directory should also contain a brief
`README.md` capturing:

- **Origin** — which coding-agent example or pi.dev package it ports.
- **Diff vs original** — what dropped on the floor (UI, Node-only,
  etc.) and why.
- **What it demonstrates** — the callback(s) it exercises and the e2e
  step that asserts behaviour.

This README is read by the e2e fixture loader and by future agents
debugging an extension regression.
