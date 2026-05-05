# M11 — Polish + npm publish

**Status:** planned. Final roadmap milestone. Replaces the
original M8 ("polish + extract") now that the extraction itself
shipped as part of M5 (see
[`m5-extraction-and-compliance.md`](m5-extraction-and-compliance.md)
§ 1). What remains is the publish step + the polish work the
original M8 scoped.

**Host scope.** Agent-primary for the publish; browser-host
primary for diagnostics / HTML export / host-runtime library
extraction. Browser host addendum inline under § "Browser host
addendum".

## What this milestone delivers

Four threads that together make the codebase a shippable library
+ a user-polished reference app:

- **`@bodhiapp/web-acp-agent` npm publish.** The package has
  been lib-shaped since M5 (zero browser-only deps, clean
  `startAgent({ transport, provider, ... })` entry,
  pluggable interfaces). What's missing is the publish metadata
  (version, README, CHANGELOG, peerDependency reclassification,
  semver stance).
- **Browser-host runtime library extraction.** If the browser
  host's `runtime/{storage-dexie,transport,volumes-fsa}/` +
  `acp/` + select hooks are useful as a second library for
  third parties building their own browser host, extract them
  as `@bodhiapp/web-acp-browser-host` (working name; settled at
  M11 kickoff). Otherwise keep `packages/web-acp/` as a
  reference app only.
- **Diagnostics + structured logging.** A debug panel or
  console view showing ACP message traces with timing. Toggle
  via URL param so prod doesn't expose internals.
- **HTML export.** A session can be exported to a self-contained
  HTML file that a user can share.

## Depends on

- **M1–M10** at minimum — the extractable surface must be
  stable.
- **M5** — agent-package extraction already done. M11's
  publish step inherits that work.
- **All deferred items re-entered or documented as post-v1.**
  The compliance-at-a-glance table has no `deferred` rows
  when M11 ships.

## Sub-milestones

### M11.1 — `@bodhiapp/web-acp-agent` npm publish

Deliverables:

