# web-acp — 006 — M6 Extensions — Phases

Read [`006-m6-extensions.md`](006-m6-extensions.md) first. This file is
the implementation loop.

The phase counts and groupings below are a **starting hypothesis**.
The exploration agent is expected to validate, regroup, or split during
the Phase-0 research memo. Anything below that survives the memo
becomes the plan; anything that doesn't, gets rewritten there with
explicit justification.

## The per-phase loop (apply once per phase)

For every phase, in this order:

1. **Research first.** Read the relevant files listed in
   [`006-m6-extensions-research.md`](006-m6-extensions-research.md).
   Do not skip — the failure mode of this milestone is over-confident
   invention.
2. **Spec.** Update
   `ai-docs/web-acp/specs/web-acp-agent/extensions.md` (create on
   first phase) and the host spec when host responsibilities change.
3. **Implement.** Smallest diff that lands the phase's deliverable.
   Reuse existing patterns: `commands/loader.ts` (for vault discovery
   walks), `mcp/connection-pool.ts` (for stateful registration that
   survives reload), `acp/engine/ext-methods/` (for adding `_bodhi/*`
   methods).
4. **Port an extension.** Bring a `coding-agent` example into
   `packages/web-acp-agent/examples/extensions/<name>/index.js` (or
   wherever the plan locates them). The port may need shape changes —
   that's expected. Capture the diff between the original and the
   port in a `README.md` next to the extension so future readers
   understand what dropped on the floor.
5. **E2E step.** Add a `test.step(...)` to `extensions.spec.ts`
   asserting the ported extension's behaviour. Build on previous
   steps' session state where possible — the file is one big test
   with progressive assertions, not many isolated tests.
6. **Gate-check.** From `packages/web-acp/`: `npm run check`,
   `npm test`, `npm run test:e2e`. From `packages/web-acp-agent/`:
   `npm run check`, `npm test`. All green.
7. **Commit.** One commit per phase. Message:
   `web-acp: M6 phase <N> — <slug>`.
8. **Update milestone doc.** Move the phase from "planned" to
   "shipped" in
   [`../milestones/m6-extensions.md`](../milestones/m6-extensions.md).

If a phase reveals scope creep, split it. Each commit must stay
reviewable.

---

## Phase 0 — Research memo + plan

**Source.** Nothing yet.

**Output.** `ai-docs/web-acp/plans/m6-extensions.md` containing:

- Validated phase sequence (override or accept the hypothesis below).
- Callback grouping decisions per
  [`006-m6-extensions-callbacks.md`](006-m6-extensions-callbacks.md).
- Loader strategy (blob URL? import-map shim? trade-off table.).
- Module-identity strategy for shared imports.
- Conflict-resolution policy for tool/command name clashes.
- Per-host work allocation (what's agent-package vs `web-acp/`).
- Persistence-store choice for `/extension off`.
- Browser-OAuth strategy for `pi.registerProvider`.

**E2E.** None.

**Spec.** Skeleton `extensions.md` describing the file shape and the
default-export contract. Subsequent phases extend it.

**Gate.** Plan reviewed and accepted by the user.

**Commit.** `web-acp: M6 phase 0 — extensions plan + research memo`.

---

## Phase 1 — Volume tags foundation

Tags are the smallest piece of plumbing M6 needs and unblock several
later phases (host knows where to seed extensions; install path knows
where to unpack; future skills know where to look).

**Source.**
- `packages/web-acp-agent/src/agent/volume-registry.ts` gains
  `tags?: string[]` on `VolumeInit` and `VolumeSnapshot`.
- New export `WELL_KNOWN_VOLUME_TAGS` (e.g. `AGENT_WD = "agent-wd"`,
  `CWD = "cwd"`, `DATA = "data"`).
- `findByTag(tag): VolumeSnapshot | undefined` helper on the registry.
- `_bodhi/volumes/list` payload (or whatever surface lists volumes
  today) includes tags.

**Host (`packages/web-acp/`).**
- Populates the FSA-backed volume's tags with `[AGENT_WD, CWD]` (or
  whichever well-known tags apply — confirm during research).
- Volumes panel renders tags as read-only chips. No editing UI.

**Spec.** `extensions.md` documents the tag taxonomy. Cross-link from
or create `ai-docs/web-acp/specs/web-acp-agent/volumes.md`.

