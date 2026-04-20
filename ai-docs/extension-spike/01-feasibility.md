# 01 — Feasibility Research (Unbiased)

**Purpose.** Map the full option space for "extensions in a browser web-agent" before committing to any one approach. The M8 research plan narrowed this space prematurely (two pre-chosen axes, both biased toward a Worker + IndexedDB outcome). This report re-opens the space so the next iteration can choose with clear eyes.

**Scope frame.** The web-agent is an in-browser chat + tool-use harness running on top of `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core`. It runs entirely client-side (React UI on the main thread, agent loop inside a dedicated Web Worker, vault on ZenFS with the WebAccess backend, MCP servers called over postMessage upcalls). Extensions must (a) extend this system's behaviour dynamically, (b) be installable / uninstallable at runtime, (c) survive reloads, (d) not compromise the main app's security or stability.

---

## 1. What "extension" actually means — four intents, often conflated

Before evaluating mechanisms, the *intent* needs disambiguation. Real requests hide under a single word. Most design debates are really intent debates.

| Intent | Example | Who supplies the code |
|---|---|---|
| **Built-in plugin** | ship an "uppercase" behaviour, toggleable in settings, no install UI | us |
| **First-party bundled extension** | ship a curated library of extensions inside the app; users can enable / disable / configure | us |
| **User-authored extension** | user writes a small script and installs it locally | the user |
| **Third-party / marketplace extension** | arbitrary author publishes; arbitrary user installs | anyone |

These have very different security, distribution, storage, and trust requirements. The M8 spike tried to satisfy *all four* with one mechanism (per-Worker sandbox + Dexie-backed bundle store). That mechanism is over-engineered for (1) and (2), and under-engineered for (4). Before the next iteration, the user must commit to *which intent is in scope*. See [`06-open-questions.md`](06-open-questions.md) Q1.

---

## 2. The design space on four independent axes

These axes are orthogonal. Any feasible solution is a tuple across all four; picking one axis first (like M8 did with "loading mechanism") silently narrows the other three.

### Axis I — Execution context (where extension code runs)

- **A. Inline in main thread.** Cheapest. DOM access, direct React integration, trivial IPC. No isolation. One bad extension crashes the whole app. Acceptable only for trusted first-party code.
- **B. Inline in agent Worker.** Crashes contained to the Worker; agent harness restarts. Still shared memory with other extensions and with the agent loop. No DOM. Can call `AgentSession` APIs directly.
- **C. One Worker per extension (nested Worker).** Crashes isolated per extension. No DOM. Each extension has its own module graph; no accidental shared globals. Higher overhead (one Worker per extension), more RPC plumbing. Nested Worker support requires Chrome/Firefox/Safari ≥ recent versions; historically flaky under dev tooling (e.g. Vite).
- **D. iFrame sandbox.** Strongest origin-level isolation; extension code cannot touch `window` of the parent. DOM is available but scoped. `postMessage`-only IPC. Heavier to boot than a Worker but the right tool for UI-rendering extensions (charts, custom views, mermaid, etc).
- **E. WebAssembly module.** Language-agnostic (Rust, AssemblyScript), deterministic sandbox, no DOM, no direct fetch. Harder to write extensions in; largely irrelevant unless we want language portability.
- **F. Server-side execution.** Extensions run on a backend we control; browser just calls them. Gives unlimited execution power but negates the "local web-agent" positioning and moves trust elsewhere.

The spike picked C. Nothing else was seriously prototyped.

### Axis II — Code distribution (where the bundle comes from)