- Flip `packages/web-acp-agent/package.json:"private"` from
  `true` to `false`. Assign an initial semver `0.1.0` and
  document the semver stance ("0.x minors are breaking;
  patches are additive; 1.x starts when extension API + wire
  surface + config-option IDs are all stable").
- Add a published `README.md` describing the public surface
  (already staged at the package root); link to the spec at
  [`../specs/web-acp-agent/index.md`](../specs/web-acp-agent/index.md).
- Add `CHANGELOG.md` at the package root seeded with
  `## [0.1.0] — Initial publish` listing the M5-digest
  threads + M6..M10 features.
- Peer-dep reclassification: move `@agentclientprotocol/sdk`,
  `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`,
  `@modelcontextprotocol/sdk`, `@zenfs/core`, `just-bash`,
  `@sinclair/typebox`, `zod` from `dependencies` to
  `peerDependencies` (+ `peerDependenciesMeta.optional` where
  a consumer might bring their own). Internal monorepo
  workspace consumers resolve via the workspace protocol;
  external consumers resolve via npm.
- `files: ["dist"]` in `package.json` (not `src`, which ships
  typed-but-unbuilt source). Add a `prepublishOnly` step that
  runs `npm run build`, `npm test`, and fails the publish if
  either step regresses. `npm run build` becomes a real script
  on the agent package (currently the agent package types
  through `tsc -b` without a build; the publish needs a `dist`
  output).
- GitHub Actions workflow: `release.yml` that publishes on a
  tagged commit matching `web-acp-agent@*`. Keep manual
  `npm publish` as a fallback.

Gate items:

- `npm pack` from the agent package root produces a tarball
  containing `dist/` + `README.md` + `CHANGELOG.md`. No
  `src/` files leak.
- `npm publish --dry-run` surface-audit: the listed files
  match the intended surface.
- A fresh external consumer test: clone a minimal Vite + React
  sample outside the monorepo; install the tarball;
  `startAgent({...})`; assert basic round-trip. Automated as
  a prepublish gate if budget allows; manual recipe in the
  README otherwise.

### M11.2 — Browser-host runtime library extraction (conditional)

**Decision at kickoff.** Extract only if there's a concrete
third-party consumer or a clear pattern of other-host code
(CLI, future mobile) reusing the browser-host adapters. If the
extraction is speculative ("someone might want this") keep the
host-runtime code in `packages/web-acp/` as a reference
extraction point and skip this sub-milestone.

If extracting:

- New package `packages/web-acp-browser-host/` containing
  `runtime/{storage-dexie,transport,volumes-fsa}/`,
  `acp/{client,runtime,streaming-reducer,panels-reducer,
  builtin-dispatch,empty-sentinels,message-shape,
  session-meta,feature-keys,index}.ts`, + select hooks
  useful as a composable toolkit (the `useAcp*` slice hooks
  as optional helpers; consumers bring their own React
  integration).
- `packages/web-acp/` becomes a thin reference app importing
  both `@bodhiapp/web-acp-agent` and
  `@bodhiapp/web-acp-browser-host`. The `App.tsx` /
  `components/` tree stays in the reference repo.
- Semver alignment: browser-host library is `0.x` with the
  same minor bump policy as the agent package.

### M11.3 — Diagnostics + structured logs

Deliverables:

- Debug panel in the browser host (gated by
  `VITE_WEB_ACP_DEBUG=1` or `?debug=1` URL param) showing:
  - Live ACP message trace (request / response / notification)
    with timing + direction.
  - Active session state snapshot
    (`AcpSessionRuntime.getSession(id)` + stored row).
  - Active extensions + tool registry.
  - MCP pool state (active clients, tool counts).
- Structured logs from the agent side ride an
  out-of-band log channel on the transport adapter (not ACP
  messages — logging via ACP would pollute the wire). The
  worker-stream adapter adds a sibling `log` channel; hosts
  wire it into `console` or a panel.
  - Reject using `_bodhi/log` extension method for this.
    Logs are a transport concern, not a protocol concern
    (principle § 6 — when sub-protocols make sense, use
    them).

Gate items:

- URL-param toggle hides the panel in prod (`?debug=1`
  removed → panel gone from the DOM).
- Diagnostic panel renders a full turn's trace with sub-ms
  timing.
- Grep gate: no `_bodhi/log` extension method in the agent
  package source.

### M11.4 — HTML export

Deliverables:

- "Export to HTML" button on each session in the picker.
  Produces a self-contained HTML file with:
  - The full transcript (messages, tool calls, built-in
    replies, compaction summaries).
  - Inline CSS so styling survives.
  - No JS (static render — users can read it in any browser
    offline).
- Reuses the browser host's `MessageBubble` layout via a
  server-rendering path (React DOM server rendering inside
  the browser, not a separate Node pipeline).

Gate items:

- A 50-turn session exports to a single HTML file < 500 KB
  (excluding any embedded tool-call blobs).
- The exported HTML renders correctly in Firefox, Safari,
  Chrome without JS.
- Sensitive-state gate: the exported HTML contains no
  bearer tokens, no auth URLs, no OAuth redirect URIs. Manual
  grep + automated assertion in the e2e suite.

### M11.5 — Compliance table closeout + remote-agent documentation

Deliverables:

- Every row in the compliance-at-a-glance table in
  [`index.md`](index.md) reads `compliant`. The two
  historical `divergent (documented)` rows (filesystem +
  fork's unstable adoption) retain short footnotes.
- A new doc `ai-docs/web-acp/remote-agent.md` documents the
  remote-agent deployment story (vault options, auth story,
  transport options). The doc is not a milestone
  commitment — it is the decision log that unblocks any
  future remote-agent milestone without re-deriving the
  constraints.

## Browser host addendum (`packages/web-acp/`)

Most of M11 is browser-host work by definition (diagnostics,
export, runtime extraction). Covered in the sub-milestones
above.

**Hard host rule.** No host-side code imports extraction-target
names that have not yet been exported. If M11.2 ships the
browser-host runtime library, every host file flips to import
from `@bodhiapp/web-acp-browser-host` in the same commit that
publishes the library. Transient state (one commit imports the
old local paths, next commit flips them) is not allowed.

## Out of scope

- **Telemetry / analytics reporting home.** Logs are local.
- **Automatic update mechanism for installed extensions.**
  Manual re-download + `_bodhi/extensions/reload`.
- **Breaking-change migration tooling.** The library is
  pre-v1; consumers pin exact versions until we declare
  stability.
- **Public documentation site.** README + inline JSDoc +
  spec docs in the repo.
- **Multi-agent dashboards.** One agent per tab.

## Why this ordering (M11 is last)

Extraction is the **last** milestone because every prior
milestone's public surface becomes API by being published. If
we publish early, every subsequent milestone churns the public
API. Publishing at the end makes the surface a snapshot, not a
moving target.

Diagnostics / logging / export are grouped with the publish
because they are what separates "works for us" from "useful to
a third party." Shipping the library without them means every
consumer writes the same debugging harness from scratch.

The original M8 framing called out a possible split
(polish-vs-extract). With extraction already done, the split
simplifies: M11 is "publish + polish" as one milestone, sized
such that the ship / not-ship decision per sub-milestone is
independent. If any one of M11.2 / M11.3 / M11.4 slips, it
becomes a follow-up; M11.1 (publish) is the only must-ship slice
that completes the roadmap.

## Cross-references

- M5 digest that already did the extraction:
  [`m5-extraction-and-compliance.md`](m5-extraction-and-compliance.md).
- Agent-package public surface (living spec):
  [`../specs/web-acp-agent/index.md`](../specs/web-acp-agent/index.md).
- Browser-host public surface (living spec):
  [`../specs/web-acp-client/index.md`](../specs/web-acp-client/index.md).
- Principle § 6 (ACP extensibility before sub-protocols),
  § 9 (pluggable interfaces):
  [`../steering/04-principles.md`](../steering/04-principles.md).