**E2E.** Extend `tools-and-volumes.spec.ts` (or add an early step in
the new `extensions.spec.ts`) asserting volume tags round-trip via
`_bodhi/volumes/list`. No extension behaviour yet.

**Gate.** `npm run check`, prior e2e green, tag-round-trip step green.

**Commit.** `web-acp: M6 phase 1 — volume tags`.

---

## Phase 2 — Discover + instantiate (no callbacks yet)

Land the loader skeleton end-to-end before any callback is wired. This
phase is intentionally boring: a hello extension is loaded, recognized,
and listed. Nothing it does has any visible effect on a turn.

**Source (`packages/web-acp-agent/src/agent/extensions/`).**
- `loader.ts` — scans every mounted volume's `<mount>/.pi/extensions/`
  directory tree using the same `commandsFs` pattern that the M4
  commands loader uses. For each `<name>/index.js` (and optionally
  `<name>.js`; decide per Phase-0 memo), reads bytes, creates a blob
  URL, dynamically imports, validates the default export.
- `registry.ts` — tracks live `Extension` records:
  `{ name, sourceMount, sourcePath, factory, disabled }`.
- `api.ts` — minimal `ExtensionAPI` shape:
  - `pi.on(event, handler)` records subscriptions but never fires
    yet (callbacks are wired in subsequent phases).
  - `pi.registerTool` / `pi.registerCommand` / `pi.registerProvider`
    record intent without wiring it.
- `_bodhi/extensions/list` ext-method handler under
  `acp/engine/ext-methods/extensions-list.ts`. Returns
  `{ name, version, sourceMount, capabilities }`.

**Host.** Nothing yet beyond what Phase 1 gave us; no panel.

**Port.** `hello.ts` — a no-op factory that registers itself with
console-logged greeting on activation. Lives at
`packages/web-acp-agent/examples/extensions/hello/index.js`.

**E2E (`extensions.spec.ts`, brand new file).** Seed a volume with
`<root>/.pi/extensions/hello/index.js`. Boot a session. Assert
`_bodhi/extensions/list` shows the hello extension with the expected
metadata. No prompt flow yet.

**Gate.** `npm run check`, new spec green, prior e2e green.

**Commit.** `web-acp: M6 phase 2 — extension discovery + bare loader`.

---

## Phases 3..N — Callback groups

The exploration agent decides the grouping and ordering during Phase 0.
Each phase ships:

