# web-acp — 006 — M6 Extensions

Drive [`../milestones/m6-extensions.md`](../milestones/m6-extensions.md) to
a re-shaped, shipped state. M6 introduces a vault-sourced extension
runtime in `@bodhiapp/web-acp-agent` — browser-first, callback-driven,
zero UI surface.

> **Skeleton split across four files.** Read all four before drafting
> the plan. Decisions, phases, callback catalog, and research pointers
> are intentionally separated so each step of execution touches only
> what it needs.

## How to use this prompt set

Read in order:

1. **`006-m6-extensions.md`** (this file) — mission, locked decisions,
   open decisions, hard constraints, exit criteria.
2. **[`006-m6-extensions-phases.md`](006-m6-extensions-phases.md)** —
   phased implementation plan + the per-phase loop (research, spec,
   implement, port extension, e2e, gate, commit).
3. **[`006-m6-extensions-callbacks.md`](006-m6-extensions-callbacks.md)** —
   catalogue of callbacks (in scope / out / deferred) and example
   extensions to port from `coding-agent` per callback group.
4. **[`006-m6-extensions-research.md`](006-m6-extensions-research.md)** —
   what to read in this repo + externally; what to defer until a
   specific phase requires it.

After all four are read, draft a phased plan at
`ai-docs/web-acp/plans/m6-extensions.md`. One commit per phase. Do not
start implementing before the plan is reviewed. Use `AskUserQuestion`
only when a decision changes the plan's shape; cosmetic choices, pick
and move on.

## Mission

A user drops a JS module at `<mount>/.pi/extensions/<name>/index.js`.
The next session loads it. The module exports a default factory
`(pi: ExtensionAPI) => void | Promise<void>` that registers tools,
lifecycle callbacks, slash commands, and providers. The agent invokes
those callbacks at the right moments and exposes registered tools on
the canonical ACP surface.

The model is loosely based on `packages/coding-agent/`'s extension
system, but the runtime is **browser-first** and **callback-only** —
no `pi-tui`, no dialogs, no widgets. Anything that requires
user-interaction primitives is out of scope for M6.

Per-host scope: M6 ships only on `packages/web-acp/` (browser host).
The agent package's loader must remain transport- and host-neutral so
future hosts (Node, websocket, etc.) can pick it up without churn. Do
not import any browser-only module from
`packages/web-acp-agent/src/agent/extensions/`.

## Locked decisions (do not re-ask)

These were confirmed by the user at kick-off.

1. **Extension shape: single ES module entry point.**
   `<mount>/.pi/extensions/<name>/index.js`. Default export is a
   factory `(pi: ExtensionAPI) => void | Promise<void>`. Multi-file
   extensions are allowed if siblings live alongside `index.js` and
   use relative imports. **No `package.json`, no `node_modules`, no
   TypeScript, no jiti.** Richer formats (Node-only deps, packaged
   tarballs, OS-specific binaries) are a problem for later hosts.

2. **Slash commands are in scope, text-only.**
   `pi.registerCommand("foo", { handler })` is supported. The handler
   may transform/inject text, mutate session state, or return a string
   that becomes the next `session/prompt`. **No `ctx.ui.*` access from
   any callback.** UI primitives (dialogs, widgets, footers, status
   bars, custom editors, message renderers, keyboard shortcuts, custom
   tool rendering) are out of scope for M6, full stop.

3. **Volume tags: free-form `string[]` plus well-known constants.**
   `VolumeInit` gains `tags?: string[]`. The agent package exports a
   small `WELL_KNOWN_VOLUME_TAGS` namespace (e.g. `AGENT_WD = "agent-wd"`,
   `CWD = "cwd"`, possibly `DATA = "data"`). Loader, install path, and
   skill code refer to constants; users may add private tags freely.

4. **`pi.registerProvider` is in M6, full surface.** Match
   `coding-agent`'s semantics: model definitions, optional OAuth
   (`login` / `refreshToken` / `getApiKey` / `modifyModels`), optional
   `streamSimple`, custom headers / auth header. Adapter goes through
   the agent's existing `LlmProvider` registry, not `pi-ai` directly.
   OAuth needs a browser-friendly flow — design that during the
   provider phase.

5. **No UI extension hooks.** Drop everything from coding-agent's
   `ExtensionAPI` that touches `pi-tui`, dialogs, widgets, custom
   editors, message renderers, `pi.registerShortcut`, `pi.registerFlag`,
   or `ctx.ui.*`. If a callback can be expressed as "intercept text or
   data and return text or data", it is in scope. Anything else is not.

6. **`/extension add <npm-package>` is the LAST phase.** Do not
   research npm tarball URLs, CORS, tar parsing libraries,
   package-resolution strategies, or registry APIs until you reach
   that phase. When you do, the package unpacks into the volume
   tagged `agent-wd` and normal discovery picks it up.

7. **Test-driven, callback-by-callback.** Each phase implements one
   callback (or a tightly grouped set), ports an example extension
   that uses it, and adds an e2e step asserting end-to-end behaviour.
   No callback ships without a real ported extension and a real
   assertion.

