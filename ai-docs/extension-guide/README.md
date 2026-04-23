# Extension guide — test fixtures

Practical walkthrough for every extension that ships under
`packages/web-agent/e2e/data/sample-*-extensions/.pi/extensions/`. The goal
is to let you see each extension capability without decoding an e2e test —
install the vault, open the web-agent, and drive the extension through the
slash palette / extensions popover to observe the surface it exercises.

The test fixtures double as the web-agent's only executable reference
implementations for the Phase 1 / 2a / 2b extension surfaces. If you are
writing a new extension, one of these is the closest thing to a template
that exists in-tree today.

## How to use this guide

1. Start with [Prerequisites & setup](#prerequisites--setup) to install a
   fixture vault and reach a running web-agent.
2. Open the page with `?e2e=1` (or run the dev server via
   `npm run dev:e2e`) so `window.__zenfsSeed` is picked up. In production
   builds the app falls back to the FSA picker + WebAccess backend.
3. Pick the phase document below that matches the capability you want to
   see. Each fixture entry lists the exact slash command / button /
   observation target.
4. The fixture source files themselves are heavily commented — treat them
   as the second layer of documentation.

## Capability index

| Capability | Fixture(s) | Phase |
|------------|-----------|-------|
| `before_agent_start` system-prompt shaping | `fancy-prompt` | 1 |
| `pi.defineTool` + `pi.registerTool` | `hello-tool` | 1 |
| Loader error surfacing (broken JS) | `broken` | 1 |
| Per-extension error isolation + `extension_error` event | `thrower` | 1 |
| `on('context')` reducer | `context-injector` | 2a |
| `on('tool_call')` — mutate or block | `tool-gate` | 2a |
| `on('turn_start')` / `on('message_end')` observers | `notifier`, `progress-widget`, `title-marker` | 2a / 2b |
| `on('session_loaded')` observer | `reload-observer`, `title-marker` | 2a / 2b |
| `pi.ui.notify` toast channel | `notifier`, every fixture that reports back | 2a |
| `pi.ui.setStatus` chip | `asker`, `compaction-nudger`, `note-editor` | 2a / 2b |
| `pi.ui.select` / `confirm` / `input` modal queue | `asker` | 2a |
| `pi.ui.setTitle` chat-header slot | `title-marker`, `note-editor` | 2b |
| `pi.ui.setWidget` (`progress` / `info` / `choice`) | `progress-widget` | 2b |
| `pi.ui.editor` + `pi.ui.setEditorText` modal editor | `note-editor` | 2b |
| `pi.registerProvider` composite LLM catalog | `echo-provider` | 2b |
| `pi.registerSkill` `source: 'extension-skill'` palette | `skill-nudge` | 2b |
| `on('before_compact')` reducer / `on('after_compact')` observer | `compaction-nudger` | 2b |

## Prerequisites & setup

1. **Install a fixture vault.** The extensions are seeded from Node-side
   JS files on disk; in the browser the dev-mode boot path reads them out
   of `window.__zenfsSeed`. The easiest path is to run an e2e spec in
   headed mode so the helper seeds the vault and mounts it for you:

   ```bash
   cd packages/web-agent
   HEADLESS=false npx playwright test e2e/extensions-ui-2b.spec.ts \
     --project=chromium --headed --timeout 0
   ```

   The browser window stays open at the first `test.pause()` (or whenever
   the spec idles). Click around the running web-agent while the test is
   paused.

2. **Direct dev server path.** Alternatively, start the e2e dev server
   manually and seed the vault via the browser console:

   ```bash
   cd packages/web-agent
   npm run dev:e2e
   # in another terminal:
   node -e "const fs=require('fs'),p=require('path'); \
     const root=p.resolve('e2e/data/sample-with-extensions'); \
     const files={}; (function walk(d){for (const e of fs.readdirSync(d,{withFileTypes:true})){const a=p.join(d,e.name); if (e.isDirectory()) walk(a); else if (e.isFile()) files['/vault'+a.slice(root.length).replace(/\\\\/g,'/')]=fs.readFileSync(a,'utf8');}})(root); \
     console.log('paste this into the browser console:'); \
     console.log('window.__zenfsSeed=' + JSON.stringify({files, name:'sample-with-extensions'}) + ';location.reload();');"
   ```

   In practice the Playwright path is less error-prone — the
   `installVault` helper does exactly this.

3. **Sign in + mount the vault.** The first time the page loads you will
   see the Bodhi login and the vault-mount prompt. The fixture vault
   mounts as `sample-with-extensions` (or `sample-phase-1-extensions`).

4. **Check the Extensions popover.** The puzzle-piece icon next to the
   model picker opens the `ExtensionsPanel`. Every discovered extension
   appears there, including `broken` (marked with its load error). Use
   this popover to toggle individual extensions or press "Disable all"
   to exercise the M8 kill-switch.

5. **Find registered commands.** Type `/` in the chat input to open the
   slash palette. Extension-contributed commands carry
   `data-command-source="extension"` on the option; extension-contributed
   skills carry `data-command-source="extension-skill"` and appear under
   the `skill:<name>` namespace.

## Vault layout

Two fixture vaults ship with the repo:

| Vault | Contents | Driven by |
|-------|---------|-----------|
| `sample-phase-1-extensions/` | Only the four Phase 1 extensions (`fancy-prompt`, `hello-tool`, `broken`, `thrower`). | `e2e/extensions.spec.ts` |
| `sample-with-extensions/` | Every Phase 1 + 2a + 2b fixture (15 extensions). | `e2e/extensions-ui.spec.ts`, `e2e/extensions-ui-2b.spec.ts` |

The Phase 1 spec uses the minimal vault so the one LLM-coupled step
(`model calls the hello tool`) isn't perturbed by Phase 2a/2b hooks that
inject user preambles and cycle widgets. Manual exploration works best
against `sample-with-extensions/` because it exposes the full surface.

## Per-phase references

- [`fixtures-phase-1.md`](./fixtures-phase-1.md) — `fancy-prompt`,
  `hello-tool`, `broken`, `thrower`.
- [`fixtures-phase-2a.md`](./fixtures-phase-2a.md) —
  `context-injector`, `tool-gate`, `notifier`, `asker`, `reload-observer`.
- [`fixtures-phase-2b.md`](./fixtures-phase-2b.md) — `title-marker`,
  `progress-widget`, `note-editor`, `echo-provider`, `compaction-nudger`,
  `skill-nudge`.

## Writing your own extension

The hard requirements for an extension shipped under `.pi/extensions/`:

1. Single-file ESM `index.js`. No TypeScript, no bundler, no bare-specifier
   imports — the Blob-URL loader has no module resolver.
2. Default export is a factory function that receives the `pi` object:

   ```js
   export default function myExtension(pi) {
     pi.registerCommand('hello', {
       description: 'Say hi',
       handler: (_args, ctx) => ctx.ui.notify('hi', 'info'),
     });
   }
   ```

3. All registrations (`pi.registerCommand`, `pi.registerTool`,
   `pi.registerProvider`, `pi.registerSkill`) must happen synchronously
   during the factory call. Hook subscriptions (`pi.on(...)`) may register
   later but `session_loaded: 'mount'` fires before the factory runs, so
   treat the first turn as an implicit mount signal.
4. All payloads across `pi.ui.*`, `pi.on`, and tool calls must be
   structured-clone-safe — no functions, DOM nodes, class instances, or
   non-transferable resources.
5. Errors thrown from handlers are captured and reported through the
   `extension_error` RPC event; the rest of the run proceeds normally.

See [`ai-docs/specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md)
for the full contract, and the per-phase reference files for concrete
examples of every hook / registration / UI verb.
