# web-acp — 006 — M6 Extensions — Research targets

Read [`006-m6-extensions.md`](006-m6-extensions.md),
[`006-m6-extensions-phases.md`](006-m6-extensions-phases.md), and
[`006-m6-extensions-callbacks.md`](006-m6-extensions-callbacks.md)
first.

This file lists what the exploration agent should read, group, and
grade before drafting the plan. Read with intent. The trap is
over-reading the `coding-agent` surface and copying it verbatim; that
surface is much larger than what M6 needs and ports a lot of TUI
baggage we are explicitly excluding.

## Phase-0 reading (in this repo)

Read these before drafting `ai-docs/web-acp/plans/m6-extensions.md`.

### Required (web-acp)

1. [`../milestones/m6-extensions.md`](../milestones/m6-extensions.md) —
   the existing hypothesis. Treat as input, not contract.
2. [`../milestones/m5-extraction-and-compliance.md`](../milestones/m5-extraction-and-compliance.md) —
   the post-M4 architecture you are layering on. Engine split,
   `PreferenceStore` unification, `_bodhi/session/get` removal —
   assume these.
3. [`../steering/04-principles.md`](../steering/04-principles.md) — § 9
   (pluggable interfaces), § 15 (`_bodhi/*` namespacing), § 3
   (transport swappability).
4. `ai-docs/web-acp/specs/web-acp-agent/startup-sequence.md` and
   `ai-docs/web-acp/specs/web-acp-client/startup-sequence.md` — for
   understanding where extension boot fits in the lifecycle.
5. `packages/web-acp-agent/src/agent/volume-registry.ts` — Phase 1
   lands here.
6. `packages/web-acp-agent/src/agent/commands/loader.ts` — the closest
   analog for the new extensions loader. Mirror its discovery walk.
7. `packages/web-acp-agent/src/agent/mcp/connection-pool.ts` and the
   `_bodhi/mcp/toggles/set` ext-method handler under
   `acp/engine/ext-methods/` — reference flow for "user installs a
   thing, persists a toggle, agent reloads, advertisement
   re-emits". Mirror for `/extension off`.
8. `packages/web-acp-agent/src/acp/engine/ext-methods/index.ts` (and
   siblings) — the place to add `_bodhi/extensions/{list,reload}`
   and later `add`.
9. `packages/web-acp-agent/src/acp/engine/session-runtime.ts` and
   `prompt-driver.ts` — where lifecycle callbacks will fire from.
10. `packages/web-acp-agent/src/agent/inline-agent.ts` — how tools are
    currently composed (`InlineAgent.setModel({ tools })`); extension
    tools merge through the same path.
11. `packages/web-acp-agent/src/storage/preference-store.ts` and
    `feature-defaults.ts` — where `extensionsDisabled` likely lives
    in Phase Y.
12. `packages/web-acp/e2e/builtins.spec.ts` — the canonical thematic-
    spec pattern. Mirror this for `extensions.spec.ts`.
13. `packages/web-acp/e2e/tests/global-setup.ts` and
    `packages/web-acp/e2e/helpers/install-volumes.ts` — how to seed
    fixture vaults in e2e bootstrap.
14. `packages/web-acp/e2e/tests/pages/ChatPage.ts` and
    `MessagesView.ts` — page-object pattern to extend.

### Required (coding-agent reference, read but do not import)

15. `packages/coding-agent/docs/extensions.md` — full user-facing API.
    Skim once for breadth; the file is huge, do not re-read.
16. `packages/coding-agent/src/core/extensions/types.ts` — every event
    and the `ExtensionAPI` shape. The single most important non-doc
    file to read.
17. `packages/coding-agent/src/core/extensions/loader.ts` — discovery
    + jiti loading + `virtualModules` pattern. The browser equivalent
    must achieve the same module-identity guarantees without jiti or
    Node.
18. `packages/coding-agent/src/core/extensions/runner.ts` — handler
    dispatch, chain semantics, mutate-in-place vs return-patch.
    Decide which semantics to keep.
19. `packages/coding-agent/examples/extensions/` — read **selectively**.
    Required reads (all pure-callback, port-candidates):
    - `pirate.ts`
    - `protected-paths.ts`
    - `input-transform.ts`
    - `claude-rules.ts`
    - `provider-payload.ts`
    - `commands.ts`
    - `event-bus.ts`
    - `hello.ts`
    - `truncated-tool.ts`
    - `bookmark.ts`
    - `session-name.ts`
    - `dynamic-tools.ts`
    - `custom-provider-anthropic/index.ts`
    - `custom-provider-gitlab-duo/index.ts`

    **Skip** anything that imports `pi-tui`, calls `pi.exec`, uses
    `ctx.ui.*`, or registers shortcuts/flags/message-renderers.
20. `packages/coding-agent/test/extensions-discovery.test.ts` and
    `extensions-runner.test.ts` — patterns for unit-testing the
    loader + runner. Copy the structure, drop the Node-specific
    setup.

### Required (frozen reference, do not import)

21. `packages/web-agent/src/extensions/loader.ts` — the spike's
    Phase-3 extension loader. Cross-read for the blob-URL approach.
    **Cross-read only**, hard constraint per `CLAUDE.md`.
22. [`../../web-agent/milestones/deferred.md`](../../web-agent/milestones/deferred.md) —
    "Extension sandboxing" entry. Reaffirms our trust posture.

## Phase-0 reading (external)

External research is bounded. Don't go down rabbit holes.