- **1. Baked into the app build.** Extensions are modules in `src/…/extensions/builtin/*`. `import.meta.glob` or a static manifest imports them at build time. Zero runtime loader. Toggle = "set enabled flag". Cannot add extensions without a new build.
- **2. Fetched at runtime from the same origin.** Static assets under `/extensions/<id>/index.js`. The browser's normal module loader handles them. No IndexedDB / no blob URL. Requires every install to ship a file to the origin — i.e. no user-uploaded code unless we route uploads through the origin.
- **3. Fetched at runtime from a cross-origin URL.** Fragile. CORS, CSP `script-src`, SRI integrity pinning, revocation — all become our problem. Offline-hostile. Useful only for a trust-by-signature marketplace.
- **4. User-uploaded, stored locally, rehydrated via blob URL + dynamic import.** Bytes sit in IndexedDB (or ZenFS IDB backend, or OPFS). On boot, we create a `Blob` and `URL.createObjectURL()`, then `import(blobUrl)`. Supports fully-local authoring. Has the entire distributed-loading problem internalised.
- **5. Declarative (no code at all).** Extensions are JSON + schema. "Path guard" is a JSON filter, not a function. "Prefix tool results" is a string template. Massively reduces the surface; expressive enough for ~60% of real extensions; compiles to something native without an executor. Trades off power for safety + simplicity.
- **6. Hybrid.** Declarative surface for the common case, code escape hatch for the rest.

The spike picked 4. Option 5 (declarative) was never explored. Option 1 (built-in only) was explicitly rejected at the decision gate even though it covers every M8 committed genre.

### Axis III — Trust & permissions

- **α. No permission model.** Extension gets the same authority as the agent harness. Fine for (1) and (2) in §1; unacceptable for (3) and (4).
- **β. Manifest-declared static permissions.** Extension declares `{fs:vault, net:<origin>}`; runtime enforces. No per-call prompting. Cheap to implement; coarse; trust-on-first-install UX.
- **γ. Per-call prompts (à la browser geolocation).** Each first call triggers a dialog. Rich UX; slow; interrupts agent loops.
- **δ. Capability-based (pass restricted handles).** Extension only gets the objects we hand it. No globals (shadowed). No default network. No default storage. Very powerful, matches the object-capability model used by SES / hardened JS.
- **ε. Origin-isolated (iframe).** Leverage the browser's origin boundary: extension's iframe is a different origin, gets no cookies / no IndexedDB / no fetch to our origin unless explicitly bridged.

The spike implemented β partially (only `net:<origin>` via `self.fetch` shadowing). `fs:vault` was declared but never enforced. `fs:self` was declared but never implemented.

### Axis IV — Lifecycle UX (how install / enable / disable / upgrade behaves)

- **i. Rebuild required.** Any change = new build. Only viable for intent (1).
- **ii. Page reload on any toggle.** Toggle enables → reload. Simple; safe; annoying.
- **iii. Agent Worker restart, no page reload.** Toggle tears down and re-boots the Worker. Active agent turn is lost. Main-thread UI stays.
- **iv. True hot-swap, no restart.** Extension spins up / tears down without touching the agent Worker. Mid-stream toggles must be handled explicitly (defer to next turn is the cleanest rule).
- **v. Hot-reload for authors.** A developer-only feature: write to source, file watcher rebuilds, extension transparently reloads. Orthogonal to i–iv.

The spike picked iv for the intent, partially implemented it (hot-swap exists but has bugs — see [`04-gap-analysis.md`](04-gap-analysis.md) §2 — and in practice requires a page reload more often than claimed).

---

## 3. Feasibility summary matrix

Cells mark the feasibility of each Axis I × Axis II combination for **each of the four intents** in §1.

| Exec \ Dist | 1 Built-in | 2 Same-origin | 3 Cross-origin | 4 Local IDB + blob | 5 Declarative |
|---|---|---|---|---|---|
| A Main | ✅ (1,2) | ⚠️ (1,2) — security loose | ❌ too risky | ❌ untrusted code on main thread | ✅ (1,2,3,4) |
| B Agent Worker | ✅ (1,2) | ✅ (1,2) | ⚠️ (2) | ⚠️ (3) — shared memory risk | ✅ (1,2,3,4) |
| C Nested Worker | ✅ (1,2,3) | ✅ (1,2,3) | ✅ (3,4) signed | ✅ (3,4) | — overkill |
| D iframe | — | ✅ (1,2,3) | ✅ (3,4) | ⚠️ needs srcdoc trick | — overkill |
| E Wasm | — | ✅ language-portable | ✅ language-portable | ⚠️ auth tooling needed | — orthogonal |