8. **One thematic e2e file: `extensions.spec.ts`.** Follows the
   pattern of `packages/web-acp/e2e/builtins.spec.ts` — one `test()`,
   many `await test.step(...)` calls building progressively in a
   single session. Fewer, deeper test files; faster setup; failure
   names the broken theme directly.

9. **Trust model: fully trusted.** Same as the existing milestone
   doc. Document, move on. Sandboxing is post-v1.

10. **Per-host scope: `packages/web-acp/` only.** `cli-acp-client`
    and `ws-acp-client` are not part of M6 even if they exist in the
    tree.

## Open decisions for the exploration agent

Settle these in the Phase-0 research memo, then proceed. Use
`AskUserQuestion` only if your research changes the shape of the plan.

- **Callback grouping & sequencing.** The user explicitly delegated
  this to the exploration agent. Group similar callbacks (e.g.
  `before_agent_start` and `before_provider_request` are both
  "mutate-before-LLM" hooks; could ship together). Decide which group
  ships first based on which gives the cheapest, most demonstrable
  e2e signal. See [`006-m6-extensions-callbacks.md`](006-m6-extensions-callbacks.md)
  for a starting hypothesis.
- **Discovery cadence.** Boot-only? Re-scan on `_bodhi/extensions/reload`?
  Volume-mount-aware watcher? Start simple; layer up only if needed.
- **Conflict resolution.** Two extensions register the same tool /
  command name. coding-agent uses load-order suffixes for commands
  and last-write-wins for tools. Pick a policy; document it.
- **Module identity for shared imports.** When two extensions both
  `import { ExtensionAPI } from "@bodhiapp/web-acp-agent"`, they should
  resolve to the same module identity (so `instanceof` survives).
  Decide whether you achieve this via blob URLs + import-map shim,
  factory-arg injection, or some other mechanism.
- **Reload granularity.** Per-extension, per-mount, or session-wide?
- **Persistence shape for `/extension off`.** Most natural location is
  the M5-unified `PreferenceStore` under a new key like
  `extensionsDisabled: string[]`. Confirm during the research memo.
- **Provider OAuth in browser.** `pi.registerProvider({ oauth })` in
  coding-agent uses Node-only OAuth helpers. The browser equivalent
  must work via popup or iframe redirect. Plan how this lives in the
  worker or whether the host provides an OAuth bridge over the ACP
  wire (the existing Bodhi auth flow at `@bodhiapp/bodhi-js-react` is
  a relevant precedent).

## Hard constraints

1. **Specs co-commit with code.** Touch
   `ai-docs/web-acp/specs/web-acp-agent/extensions.md` (create on
   first phase) whenever the agent's extension surface changes; touch
   `ai-docs/web-acp/specs/web-acp-client/` whenever host responsibilities
   change.
2. No `any`, no `@ts-ignore`, no skipped tests, no inline imports
   (`await import(...)` for types is forbidden — see `AGENTS.md`).
3. ACP wire stays canonical. Extension-registered tools ride normal
   `session/update (tool_call)`. Extension commands merge into normal
   `available_commands_update`. New `_bodhi/*` ext-methods only when
   stock ACP cannot carry the surface; constants in
   `acp/methods.ts`-equivalent on the agent side.
4. `packages/web-acp-agent/src/agent/extensions/` MUST NOT import
   `@zenfs/dom`, `node:*`, or any browser/Node-specific module. Loader
   is host-neutral. Browser-only fetch / blob / URL access lives in
   `packages/web-acp/src/`.
5. No `page.waitForTimeout` in new e2e. Wait on `data-test-state`,
   message-bubble appearance, or explicit assertion polls.
6. One task `in_progress` at a time. Real-LLM e2e per phase, no model
   mocking unless an `AskUserQuestion` decides otherwise.
7. Treat the existing `m6-extensions.md` milestone doc as a hypothesis
   to revise, not a contract. Re-shape it as your research lands.
8. Per `AGENTS.md`: 2-space indent for new code, no emojis, no
   `git add -A`, no `git commit --no-verify`.

## Exit criteria

- [ ] Research memo + plan at `ai-docs/web-acp/plans/m6-extensions.md`
      reviewed.
- [ ] One commit per phase. `npm run check` (from each affected
      package) green at every commit.
- [ ] `extensions.spec.ts` grows step-by-step alongside each phase.
      All prior e2e files still green at every commit.
- [ ] At least one ported example extension per callback group, living
      under `packages/web-acp-agent/examples/extensions/<name>/index.js`
      (or wherever the plan locates them).
- [ ] Milestone doc `m6-extensions.md` re-shaped to reflect the actual
      phasing and marked **shipped**. Compliance row in `index.md`
      updated.
- [ ] Carve-outs (UI-bound coding-agent surface that didn't make M6,
      etc.) documented in `deferred.md` with one-line rationales.
- [ ] Next prompt skeleton drafted at
      `ai-docs/web-acp/prompts/007-<next>.md` — likely M7 (templates +
      skills), since M6 wires the discovery layer skills will reuse.
- [ ] Exit-audit greps pass: no `ctx.ui.` in `packages/web-acp-agent/`,
      no `node:` or `@zenfs/dom` imports under
      `packages/web-acp-agent/src/agent/extensions/`.
