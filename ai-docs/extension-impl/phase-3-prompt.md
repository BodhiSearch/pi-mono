# M8 — Extensions — Phase 3 handoff prompt

Use this as the starting prompt for the Phase 3 implementation plan.

---

## Context

Phases 1 + 2 landed a full-surface extension runtime loaded inline inside the agent Worker. Extensions run with the same privilege level as the Worker itself: one infinite loop from a misbehaving extension hangs the agent. The Phase 3 deliverable is to harden that model.

Read before planning:

- [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md).
- [`./phase-1-report.md`](./phase-1-report.md) and `./phase-2-report.md` (when it lands).
- `packages/web-agent/src/sandbox/` — the iframe + Worker skill sandbox. It is the reference implementation for Phase 3's isolation story.
- [`../specs/worker-agent/skills.md`](../specs/worker-agent/skills.md) — same sandbox pattern documented.

## Goals

1. **Iframe isolation.** Run each extension in a `sandbox="allow-scripts"` iframe with a per-run Worker inside. Same-origin access, cookies, `localStorage`, and credential headers are stripped. This is the same pattern the skill runtime already ships.
2. **Custom message renderers.** Let extensions register React-free HTML renderers for specific tool-result or message kinds. These render in a sandboxed iframe inline in the transcript.
3. **TypeScript sources.** Accept `index.ts` alongside `index.js`. Transpile in-Worker with `esbuild-wasm`; cache the compiled output in IDB keyed by content hash.
4. **Marketplace + signing.** Ship a signing scheme for extensions (ed25519 per-extension key; public keys pinned in the vault manifest) and a fetch-from-URL install flow. Out-of-vault extensions must be signed; vault-local extensions can remain unsigned for local development.

## Scope

### Per-extension iframe sandbox