Legend: ✅ viable, ⚠️ viable with caveats, ❌ rejected, — not meaningful.

**Observations the spike skipped.**

- The declarative column (5) is viable across almost every execution context and removes the entire sandboxing debate for the genres it covers. We never built a declarative prototype.
- The iframe column (D) is the right answer for renderer extensions (M9 message renderers, charts, custom widgets). The spike deferred this; the next iteration may be forced to revisit it.
- The built-in column (1) covers every M8 committed genre today and would have taken ~1 day, not ~10. See [`03-unbiased-approach.md`](03-unbiased-approach.md).

---

## 4. Storage options for persisted bundles (only relevant if Dist=4)

- **IndexedDB (raw).** Standard, transactional, cross-tab-safe. What Dexie wraps. What the spike chose.
- **IndexedDB (via Dexie).** Tiny wrapper, query-building syntactic sugar. Adds 8 KB to bundle; no functional difference vs raw IDB for our needs.
- **IndexedDB (via ZenFS IDB backend).** Pretends to be POSIX. Pays double indirection for no win when the data is just "here is a bundle ID and its bytes". ZenFS shines for `/vault/**` because extensions / tools want file-ish semantics; bundle storage has no such need.
- **OPFS.** Fast, but cross-tab unsafe (principle 2). Ruled out.
- **LocalStorage.** Size-capped, synchronous, not for binary. Ruled out.
- **Cache API.** Designed for HTTP responses. Works. No query layer; no transactions. Awkward for manifest + flag dual-write.

If the next iteration decides Dist=4, IndexedDB (raw or Dexie) is the right choice. The spike's D20 decision stands on this point.

---

## 5. Loader mechanics (only relevant if Dist=2/3/4)

Two proven approaches:

