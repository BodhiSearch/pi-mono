# Post-M5 cleanup (2026-04-20)

**Status:** ✅ done (`af2b7086`).

Not a new milestone — a grouped cleanup commit landing before M6 opens. Driver: pre-extraction hygiene audit (`../plans/we-want-to-create-luminous-book.md`).

What changed:

- **Dead-code removal.** Deleted `src/web-agent/core/extensions/registry.ts` (M8 stub, never instantiated). Dropped the Extension-related type re-exports from the public `index.ts` barrel; `core/extensions/types.ts` stays as forward-compat scaffolding. Narrowed `core/tools/index.ts` barrel (`truncateHead` / `formatSize` / `DEFAULT_MAX_*` / `TruncationResult` no longer re-exported — read.ts imports directly). Removed the legacy `SessionManager.flush()` no-op + its test.
- **Import hygiene.** `VaultProvider` + `WebAgentProvider` switched from sub-path (`@/web-agent/fs/zenfs-provider`, `@/web-agent/worker/boot`) to barrel (`@/web-agent`) imports. Principle #3 now has no sub-path consumers.
- **Configurability.** Introduced `WebAgentOptions` (`worker/init-protocol.ts`) carrying `vaultMount` + `sessionsDbName`. Threaded through `getAgentWorker({ agentOptions })` → `createWorkerTransportPair` → Worker init envelope → `agent-worker.ts` → `new WorkerAgentHost(..., { vaultMount })` + `new DexieSessionStore(new WebAgentDB(sessionsDbName))`. `WorkerAgentHost` stores `this.vaultMount` and uses it everywhere `VAULT_MOUNT` was referenced directly. `SessionManager.create` now requires explicit `cwd`; `DEFAULT_CWD` removed. `SENTINEL_API_KEY` renamed to `API_KEY_PRESENCE_PLACEHOLDER` with a comment explaining why the OpenAI provider layer needs it (real auth is Bearer-header based; the placeholder satisfies pi-ai's precondition check).
- **Test coverage gaps closed.** +24 new unit tests across 4 previously-uncovered modules: `core/agent-session.test.ts` (9), `core/tools/ls.test.ts` (7), `fs/zenfs-operations.test.ts` (10), `fs/zenfs-provider.test.ts` (5). 156 unit tests total (was 132).
- **Docs.** D16 (options) + D17 (extensions de-exported) appended to `../decisions/post-m5-cleanup.md`. Library-grade vs app-grade dep classification table added to `../02-architecture.md#Phase-6 extraction shape`. `../plans/we-want-to-create-luminous-book.md` is the full planning record.

Surprises worth remembering:

- **Removing `SENTINEL_API_KEY` outright broke chat.** The OpenAI-family providers in `pi-ai` require `getApiKey()` to return *something* before the HTTP request is built, even though the real auth is via `Authorization: Bearer` headers patched in by `makeStreamFn`. The agent-loop chain looks like `(getApiKey(provider) ?? config.apiKey)` — if both are undefined, provider setup fails silently and the assistant reply is empty. Keep the placeholder; just name it honestly.
- **Dexie compound-index secondary sort is the entry id, not the timestamp.** Already documented in the M5 post-script but resurfaced here — when adding a test that writes many entries in rapid succession, the monotonic timestamp bump in `DexieSessionStore._writeEntry` is what preserves chronological order on read.
- **Sub-path import cleanup is cheap — just do it.** `VaultProvider` and `WebAgentProvider` had been reaching into `@/web-agent/fs/*` and `@/web-agent/worker/*` for single symbols each. Both symbols were already re-exported from the barrel; the fix was a one-line import edit per file. Not worth deferring.
