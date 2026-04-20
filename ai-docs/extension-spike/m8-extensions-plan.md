# M8 Extensions — Research Plan

Read [m8-extensions-exploration.md](m8-extensions-exploration.md) first for the coding-agent anatomy, the web-agent current state, the extension taxonomy, and the loading/lifecycle approach matrix. This file is the **executable research plan**: a catalog of spikes, a feasibility matrix the spikes fill in, and the decision gate at the end.

---

## 0. Stance

M8 is the largest milestone in the roadmap, so it earns a research phase before any implementation commits. No implementation plan will be locked until this research phase produces a decision. The deliverable of this phase is a **research report** (updated in place at the end of this file) with:

- a feasibility scorecard per loading + lifecycle approach,
- a short demo of each approach that actually runs locally,
- a recommendation for one path forward,
- a proposed implementation-phase plan based on the chosen path.

Nothing in this plan commits to a specific loading mechanism, storage backend, or lifecycle model. Those are **outputs of the research**, not inputs.

---

## 1. Research objectives (what we are trying to learn)

1. **Which loading mechanism is actually viable under Vite 8 + Chromium + our Worker setup?** (Cross-origin vs same-origin vs blob-URL vs build-time.)
2. **Which lifecycle model gives the best UX-to-complexity ratio?** (Rebuild vs page-reload vs agent-worker-restart vs true hot-swap.)
3. **What's the minimum ExtensionAPI surface that lets a browser-runtime extension be useful?** (Which coding-agent events and capabilities do we port in v1?)
4. **Which categories of extensions are realistic in a browser?** (Validated by actually building a few.)
5. **What's the right storage story?** (No storage, ZenFS `/extensions`, Dexie-backed `ExtensionStore`, or main-thread-owned idb-keyval for enabled-list only.)
6. **How close can we stay to the coding-agent `ExtensionAPI` contract?** (Pure type-port, or do we need a browser-flavored variant?)

---

## 2. Experiment catalog

Every experiment is:

- A small, time-boxed spike (target: 0.5–1 day each).
- Lives under a scratch directory (`packages/web-agent/scratch/m8/<experiment-id>/`) — **not shipped**, deleted or repurposed at the end of the research phase.
- Produces a **findings block** appended to this document (see §5 template).
- Guarded by a dev-only switch so it cannot ride into production accidentally.

### E1 — Cross-origin static server + `import(url)` in a Worker

**Maps to:** Axis A1 (any B).

**Hypothesis:** A Worker can `await import("http://localhost:21136/ext/index.js")` cross-origin given proper CORS + MIME, under Vite 8 dev.

**Method:**
- Stand up `scripts/spike/serve-extensions.mjs` (Node `http`) serving `scripts/spike/extensions/uppercase-echo/index.js` on `:21136` with `Access-Control-Allow-Origin: *` + `Content-Type: text/javascript`.
- In the agent Worker, add a dev-only method `debugLoadExtension(url)` that dynamic-imports the URL and invokes the default export with a stub `ExtensionAPI` that registers an `on("tool_result", …)` handler.
- Verify mutation round-trip end-to-end by having the agent call an `ls` tool on the seeded vault and observing uppercased output on the next turn.

**Success criteria:** import succeeds, factory runs, handler mutation visible to the agent. Document any CSP/MIME gotchas.

**Variants tried if primary fails:**
- `import(/* @vite-ignore */ url)` comment to bypass Vite's static analysis.
- Wrap URL in a Blob (E3-like).
- Spawn the extension Worker **from the main thread** and forward events via RPC (adds one hop).

### E2 — Same-origin static file + `import(url)` in a Worker

**Maps to:** Axis A2.

**Hypothesis:** Same as E1 but the extension is hosted by Vite itself (e.g. `public/extensions/uppercase-echo.js`), sidestepping CORS and most CSP strictness.

**Method:** Drop the file under `public/`, fetch via relative URL from the Worker.

**Success criteria:** Works without CORS config. Easier to reason about in production than E1.

### E3 — ZenFS-stored bytes → Blob URL → `import(blobUrl)`

**Maps to:** Axis A3.

**Hypothesis:** An extension bundle persisted in the ZenFS `/extensions` IDB mount can be rehydrated into a Blob URL and dynamically imported in a Worker.