1. **`Blob` → `URL.createObjectURL` → dynamic `import(url)`.** Works in Workers with `type: 'module'`. Bundle must be self-contained ESM (no bare-specifier imports, because there's no module resolver). Vite needs `/* @vite-ignore */` on the dynamic import. Revokes cleanly via `URL.revokeObjectURL`.
2. **Import-map + fetch.** Register a mapping, let the browser's loader resolve bare specifiers. More powerful but more plumbing; not needed for self-contained bundles.

`eval` / `new Function` do not support ESM syntax and are CSP-hostile. Ruled out.

For iframe sandboxing (Exec=D), the same loader applies but the blob URL is a same-origin `null`-origin page inside the iframe.

---

## 6. Event / API surface — how big should it be?

`packages/coding-agent/src/core/extensions/types.ts` defines **22 event types** and a wide `ExtensionAPI` (tool registration, command registration, provider registration, renderer registration, message synthesis, shortcut/flag registration, UI widget injection, event bus, model control, cwd access, shell exec, etc).

The spike ported **3 events** (`before_agent_start`, `tool_result`, and the implicit on-load `registerTool` call). That is nowhere near the surface area the coding-agent targets, but it is enough to demonstrate the three most common extension genres.

The question the next iteration must answer: **what is the smallest event surface that still hits our K1–K4 goals?** The `coding-agent` surface is TUI-heavy; copying it wholesale bakes in complexity we do not yet need. See [`06-open-questions.md`](06-open-questions.md) Q3.

---

## 7. Precedent — how other browser-embedded tools do this

- **VSCode Web.** Extensions run in an extension host Worker. API is large, stable, versioned. Declarative contributions via `package.json` + imperative via an activate function. Their distribution is a signed marketplace with review. Not something we can copy at our scale.
- **Obsidian (desktop Electron, browser-free).** Extensions are plain JS modules loaded from disk into the main renderer. Trust model = "user trusts what they install". Good UX; no sandbox. We can't replicate because Electron's node integration is the entire sandbox-bypass that makes it work.
- **Chrome extensions.** Manifest V3 runs extension service workers with strict permission prompts at install time. Very tight sandbox, declarative where possible. Their whole install-time UX is the precedent for how permissions should be surfaced — we should copy that pattern even if our runtime differs.
- **Storybook.** Addons are bundled at build time and registered via a global addon API. Zero runtime distribution. That's option I.A + II.1 — trivial to implement, not user-extensible.
- **Excalidraw / TLDraw.** Plugin APIs are compile-time only. Reinforces that many teams skip runtime loading entirely.
- **Figma plugins.** Run in a sandboxed iframe (Exec=D) with a restricted API. Distribution is a server-hosted manifest + JS fetched on load. The sandboxing approach maps closely to our best-fit for third-party code.

Takeaway: **the most successful browser-extension systems pick one intent and commit.** VSCode is for intent (4), Storybook is for intent (1), Figma is for intent (4) with iframe sandboxing. None of them try to be all four with one mechanism.

---

## 8. What's genuinely hard in a browser (risks we underestimated)

- **Nested Worker support in dev tooling.** Vite 5's dev server does not always handle `new Worker(new URL(...), { type: 'module' })` when the caller is itself inside a Worker. Works in production (bundled) but dev can silently fail. This is likely the root cause of the "needs reload" symptom; see [`04-gap-analysis.md`](04-gap-analysis.md) §2.
- **Dynamic `import()` inside a Worker with Vite.** The `/* @vite-ignore */` comment is mandatory. Missed once = a perfectly silent failure at runtime.
- **Debugger story.** Breakpoints in a blob-URL module are possible but cursed. Source maps across the import boundary are broken in every browser. Author UX for a user-written extension is poor without a local source-mapped authoring mode.
- **Async `import` cancellation.** There is no way to cancel a dynamic import. A malicious / large bundle can tie up the Worker's event loop until resolved.
- **CSP + SRI interplay.** If we ever want Dist=3 (remote fetch), CSP `script-src 'self'` must be relaxed to allow blob URLs — which weakens the whole policy. There is no middle ground.
- **Cross-tab consistency.** Enabling an extension in one tab is invisible in another tab until that tab reloads. IndexedDB notifications do not fire across tabs. We would need a `BroadcastChannel` on top.

---

## 9. Viable approaches, ranked for our constraints

Given the web-agent context (local-first, IDB storage, Worker-based agent, no backend), the ranked viable designs are:

1. **Built-in registry (Exec=B inline, Dist=1, Trust=α, Lifecycle=ii/iii).** Extensions are modules committed to the repo. User toggles enabled flags. One day of work. Covers every M8 committed genre. The baseline against which anything more complex must justify itself.
2. **Built-in + declarative (Exec=B, Dist=1+5, Trust=α, Lifecycle=ii).** Adds a JSON-schema-defined extension format for the common cases. Authors stay inside guardrails. Still ~2–3 days.
3. **Same-origin static + built-in (Exec=B or C, Dist=1+2, Trust=β, Lifecycle=iii).** Add a `public/extensions/<id>/` drop-in folder for power users. Extensions ship self-contained ESM. Reload to pick up new ones. ~1 week.
4. **Nested Worker + IDB (Dist=4, Trust=β, Lifecycle=iv).** The spike's choice. Full user-authored runtime, local-only, hot-swappable. ~2–3 weeks to do properly with all edges closed (permissions actually enforced, pending-state UX, cross-tab sync, debugger story). The spike did it in ~1 week but left many edges open.
5. **iframe sandbox + IDB (Exec=D, Dist=4, Trust=ε, Lifecycle=iv).** Required if we ever want renderer extensions or third-party untrusted authors. More plumbing than Worker-based (postMessage every call), but the only correct answer for UI-rendering extensions.

Anything beyond (5) — cross-origin distribution, signed marketplace, Wasm — is not "extensions for our local web-agent"; it's a product of its own.

---

## 10. What we'd need to commit to before choosing

A defensible extension design requires answering, in order:

1. Which of the four intents in §1 are in scope for v1?
2. Is user-authored code in scope, or only first-party code?
3. Is DOM-rendering an extension genre in scope?
4. What's the smallest event surface that covers our target genres?
5. What's the trust model when a user toggles an extension? Trust-on-install? Trust-per-call? No trust (declarative only)?
6. Cross-tab behaviour: must extensions appear consistently across tabs, or is per-tab fine?

The M8 research gate short-circuited most of these by pre-selecting axes. The next iteration should not.
