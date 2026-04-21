# Post-M5 cleanup decisions

Date: 2026-04-20

## D16. `vaultMount` + `sessionsDbName` are constructor options; defaults live on the library

**Decision:** `WorkerAgentHost` takes an options object carrying a `vaultMount?: string` field; `DexieSessionStore` already took an optional DB name, and `agent-worker.ts` now forwards both through the `AgentWorkerInit` envelope. Main-side `getAgentWorker(options)` accepts `{ devSeed?, agentOptions? }` where `agentOptions` is the shared `WebAgentOptions` type (`vaultMount`, `sessionsDbName`). Default values (`/vault`, `web-agent`) live inside the library, not at call sites.

**Why.**

- The library is meant to extract cleanly in Phase 6. Compile-time constants for the vault mount path and DB name couple every consumer to our single-app defaults — a second embed (e.g. two isolated agent instances on one page, or a consumer that needs a namespaced `/myapp-vault` mount) has no seam.
- Constructor-injection is already the shape the rest of the library uses (`WorkerAgentHost(session, vfsPort, store, options)`, `DexieSessionStore(db)`). One more options struct fits; no new idiom.
- `SessionManager.create` tightened from `cwd?: string` (defaulting silently to `/vault`) to `cwd: string` required. Missing cwd is caller error — the Worker host passes `this.vaultMount` explicitly, tests pass `'/vault'` explicitly. No silent fallback that drifts from the options struct.

**Alternatives rejected:**

- *Environment-variable-based configuration.* Doesn't cross the Worker boundary cleanly; every field would need plumbing through the init envelope anyway.
- *Static class-level setters.* Globals; break the second-consumer case immediately.

## D17. Extension scaffolding de-exported; M8 reintroduces

**Decision:** `src/worker-agent/core/extensions/registry.ts` is deleted. The M8 event / tool / manifest *types* in `types.ts` stay as forward-compat scaffolding but are no longer re-exported from `index.ts`. M8 lands the real registry and re-exposes whatever shape it finalises at that time.

**Why.**

- The registry class was a Phase-1 stub — in-memory Map, never instantiated, never driven by any code path. Exporting it implied a stable API that didn't exist; removing it narrows the public surface to things consumers can actually use today.
- Keeping `types.ts` preserves the coding-agent-compatible shape M8 will need, but confines it to internal reference until wired.
- If M8 changes the extension manifest or event contract, there's no need to maintain backwards compatibility with the stub.

**Alternatives rejected:**

- *Delete `types.ts` too.* Forces M8 to re-derive the extension contract from scratch; marginal win on LOC, real cost on context.
- *Mark the registry `@internal`.* Exports with `@internal` JSDoc still ship in the public API barrel and tend to be rediscovered by downstream consumers.