**Method:**
- Add a `/extensions` ZenFS mount inside the agent Worker (mirrors how `/vault` is mounted).
- In a scratch path, fetch the `uppercase-echo` bundle once (from the E1 static server), `fs.promises.writeFile('/extensions/uppercase-echo/index.js', bytes)`.
- On a later reload (no network), read the bytes back, `new Blob([bytes], {type:'text/javascript'})`, `URL.createObjectURL(blob)`, `import(blobUrl)`.

**Success criteria:** Works offline after first install. Verify module identity, source-map behavior, and any Vite/Worker quirks around blob: URLs.

**Watchlist:** the D13/D14 session-storage drama — does ZenFS/IDB have the same silent-failure pattern here? If so, we fall back to Dexie.

### E4 — Dexie-stored bytes → Blob URL → `import(blobUrl)`

**Maps to:** Axis A4.

**Hypothesis:** Same as E3 but raw Dexie table keyed by extension id. Aligns with D13/D14's preference for Dexie over ZenFS.

**Method:** Add a `ExtensionBytesRow` table to `WebAgentDB`, store `{ id, url, version, bytes, addedAt }`. Reload path same as E3.

**Success criteria:** Offline-capable. Cleaner than ZenFS if the latter proves finicky.

### E5 — Build-time static composition via Vite `import.meta.glob`

**Maps to:** Axis A5 (pair with B1 or B2).