- The callback(s) wired into the agent runtime (`AcpSessionRuntime`,
  `PromptTurnDriver`, etc., from M5's engine split).
- Updates to `ExtensionAPI` exposing the new `pi.on(event, handler)`
  overloads or new `pi.registerX` methods.
- One ported example extension per callback (or per group).
- One or more new `test.step(...)` in `extensions.spec.ts` exercising
  the extension end-to-end against a real LLM.

Each phase commits independently with `web-acp: M6 phase <N> — <slug>`.

See [`006-m6-extensions-callbacks.md`](006-m6-extensions-callbacks.md)
for the catalog of callbacks, suggested groupings, and porting
candidates.

---

## Phase X — `pi.registerProvider` (full surface, OAuth included)

Sized as its own phase because of the OAuth and provider-registry
plumbing. The exploration agent picks where this lands in the sequence.

**Source.**
- `ExtensionAPI.registerProvider(name, config)` and
  `unregisterProvider(name)` — match coding-agent's signature exactly.
- Provider config goes through the agent's `LlmProvider` registry.
  Catalog rebuild on `authenticate` triggers re-listing so
  extension-contributed models appear via `unstable_setSessionModel`.
- Browser OAuth: decide whether the OAuth flow runs in-worker, in-host
  (bridged via the ACP wire), or via the existing `@bodhiapp/bodhi-js-react`
  popup pattern. Document the choice in the research memo before this
  phase begins.
- `unstable_setSessionModel` continues to work for extension-contributed
  models with no special-casing.

**Port.** Pick at minimum
`packages/coding-agent/examples/extensions/custom-provider-anthropic/`
(simple proxy). If scope allows, port
`custom-provider-gitlab-duo/` too for the full OAuth path.

**E2E.** Extension registers a "test-echo" provider; session selects
an extension-contributed model; prompt round-trips through it. If you
port the OAuth variant, e2e needs a fixture OAuth server (look at how
the existing `global-setup.ts` boots Keycloak for the Bodhi flow; mirror
that pattern).

**Gate.** `npm run check`; provider-selection step in
`extensions.spec.ts` green.

**Commit.** `web-acp: M6 phase X — registerProvider + OAuth`.

---

## Phase Y — `/extension off` toggle + reload

**Source.**
- Persist disabled list in M5-unified `PreferenceStore` under a new
  key (`extensionsDisabled: string[]` or namespaced under a single
  `extensions` slot — pick during research).
- `_bodhi/extensions/reload` ext-method re-runs discovery, tears down
  disabled extensions, brings up newly enabled ones. Disposable
  contract from Phase 2's API now matters.
- Built-in slash commands `/extension on|off|list` (text-only, ride
  the M4-phase-B built-ins pipeline). Distinct from extension-contributed
  commands; these are first-party.

**Port.** Any extension from a previous phase. Toggling it off proves
its callbacks no longer fire.

**E2E.** Extend `extensions.spec.ts`:
- `/extension off hello` → prompt → assert hello's mutation does NOT
  appear.
- `/extension on hello` → prompt → assert it does.
- Reload page → assert toggle persists.

**Commit.** `web-acp: M6 phase Y — extension toggles + reload`.

---

## Phase Z — `/extension add <npm-package>` (research starts HERE)

**Do not research npm/tarball mechanics until this phase begins.** This
is the only phase that touches `https://registry.npmjs.org/<pkg>/-/<pkg>-<version>.tgz`,
tar parsing, and package layouts.

**Phase-Z research checklist (read only when this phase begins).**
- npm registry tarball fetch (browser `fetch()`; CORS — does the
  registry CORS allow it? if not, host-side proxy via the existing
  Bodhi server).
- Tar parsing in browser (e.g. `js-untar`, `pako` for gzip
  decompression). Pick one with browser-compatible build, ESM, and
  acceptable size.
- Package layout: read `package.json`'s `exports['.']`, `module`, or
  `main`; reject anything that requires `node_modules` runtime
  resolution.
- Where to unpack: the volume tagged `agent-wd` from Phase 1. Path:
  `<agent-wd>/.pi/extensions/<package>@<version>/`.

**Source.**
- Built-in slash command `/extension add <pkg>` (or `/extension install`;
  match what your research shows is conventional in the wider Pi
  ecosystem — pi.dev uses `pi install npm:<pkg>`).
- Once unpacked, normal Phase-2 discovery picks the extension up on
  next reload (or the host issues `_bodhi/extensions/reload`).

**Port.** Pick a small published browser-friendly extension from the
pi.dev catalogue. Avoid anything that needs ffmpeg, Chromium cookies,
`node:*`, or a real OAuth dance. The exploration agent picks during
this phase's research, not before.

**E2E.** Install the chosen extension via the slash command, assert
it appears in `_bodhi/extensions/list`, fire one of its features, see
the expected response.

**Gate.** `npm run check`, install + invoke flow green in
`extensions.spec.ts`.

**Commit.** `web-acp: M6 phase Z — /extension add via npm`.

---

## Exit phase — milestone closeout

- `m6-extensions.md` rewritten to reflect what shipped (phases listed
  with their actual sub-numbers, sub-titles, exit gates).
- `index.md` board updated; milestone moved from "planned" to "shipped"
  with a short digest summary.
- `deferred.md` — UI-bound coding-agent surface (`pi.registerShortcut`,
  `pi.registerFlag`, `pi.registerMessageRenderer`, `ctx.ui.*`, custom
  tool rendering, `pi-tui` integration) explicitly carved out with
  one-line rationales referring back to this milestone.
- `007-<next>.md` skeleton drafted (likely M7 templates + skills,
  since M6 already wired the discovery + tag + registry layer skills
  will build on).
- Exit-audit greps: no `ctx.ui.` import path under
  `packages/web-acp-agent/`, no `node:` or `@zenfs/dom` import under
  `packages/web-acp-agent/src/agent/extensions/`,
  `extensions.spec.ts` referenced by `playwright.config.ts` (or auto-
  discovered).

**Commit.** `web-acp: M6 exit gate`.