- Architectural split: the main Worker owns a **router** that knows about all loaded extensions, their iframes, and their message channels. Each extension's iframe holds one Worker per hook invocation (spawned fresh on `before_agent_start`, terminated on completion), mirroring the skill sandbox's "fresh Worker per run" rule.
- Hook dispatch becomes asynchronous: `emitBeforeAgentStart` now `postMessage`s into the iframe and awaits a response. Timeout is enforced (default 5s; per-extension override via manifest). Timed-out calls emit an `extension_error` and return `undefined` (no override).
- Tool invocations cross the same boundary. Tool latency budget allows up to 30s (same as the sandbox's skill budget).
- Capability API inside the iframe: a curated subset of `pi.*` plus a minimal Web API (fetch with credential-header stripping, console, `performance.now`, `TextEncoder`).
- UI requests still round-trip via the main Worker's router, which marshals them into existing `extension_ui_request` RPC. Correlation IDs gain an `extensionPath` field so the router can route responses back to the correct iframe.

### Custom message renderers

- New API: `pi.registerRenderer({ match, render })` where `match` is a predicate over `{ messageType, toolName?, entry }` and `render` is a string-returning function (HTML-as-string). The renderer runs inside the extension iframe; its output is embedded in the transcript's `TransientBubble` via a sandboxed `<iframe sandbox="allow-scripts">` with the returned HTML as `srcdoc`.
- Rationale: keeps React out of the extension surface, preserves clone safety, and enables Mermaid / chart / preview extensions without a plugin host.

### TypeScript sources

- Loader accepts `index.ts` as a fallback when `index.js` is absent. On load, the worker transpiles with `esbuild-wasm` (browser build, bundled as a Worker asset), hashes the source, and caches the JS output under `${extensionPath}:${hash}` in IDB.
- Cache invalidation is automatic — any source change produces a new hash.
- Cold-load cost budget: 500 ms for the first TS extension in a session; subsequent cache hits should be ~10 ms.

### Marketplace + signing

- Manifest extension: `signature?: string`, `publicKeyId?: string`.
- Host-level trust store: `packages/web-agent/src/extension-store/TrustedKeys.ts` — `idb-keyval` map of `publicKeyId → publicKeyPem`.
- Install-from-URL flow: user pastes a URL, the host fetches the bundle, verifies the signature, and copies the files into `<vault>/.pi/extensions/<name>/`. Rejection reasons surface via `ExtensionStore.installError`.
- Signing tool: a CLI under `packages/web-agent/scripts/sign-extension.ts` that produces the signature for a given folder.
- No backend registry in Phase 3 — users paste URLs or `git clone`. Backend/marketplace is a separate effort.

## Constraints

- **No cryptographic dependencies in the Worker.** Use `SubtleCrypto.verify` with ed25519 (available in modern browsers); sign with Node's `crypto` in the CLI.
- **Backwards compatibility.** Phase 1 + Phase 2 extensions must continue to work unchanged. The iframe path is per-extension opt-out only for debugging; production forces it.
- **Test parity.** The inline-worker path stays alive as a `--dev` flag for HMR-friendly extension development, but the e2e spec must verify the sandboxed path is what production ships.

## Open questions

1. **Synchronous hook cost.** Every `before_agent_start` call now does a Worker → iframe → Worker round-trip plus the handler execution. For a single extension this is ~5 ms; for 10 extensions it's 50 ms per turn. Acceptable?
2. **Widget host.** Widgets registered via Phase 2's `pi.ui.setWidget` currently render React components on the main thread. Phase 3's renderer API is HTML-as-string in an iframe. Do we keep both, or collapse to one?
3. **Provider registration across the iframe boundary.** `pi.registerProvider` needs the provider's `streamFn`, which must run in the main Worker. Does the iframe provide a `streamFn` stub that proxies into the main Worker?
4. **Trust bootstrap.** How does a user add a new `publicKeyId` to the trust store? Manual paste? QR scan? First-time prompt on install?
5. **Bundle format.** Single-file bundled JS + manifest, or a tarball with assets? Affects the install-from-URL UX.

## Deliverables

1. Iframe + Worker-per-run sandbox module (`src/extension-sandbox/`), structured like `src/sandbox/` but parameterised for extensions rather than skills.
2. Router integration in `worker-agent/worker/worker-host.ts` (iframe creation, message routing, timeout enforcement).
3. TS transpilation path in `core/extensions/loader.ts` (opt-in via manifest flag initially; default on in the next minor).
4. Signing verification in `core/extensions/loader.ts` + trust store + install-from-URL flow on the main thread.
5. CLI signing tool.
6. Full spec update, including a new `extension-isolation.md` (peer to `extensions.md`) for the isolation model, and updates to `divergence.md` explaining why this matches the skill sandbox pattern.
7. `./phase-3-report.md` with decisions, gaps, and the marketplace handoff.

## Gate

- Every Phase 1 + Phase 2 e2e spec still passes under the sandboxed path.
- A new `extensions-isolation.spec.ts` proves:
  - An extension with an infinite loop is timeout-killed without hanging the agent.
  - An unsigned extension fetched from a URL is rejected.
  - A signed extension with a rotated-out public key is rejected.
- `npm run check` is clean.
- `npx vitest run` in `packages/web-agent/` is clean.
- `npm run test:e2e` in `packages/web-agent/` is green in **two back-to-back runs**. The known `compaction.spec.ts` flake is tracked separately; any other failure blocks the phase.

## Wrap-up checklist (mandatory at Phase 3 close)

1. **Add / update e2e coverage.** New specs: `e2e/extensions-isolation.spec.ts` for timeout-kill + signing, plus updates to the existing extension specs so they also run under the sandboxed path. Every assertion must be against infrastructure (DOM state, RPC-visible error payloads, signature-verification result) — not LLM output.
2. **Run the full e2e suite twice from `packages/web-agent/`.** Both runs must be green (excluding the pre-existing `compaction.spec.ts` flake). Record the last-run summary in the phase-3 report.
3. **Run `npm run check` at repo root and `npx vitest run` inside `packages/web-agent/`.** Both must be clean.
4. **Update `ai-docs`.** Add `specs/worker-agent/extension-isolation.md`, refresh `specs/worker-agent/extensions.md` with the "signed, sandboxed" reality, touch all three `coding-vs-web-agent/*.md` alignment docs and `milestones/m8-extensions.md`.
5. **Author `phase-3-report.md`** covering the marketplace + signing state of the world and the next milestone's handoff (e.g. discovery / registry backend).

## Learnings to carry forward from Phases 1 + 2

Phase 1 paid for the e2e-stability rules below; Phase 2 should have cemented them. Phase 3 must not walk them back:

- **Never assert on small-model textual output.** Assert on tool-call arguments, tool-call results rendered in `tool-call-content`, RPC events, and `data-test-state`. Phase 1's `extensions.spec.ts` and the revised `skills.spec.ts` are the reference.
- **Use `.last()` / explicit `.nth(N)` when a step adds a new instance of a widget that appeared in an earlier step.** Strict-mode violations on `toBeVisible()` were a top failure cause in Phase 1.
- **Never wrap an LLM-dependent flow in assertion-level retries.** Re-prompt once if an infrastructure witness (file on disk, runtime-error bubble, RPC event) fails to show up, then stop. Phase 1's vault-writer step codifies this.
- **Raise the test timeout explicitly for specs with >3 LLM turns.** The default 30 s is tight once a test chains auth + vault-mount + multiple tool-calling turns.
- **Mirror worker state onto `data-test-state`, never optimistic UI.** Phase 1 extensions panel rebuilds `rowState` from the worker's authoritative `ext.loaded` / `ext.error`. Phase 3's signing UI should do the same: the row's `data-test-state` reflects the *verified* state, not the pre-verification hint.
- **Every new RPC command gets unit coverage in both `rpc-client.ts` and `rpc-server.ts` tests before the UI wiring.** Shape regressions are cheap to catch there and expensive to catch in e2e.
- **One owner per piece of state (cleanup-pass lesson from Phase 1).** Phase 1 ended up with duplicated enable-state between runner and host; that was simplified to a single controller + a `pendingFlush` boolean before the commit landed. For Phase 3, sandbox state (per-iframe lifecycle, per-message-renderer output caches, trust-store entries) must have one owner at each layer — do not let the iframe router and the renderer host both track "which extension is alive right now."
- **Consume the command response; don't follow up with a list-* RPC.** Phase 1 fixed this for `setExtensionStates`. Phase 3 should make `installExtension` / `verifySignature` return the post-install descriptor directly — no separate `list_extensions` round-trip.
- **Pre-seed via init, not via a follow-up push.** The persisted enabled map now travels through the worker init message. Phase 3's trust store (`publicKeyId` → `publicKeyPem`) should do the same so the first signature verification doesn't have to wait for a main-thread push.
- **Reconcile maps that can grow.** Phase 1's enable-state map grew monotonically across mount cycles until the cleanup pass added `reconcileEnabledState`. Phase 3's trust store and renderer cache need the same discipline — prune entries whose owning extension is no longer on disk.
- **Extract when a host file crosses ~800 lines.** Phase 1's `WorkerAgentHost` was extracted into `ExtensionHostController` once it grew past 900 lines with extensions threaded throughout. Phase 3 adds iframe orchestration, TS transpilation, and signature verification — put each behind its own controller from day one, not after the host balloons.