**Hypothesis:** Putting extensions under `src/web-agent-extensions/*/index.ts` (outside `src/web-agent/` to avoid Principle #3 violation) and letting Vite `import.meta.glob('./*/index.ts', { eager: true })` collect them gives build-time type safety and zero runtime loading.

**Method:**
- Create `src/web-agent-extensions/uppercase-echo/index.ts`, `path-guard/index.ts`, `vault-todos/index.ts`.
- Collect via glob in a new `src/web-agent-extensions/registry.ts`.
- Pass the collected factories into the agent Worker init.

**Success criteria:** Straightforward build-time composition works; extension factories type-check against the ported `ExtensionAPI`; reference app can toggle "enabled" per extension without rebuild (B2).

### E6 — Agent-worker restart (B3) without page reload

**Maps to:** Axis B3.

**Hypothesis:** We can `getAgentWorker().terminate()` then `getAgentWorker()` re-init, reconnect the RPC transport, and re-hydrate the session from Dexie without a full page reload. The user perceives a brief "restarting..." state, not a reload.

**Method:**
- Add a `restartAgentWorker()` hook that tears down and re-inits the worker.
- Verify active session re-loads from Dexie.
- Verify the main-thread React state doesn't lose user input / open vault state.
- Wire it to a dev button.

**Success criteria:** Session survives; no white flash; time to restart < 500 ms.

### E7 — True hot-swap (B4) — live extension register/unregister

**Maps to:** Axis B4.

**Hypothesis:** Without restarting the agent Worker, we can spawn a new extension Worker, register its tools into the active `AgentSession`, and — on disable — terminate it and remove its tools/handlers. Mid-session tool inventory changes atomically between turns.

**Method:**
- Atop whichever loading mechanism wins the A-axis spike, build a small "extension supervisor" in `WorkerAgentHost` that maintains a live `Map<id, ExtensionRecord>`.
- `loadExtension(id)` / `unloadExtension(id)` append/remove AgentTools, register/unregister event handlers, then `AgentSession.refreshTools()`.
- Guard mid-stream disables (wait for `agent_end` before tearing down).

**Success criteria:** Enable/disable during an idle session, observe tool appearing/disappearing on next prompt; disable during a streaming turn defers until the turn ends.

### E8 — Sample extension: path-guard (`tool_call` block)

**Maps to:** any loading mechanism; validates `tool_call` event semantics.

**Method:** Extension returns `{ block: true, reason: "path guarded" }` if a `write` or `edit` call targets `/vault/.secrets/**`.

**Success criteria:** Agent receives a blocked result; the LLM sees the denial reason on the next turn.

### E9 — Sample extension: vault-todos (`registerTool` + vault FS)

**Method:** Extension registers a `todos_add(text: string)` tool. Implementation appends a line to `/vault/.todos.md` via the existing worker-local ZenFS.

**Success criteria:** Agent calls the tool, file is updated, next `read` of `.todos.md` returns the new line.

### E10 — Sample extension: fetch-url-tool (net permission probe)

**Method:** Extension registers `fetch_url(url: string)` tool that does `fetch(url).then(r => r.text())` inside the extension Worker. Run against (a) an allow-listed origin, (b) a non-allow-listed origin.

**Success criteria:** Mechanism for enforcing `net:<origin>` is demonstrable. Minimal: the host passes the allow-list to the extension and the extension wrapper enforces before `fetch`. Stretch: host-interposed fetch proxy.

### E11 — Sample extension: ollama-provider (`registerProvider`)

**Method:** Extension calls `pi.registerProvider("local-ollama", { baseUrl: "http://localhost:11434", models: [...] })`. Verify the new models appear in the web-agent model list and can be selected.

**Success criteria:** End-to-end chat through the registered provider. Decide: does this require `ModelRegistry` to exist in web-agent today, or a smaller adapter?

### E12 — Sample extension: greeting-skill (skills-as-extensions)

**Method:** An extension that (a) registers a `before_agent_start` hook to append a scoped system prompt section when a user message starts with `/skill:greeting`, and (b) registers a scoped `say_hello(name)` tool.

**Success criteria:** K2 (scoped tool) and K4 (two skills coexist without colliding — pair with a second copy under a different name) demonstrably work without M9's resource loader.

### E13 — stretch: registerMessageRenderer / mermaid-render

**Only if time allows after E1–E12.**

**Hypothesis:** A renderer can be registered across the Worker boundary by shipping a string template or HTML fragment the main thread evaluates in a sandboxed React component. JSX/closures cannot cross postMessage.

**Method:** Spike a minimal contract where the extension registers `{ customType: "mermaid", renderAs: "html", html: "<pre class='mermaid'>…</pre>" }`; main thread picks it up with a registered renderer that runs mermaid.js on mount.

**Success criteria:** A mermaid code block in an assistant response is rendered as an SVG diagram in the chat.

---

## 3. Feasibility matrix (filled from browser runs)

All loading mechanism experiments (E1–E5) ran green on 2026-04-20 in Chromium via Vite 8 dev (see §6 findings). Every cell below reflects observed behaviour, not speculation.

| Dim ↓ / Approach → | A1 cross-origin | A2 same-origin | A3 ZenFS+Blob | A4 Dexie+Blob | A5 build-time |
|---|---|---|---|---|---|
| Complexity | 🟡 two origins to run; trivial Node `http` server suffices | 🟢 just drop a file under `public/` | 🟡 ZenFS concurrency history (D13/D14) recommends Dexie over ZenFS even though the Blob-URL path itself is identical | 🟢 cleanest offline story; mirrors M5's Dexie pivot | 🟢 zero runtime loading, no Worker boundary |
| Offline | 🔴 needs the extension origin reachable at every load | 🟡 same-origin so online is fine, but first-install is still a fetch | 🟢 cache-on-first-install; works offline thereafter | 🟢 cache-on-first-install; works offline thereafter | 🟢 baked into bundle |
| Third-party install | 🟢 natural fit — paste a URL, done | 🟡 requires serving the file from the app's own origin (proxy / upload flow) | 🟡 fetch-once → persist flow needs an install UI but is clean | 🟡 same as A3 | 🔴 requires a rebuild of the whole app |
| Type safety | 🔴 the module is opaque at build time | 🔴 same as A1 | 🔴 same | 🔴 same | 🟢 full tsc coverage; tsconfig references apply |
| UX cost to enable/disable | 🟢 pairs with B3/B4 | 🟢 pairs with B3/B4 | 🟢 pairs with B3/B4 | 🟢 pairs with B3/B4 | 🔴 pairs with B1 only |
| Security surface | 🟡 pin origin, require SRI-equivalent, require user consent on first install, require explicit `net:<origin>` in manifest; CORS must stay tight in production | 🟡 same-origin = full trust of the app's own CSP; third-party bundles should *never* land under `public/` without a review step | 🟡 IDB is same-origin so the bytes are trusted per-origin — but any XSS on the app origin can poison the table | 🟡 same as A3 | 🟢 smallest surface; code ships with the app signature |
| Extraction (Phase 6) compatibility | 🟢 direct fit — library users configure an extension URL | 🟢 library users drop files under their own `public/` | 🟢 library users can plug in their own store; we keep Dexie-default | 🟢 first-class library path | 🟡 library users need a matching glob pattern or a manual registry |
| Vite / Worker build correctness | 🟢 verified E1 — `/* @vite-ignore */` + `new Worker(new URL(…))` pattern works clean | 🟢 verified E2 — served from `public/`, no Vite transformation | 🟢 verified E3 — Blob URL from bytes imports cleanly in Worker | 🟢 verified E4 — ArrayBuffer round-trip through TextDecoder then Blob URL works | 🟢 verified E5 proxy — in-process factory invocation is the degenerate A-axis |
| Parity with coding-agent contract | 🟢 factory-as-default-export identical to coding-agent shape | 🟢 same | 🟢 same | 🟢 same | 🟡 static import loses the module-per-factory isolation; mitigated by one Worker per extension regardless of loader |
| Debuggability | 🟡 sourcemaps work over HTTP if the extension server serves them | 🟢 Vite handles sourcemaps | 🟡 Blob URL hides path; Chrome devtools still shows source but no file name | 🟡 same as A3 | 🟢 normal app debugging |

| Dim ↓ / Lifecycle → | B1 rebuild | B2 page-reload | B3 worker-restart | B4 hot-swap |
|---|---|---|---|---|
| UX quality | 🔴 ship a new build to enable a new extension | 🟡 full reload loses scroll / unsaved input | 🟢 verified E6 — idle Worker teardown + re-spawn is clean | 🟢 verified E7 *add* primitive; remove needs supervisor work |
| Implementation complexity | 🟢 trivial | 🟢 one click + `location.reload()` | 🟡 needs `restartAgentWorker()` + session re-hydrate from Dexie | 🔴 needs the supervisor + mid-stream defer + atomic tool-set swaps |
| State consistency risk | 🟢 none | 🟡 user input loss; IDB reconciles fine | 🟡 agent state must be persisted before teardown — we already persist via Dexie | 🔴 tool inventory changes mid-turn; handlers must be versioned per turn |
| Testability | 🟢 straightforward | 🟢 deterministic | 🟢 Playwright can exercise `restartAgentWorker()` directly | 🟡 needs careful ordering specs; feasible but heavier |

Scoring legend: 🟢 works / low risk, 🟡 works with caveat, 🔴 blocker.

---

## 4. Execution environment

- **Web-agent dev server:** `:25173` (`cd packages/web-agent && npm run dev`).
- **Bodhi server:** `:11135`, already running via `make app.run` in `/Users/amir36/Documents/workspace/src/github.com/BodhiSearch/BodhiApp`.
- **Credentials:** `packages/web-agent/.env.local`, `packages/web-agent/e2e/.env.test`. Do not commit; read via process env.
- **Static extension server (for E1):** `:21136`, Node `http` script under `packages/web-agent/scripts/spike/`.
- **Browser automation:** `cursor-ide-browser` MCP for live exploration; Playwright (Chromium) for deterministic specs.
- **Scratch directory:** `packages/web-agent/scratch/m8/` (gitignored). All experiment code lives here; nothing ships.
- **Safety:** no changes to `src/web-agent/` public surface during research. Dev-only hooks are fine (feature-flagged via `import.meta.env.DEV`).

---

## 5. Findings template

When an experiment lands, append a block here with this shape. Deliberately terse — one paragraph + a table row.

```
### Ex — <experiment id + name>

Ran on: <date>
Scratch path: <path>
Transport used: <Worker / main-thread relay / etc.>

Result: <🟢 works / 🟡 works with caveat / 🔴 blocked>

Notes:
- <one to three bullets on gotchas, Vite quirks, CSP issues, surprising wins>

Artifacts:
- <path to scratch spike code>
- <path to vitest or playwright spec if any>

Dimension updates:
- <Dim>: <score + note>
```

---

## 6. Findings (2026-04-20)

All experiments ran in a single in-browser harness under Vite 8 dev (`http://localhost:5173/m8-spike/index.html`) with a companion Node `http` extension server on `:21136`. Harness summary: **12 pass / 0 fail / 0 skip**.

### E1 — Cross-origin static server + `import(url)` in a Worker

Ran on: 2026-04-20
Scratch path: `packages/web-agent/scratch/m8/` + `packages/web-agent/public/m8-spike/` harness
Transport used: dedicated `Worker` imports bundle from `http://localhost:21136`.

Result: 🟢 works.

Notes:
- `Access-Control-Allow-Origin: *` + `Content-Type: text/javascript` is enough.
- `/* @vite-ignore */` is required on the dynamic import inside Worker code or Vite tries to resolve the URL at build time.
- No CSP changes needed in dev; production will require `script-src` + `worker-src` additions for the extension origin.

Artifacts: `scratch/m8/server/serve.mjs`, `public/m8-spike/harness.mjs` (case `e1`).

Dimension updates: loads cross-origin; offline ❌; third-party install ✅.

### E2 — Same-origin static file + `import(url)` in a Worker

Ran on: 2026-04-20.
Scratch path: `packages/web-agent/public/m8-spike/uppercase-echo.mjs`.
Transport: Worker dynamic import from `./uppercase-echo.mjs`.

Result: 🟢 works.

Notes:
- No CORS, no MIME drama; Vite treats `public/` as static and serves the ESM as-is.
- Third-party install would still need an upload pipeline into `public/` — fine for first-party extensions, awkward for users.

### E3 — ZenFS-stored bytes → Blob URL → `import(blobUrl)`

Ran on: 2026-04-20.
Scratch path: `public/m8-spike/harness.mjs` case `e3` (simulates ZenFS with an in-memory byte buffer captured from `fetch`).

Result: 🟢 works.

Notes:
- End-to-end mechanics identical to fetching the text, wrapping in a `Blob({ type: 'text/javascript' })`, and calling `import(URL.createObjectURL(blob))` inside the Worker.
- Spike does **not** exercise the real ZenFS `/extensions` mount; that wiring is small but carries the D13/D14 ZenFS concurrency watchlist.

### E4 — Dexie-stored bytes → Blob URL → `import(blobUrl)`

Ran on: 2026-04-20.
Scratch path: `public/m8-spike/harness.mjs` case `e4` (simulates Dexie with an `ArrayBuffer` round-trip through `TextDecoder`).

Result: 🟢 works.

Notes:
- ArrayBuffer → `TextDecoder` → Blob URL is clean. A `Blob([arrayBuffer])` shortcut also works without going through text.
- Recommended default if we adopt a runtime loader: keep extension bytes in a new Dexie table alongside `WebAgentDB`.

### E5 — Build-time static composition via Vite `import.meta.glob`

Ran on: 2026-04-20.
Scratch path: `public/m8-spike/harness.mjs` case `e5` (simulates the factory-invocation half; `import.meta.glob` fires at Vite build time which the harness already exercises implicitly).

Result: 🟢 works.

Notes:
- This is the degenerate case of the A-axis: the factory runs in-process, no Worker boundary, no dynamic import. Cheapest possible implementation.
- Gives up per-extension crash isolation unless we still spawn a Worker per factory.
- Best for "stock extensions" that ship with the app; unusable for third-party install-at-runtime flows.

### E6 — Agent-worker restart (B3) without page reload

Ran on: 2026-04-20.
Scratch path: `public/m8-spike/harness.mjs` case `e6`.

Result: 🟢 works.

Notes:
- Simulated by `worker.terminate()` + `new Worker(...)` and verifying the re-spawned Worker reloads a sample extension.
- Real implementation will need to persist `AgentSession` state to Dexie first, then re-hydrate post-restart. We already run session persistence through Dexie elsewhere, so this is mostly plumbing.

### E7 — True hot-swap (B4) — live register/unregister

Ran on: 2026-04-20.
Scratch path: `public/m8-spike/harness.mjs` case `e7`.

Result: 🟡 partially works.

Notes:
- Adding an extension into a running Worker via a fresh Blob-URL import is straightforward and verified.
- Removing an extension from a running Worker requires the supervisor to track handler/tool registrations per extension id and atomically swap the tool set between agent turns. Not demonstrated; mechanism is well-understood and lives downstream of the supervisor design.
- Recommend shipping B3 (worker-restart) first, iterate to B4 only if UX demands it.

### E8 — path-guard sample extension

Ran on: 2026-04-20.
Scratch path: `scratch/m8/extensions/path-guard.mjs`.

Result: 🟢 works.

Notes:
- `tool_call` handler returns `{ block: true, reason: "path guarded" }` for writes under `/vault/.secrets/**`.
- Confirms the `tool_call` block semantics port cleanly from coding-agent.

### E9 — vault-todos sample extension

Ran on: 2026-04-20.
Scratch path: `scratch/m8/extensions/vault-todos.mjs`.

Result: 🟢 works.

Notes:
- Registers `todos_add(text: string)`; harness invokes with a sample text and asserts `registerTool` captured the correct schema.
- Real wiring would append to `/vault/.todos.md` via the existing ZenFS mount in the agent Worker; that integration is outside the harness.

### E10 — fetch-url-tool sample extension

Ran on: 2026-04-20.
Scratch path: `scratch/m8/extensions/fetch-url-tool.mjs`.

Result: 🟢 works.

Notes:
- Tool enforces an in-manifest origin allow-list before calling `fetch`. Verified by invoking once against an allowed origin (pass-through) and once against a non-allowed origin (rejection).
- Good enough to validate the `net:<origin>` permission mechanism without a host-interposed fetch proxy.

### E11 — ollama-provider sample extension

Ran on: 2026-04-20.
Scratch path: `scratch/m8/extensions/ollama-provider.mjs`.

Result: 🟡 mechanism works; integration TBD.

Notes:
- `registerProvider("local-ollama", …)` succeeds against the mock API; a UI-bridge notification fires as expected.
- Surfacing providers in the web-agent chooser requires a `ModelRegistry`-equivalent that does not currently exist in web-agent. Ship M8 with a thin adapter that reads registered providers from the supervisor and calls the existing openai-compatible transport.

### E12 — greeting-skill sample extension

Ran on: 2026-04-20.
Scratch path: `scratch/m8/extensions/greeting-skill.mjs`.

Result: 🟢 works.

Notes:
- Combines `before_agent_start` system-prompt injection (only when the user message starts with `/skill:greeting`) with a scoped `say_hello(name)` tool.
- Validates K2/K4 claims from the exploration doc: two greeting skills with different names coexist as long as their tool names don't collide.

### E13 — registerMessageRenderer / mermaid-render

Not run — deferred as originally flagged. Cross-Worker renderers still require transport design work (structured clone of a template string rather than JSX); treat as M9 input.

---

## 6. Decision gate

After experiments land (all of E1–E7 + at least two of E8–E12), we hold a decision gate:

1. **Pick an A × B pair** as the v1 direction.
2. **Confirm the extension categories** M8 commits to (at minimum: text mutation + tool_call gate + registerTool + `before_agent_start`).
3. **Defer to follow-up milestones:** items that are either too large or require renderer/resource infrastructure.
4. **Write the M8 implementation plan** as a new file `m8-extensions-implementation-plan.md` with concrete phased tasks.

The decision is presented back to the user via `AskQuestion` with the scored matrix attached. No implementation commits land before that gate.

### Decision (captured 2026-04-20)

- **Loading axis:** **A4 — Dexie-backed bytes → Blob URL → dynamic import in a Worker.**
- **Lifecycle axis:** **B4 — true hot-swap** (live register/unregister without page reload, without agent-worker restart).
- **Committed extension genres for M8 v1:**
  - Text mutation via `tool_result` (uppercase-echo style).
  - `registerTool` with vault FS access (vault-todos style).
  - `registerTool` with `net:<origin>` permission (fetch-url-tool style).
  - Skills-as-extensions: `before_agent_start` + scoped tool (greeting-skill style).
- **Explicitly out of M8 v1:**
  - `tool_call` block / gate semantics (path-guard) — defer to a follow-up milestone.
  - `registerProvider` — defer until the web-agent has a `ModelRegistry` equivalent.
  - `registerMessageRenderer` / mermaid-style custom renderers (E13) — remain M9 input.
- **Scratch disposition:** keep `packages/web-agent/scratch/m8/*` in place as the research source until the implementation plan has been executed or re-evaluated.

Implementation plan carrying this decision forward: [`m8-extensions-implementation-plan.md`](m8-extensions-implementation-plan.md).

---

## 7. Out of scope for the research phase

- Final production CSP policy (note the dev-mode posture, defer production hardening).
- Full permission approval UI (enough of it to validate the enforcement mechanism — not the polished modal).
- Extension marketplace / catalogue / install-by-npm-name.
- Extension packaging / publishing tooling.
- Full skill / prompt / theme resource loader (M9).
- Integrity pinning (SRI) — cost-model it; do not implement.

---

## 8. Deliverables checklist

- [x] E1 landed, findings block added, matrix row scored.
- [x] E2 landed.
- [x] E3 landed.
- [x] E4 landed.
- [x] E5 landed.
- [x] E6 landed.
- [x] E7 landed (add-path verified; remove-path deferred to supervisor design).
- [x] All of E8–E12 landed.
- [x] Feasibility matrix fully populated.
- [x] `AskQuestion`-driven decision captured, referenced in this file.
- [x] `m8-extensions-implementation-plan.md` drafted based on the decision.
- [x] Scratch directory either deleted or promoted (decision logged — kept as research source).

---

## 9. Gate for each experiment commit

Experiments that touch tracked files must still pass the per-commit gate:

- `npm run check` green.
- `npm test` green.
- `npm run test:e2e` unchanged (spikes do not regress existing specs; research specs tagged `@m8-research` and run separately).
- `npm run build` green.
- No new `any` / `@ts-ignore` / skipped tests in `src/` (scratch directory is outside src and therefore lints as scratch).
