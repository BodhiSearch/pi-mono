# Phase 1 fixtures

Four extensions, live under
`packages/web-agent/e2e/data/sample-phase-1-extensions/.pi/extensions/`
and mirrored in `sample-with-extensions/`. They exercise the original
browser-native extension runtime — commands, tools, the
`before_agent_start` hook, loader error capture, and per-extension error
isolation.

- [`fancy-prompt`](#fancy-prompt)
- [`hello-tool`](#hello-tool)
- [`broken`](#broken)
- [`thrower`](#thrower)

---

## `fancy-prompt`

Path: `fancy-prompt/index.js`

**Capability demonstrated:** the `before_agent_start` reducer hook can
override the system prompt. Also shows how a command handler can flip
internal extension state that a later hook observes, without touching
the UI channel.

**Slash commands**

| Command | Effect |
|---------|--------|
| `/fancy-prompt` | Toggle "pirate" mode on / off. No LLM call. |

**Hooks**

- `pi.on('before_agent_start', event => { … })` — when pirate mode is
  on, prepends a "CRITICAL INSTRUCTION" block to `event.systemPrompt` so
  even small instruction-weak models comply.

**How to try it**

1. Type `/fancy-prompt` in the chat input; no user bubble appears (the
   handler runs entirely in the worker).
2. Send any prompt — the model should respond in stereotypical pirate
   speech starting with "Arrr!".
3. Run `/fancy-prompt` again to toggle it off.

**What to look for**

- No visible UI side-effect when the command runs — the only witness is
  the next assistant reply's tone.
- The system prompt itself is never shown; this is the cleanest
  demonstration of invisible prompt shaping.

**Port context**

This is a browser-compatible port of
`packages/coding-agent/examples/extensions/pirate.ts`. The only
adaptations are: (a) no `ctx.ui.notify` in Phase 1, (b) no bundler-style
imports, and (c) the pirate block is placed at the *start* of the
system prompt so gpt-4.1-nano and similar small models don't skim past
it.

---

## `hello-tool`

Path: `hello-tool/index.js`

**Capability demonstrated:** extensions can contribute LLM-callable
tools via `pi.defineTool` + `pi.registerTool`. The tool appears in the
model's tool catalog exactly like built-in tools.

**Tools registered**

| Tool | Parameters | Returns |
|------|-----------|---------|
| `hello` | `{ name: string }` | `{ content: [{ type: 'text', text: 'Hello, <name>!' }], details: { greeted: name } }` |

**How to try it**

1. Ask the model something like:
   `Call the `hello` tool exactly once with name="Alice" and then reply with just the text the tool returned, no extra words.`
2. Wait for the stream to finish.
3. Observe the `hello completed` tool-call bubble in the transcript.
4. The assistant follow-up message should contain `Hello, Alice!`.

**What to look for**

- Tool-call bubble with `data-testid="chat-tool-hello"`.
- Small instruction-weak models sometimes wrap the result in extra
  prose; the underlying tool output is unambiguous.

**Port context**

Port of `packages/coding-agent/examples/extensions/hello.ts`. Swaps
`@mariozechner/pi-ai` + `@mariozechner/pi-coding-agent` imports for the
`pi.Type` / `pi.defineTool` re-exports the factory receives. Drops the
`label` field, which is a TUI-only affordance.

---

## `broken`

Path: `broken/index.js`

**Capability demonstrated:** loader error capture. The file is
intentionally malformed JavaScript (`function broken(pi {`) so dynamic
`import()` rejects. The runtime records the error on the extension's
descriptor and continues scanning the rest of `/vault/.pi/extensions/`.

**Slash commands / hooks**

None — the module never executes.

**How to try it**

1. Open the Extensions popover (puzzle-piece icon next to the model
   picker).
2. Find the row with `data-testid="extensions-row-broken"`. It will be
   decorated with `data-test-state="broken"` and render the captured
   parse error inline.

**What to look for**

- The global error indicator on the extensions trigger (red dot at
  `data-testid="extensions-error-indicator"`).
- Other extensions remain loadable and toggleable; the broken one
  cannot be enabled.
- No effect on the agent loop — broken extensions are simply invisible
  to the runner.

**Do not** "fix" the syntax error. The broken state is the test.

---

## `thrower`

Path: `thrower/index.js`

**Capability demonstrated:** the `ExtensionRunner` isolates per-handler
errors. A hook that throws on every invocation does not take down the
agent loop; instead the error fans out as an `extension_error` RPC
event.

**Slash commands**

None. The extension subscribes only to `before_agent_start`.

**Hooks**

- `pi.on('before_agent_start', () => { throw new Error(...); })` —
  always throws.

**How to try it**

1. Open the Extensions popover and confirm `thrower` is enabled.
2. Send any chat message. The agent runs normally; the response
   streams as if nothing happened.
3. Open the popover again — the `thrower` row has
   `data-test-state="error"` and renders the most recent thrown error
   message inline.

**What to look for**

- The global error indicator lights up after the first turn.
- Toggling the extension off stops the error from recurring on
  subsequent turns.