- **`pi.dev/packages`** (`https://pi.dev/packages`) — browse the
  catalogue. Look at the type tags (`extension` / `skill` / `theme` /
  `prompt`). Pick 2-3 packages whose source you can read on GitHub.
  Look at the `package.json`'s `pi` manifest; that field is the
  de-facto distribution contract for the wider community. Examples
  worth a glance: `pi-web-access`, `pi-mcp-adapter`,
  `@gotgenes/pi-permission-system`, `pi-account-switcher`,
  `pi-prompt-template-model`.
- **`pi.dev/packages/pi-web-access`** — full-featured, Node-only, NOT
  portable to browser. Useful for understanding the **shape** of a
  real-world manifest. Note it declares both
  `extensions: ["./index.ts"]` and `skills: ["./skills"]` — your
  Phase-Z install path will likely mirror that when it lands.
- **`pi.dev/packages/@juicesharp/rpiv-ask-user-question`** — UI-heavy,
  NOT portable. Confirms the "out-of-scope" boundary.
- **`https://github.com/mitsuhiko/agent-stuff`** — community examples.
  `extensions/` has TS extensions; `skills/` has skill markdown.
  Useful for grounding "what do real users write".
- ACP schema (`agentclientprotocol/agent-client-protocol/schema/schema.json`)
  — confirm there is no canonical "extension" surface in ACP itself.
  Extensions are an agent-side concern; the wire stays canonical.
- `agentclientprotocol/claude-agent-acp/src/acp-agent.ts` — a thick-
  agent reference. Note that even `claude-agent-acp` does not expose
  extensions on the wire; extensions are private to the agent.

## Do NOT research yet

These belong to specific phases. Touch them only when you reach the
matching phase.

- **npm registry tarball URLs, CORS rules, registry API** — Phase Z
  only.
- **Tar parsing libraries** (`js-untar`, `pako`, `tar-stream`, etc.) —
  Phase Z only.
- **Browser OAuth popup-vs-iframe-vs-redirect mechanics** — Phase X
  only (`pi.registerProvider`).
- **ESModule import-map shims** (`es-module-shims` etc.) — only if
  Phase 2's loader research shows the basic blob-URL approach can't
  satisfy module identity for shared imports.
- **ZenFS dev-seed patterns from `bodhiapps/zenfs-browser`** — only
  if Phase 1's tag persistence requires reshaping the seed flow.
- **Skills manifest shape** — M7. The `resources_discover` hook lands
  in M6 as a placeholder; the skill consumer is M7's job.

## Test pattern reference

Read `packages/web-acp/e2e/builtins.spec.ts` line by line. The
established pattern:

- One `test.describe('<theme>', ...)` block per spec file.
- One `test('...')` inside, with a descriptive title naming the theme.
- Many `await test.step('...', async () => { ... })` calls, each one
  a logical assertion. Steps build progressively in the same session:
  setup → feature 1 → feature 2 → reload → assertion.
- Page objects (`ChatPage`, `MessagesView`, `SessionPickerComponent`,
  etc.) abstract DOM. Extend or add new ones for extension assertions;
  do not inline DOM queries.
- Wait on `data-test-state` and explicit message bubbles. Never
  `page.waitForTimeout`.
- Real LLM (no mocking unless `AskUserQuestion` decides otherwise).
  Setup runs once via `global-setup.ts`.

For `extensions.spec.ts`:

- One thematic spec, growing one or more `test.step(...)` per phase.
- Each step boots cheaply on top of the previous step's session state
  where possible (extensions stay loaded across steps; you don't need
  a fresh session per callback).
- New page objects: `ExtensionsPanelComponent` (if/when host-side
  panel lands), `ExtensionFixtures` helper for seeding
  `<mount>/.pi/extensions/<name>/index.js` files.
- Cross-link from
  `packages/web-acp/e2e/playwright.config.ts` so the new spec is
  picked up by the runner.

## Spec output

Spec files live at `ai-docs/web-acp/specs/web-acp-agent/`. The plan
must add or update:

- **`extensions.md`** — agent-runtime extension contract: file shape,
  factory signature, callback list per phase, persistence shape,
  ext-method wire shapes for `_bodhi/extensions/{list,reload,add}`.
  Co-commit with each phase's source.
- **`volumes.md`** (or update existing) — tag taxonomy added in
  Phase 1, well-known constants, host responsibility for tagging.
- Touch the agent's ACP-surface spec (whichever file owns the
  `_bodhi/*` ext-method inventory) when adding new methods.

Host-side spec (`ai-docs/web-acp/specs/web-acp-client/`):

- Add a section to whichever existing file owns "host responsibilities"
  describing FSA-volume tagging, the optional read-only Extensions
  panel, and the `/extension add` install flow when Phase Z lands.

## Heuristics for "did I read enough"

You have read enough when you can answer all of:

1. Where in `AcpSessionRuntime` does each callback fire? Name the
   file, the function, and the line range.
2. How does the M4 commands loader walk vault files? Could the
   extensions loader reuse it as-is, or does it need a sibling?
3. What does the M5-unified `PreferenceStore` look like? Where does
   `extensionsDisabled` slot in cleanly?
4. What is the import-resolution story when extension `index.js`
   says `import { Type } from "@sinclair/typebox"`? Does the agent
   bundle expose typebox at a known module URL the host can
   pre-import-map for the extension?
5. Which 5-7 `coding-agent` example extensions are pure-callback (no
   `ctx.ui.*`, no `pi.exec`, no `pi-tui` import)? Name them. (See
   [`006-m6-extensions-callbacks.md`](006-m6-extensions-callbacks.md)
   for the answer key.)
6. What does the `pi.dev` package manifest convention look like
   (`package.json` `pi` field, declared `extensions` paths, declared
   `skills` paths)? Even though we defer install to Phase Z, knowing
   the convention shapes Phase 1 / Phase 2 decisions.

If any of those is fuzzy, read more before drafting the plan.
