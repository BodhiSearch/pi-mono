# Finish the web-acp-agent extraction: deduplicate the engine layer

## Context

Post-M4 phase B, the agent runtime was extracted to a new workspace
package `@bodhiapp/web-acp-agent` (commit `096e87a4`, 2026-05-01).
The intent (per `ai-docs/web-acp/specs/web-acp/index.md`) was that
`packages/web-acp/` would become a thin **browser host** —
keeping React, the Dexie store implementations under
`runtime/storage-dexie/`, the FSA volume backends under
`runtime/volumes-fsa/`, the `MessagePort` byte-stream bridge,
the host-side ACP wire/engine split, and a small `agent-worker.ts`
shim that wires everything to `startAcpAgent(...)` from the
agent package.

The extraction commit shipped the agent package (with the
engine layer, providers, MCP, tools, system prompt, and the
store interfaces all exported from `src/index.ts`), and pre-
created the migrated host-side homes at
`packages/web-acp/src/runtime/{storage-dexie,volumes-fsa,
transport}/`. **But the wiring was never flipped.** The
extraction commit explicitly said *"agent-worker.ts still
imports from the legacy in-package paths… a future PR can
flip the worker over without further interface churn."* That
PR never landed.

The result today: ~1500+ LoC of dead duplication across
`packages/web-acp/src/{acp/engine, acp/agent-adapter, agent/,
features/, mcp/}` ↔ `packages/web-acp-agent/src/`. The
sibling host `packages/cli-acp-client/` already imports
correctly from the agent package and acts as the canonical
"how it should look" reference.

This plan completes the flip: remove the duplicated engine /
provider / store-interface code from `packages/web-acp/`,
import everything from `@bodhiapp/web-acp-agent`, and
finalise the move to `runtime/{storage-dexie,volumes-fsa}/`.

## Scope

- `packages/web-acp/` — primary surface of the change (delete
  duplicates, switch imports, declare workspace dep).
- `packages/web-acp-agent/` — touched only if a missing export
  surfaces during the migration (none currently expected; the
  barrel at `packages/web-acp-agent/src/index.ts` already
  re-exports every type web-acp consumes).
- `packages/cli-acp-client/` — **not touched**. Already
  imports correctly from the agent package.

## Current-state inventory (concrete)

### A. Engine layer — duplicated, delete from web-acp

Identical-or-near-identical to the agent package's copies.
Sole consumer in web-acp is `agent-worker.ts` (which should
switch to `startAcpAgent` from the agent package).

```
packages/web-acp/src/acp/engine/
├── services.ts                  # AcpAdapterServices, AssembleServicesOptions, StreamOverridesRef, assembleServices
├── types.ts                     # SessionState, ExtMethodHost
├── session-runtime.ts           # AcpSessionRuntime (~395 lines)
├── prompt-driver.ts             # PromptTurnDriver (~363 lines)
├── builtin-dispatch.ts          # tryHandleBuiltin
└── ext-methods/                 # 10 files (list-models, list-sessions, volumes-list, features-list/set, get-session, mcp-toggles-set, sessions-delete, index)

packages/web-acp/src/acp/
├── agent-adapter.ts             # AcpAgentAdapter (wire shim, ~245 LoC)
└── agent-adapter.test.ts        # tests against the local copy
```

### B. Agent runtime — duplicated, delete from web-acp

```
packages/web-acp/src/agent/
├── bodhi-provider.ts            # 256 LoC; agent's: 238 (semantic diff is minor)
├── inline-agent.ts              # 64/64 — identical
├── stream-fn.ts                 # 52/49 — near-identical
├── system-prompt.ts             # 22/22 — identical
├── system-prompt.test.ts        # duplicates agent's same-named test
├── commands/                    # vault commands + builtins; duplicated under agent/commands/
├── mcp/                         # worker-side MCP runtime; duplicated under agent's mcp/
└── tools/                       # bash tool + filesystem adapter; duplicated under agent's tools/
```

### C. Stores — interface duplicated; Dexie impl already migrated

The Dexie implementations were pre-migrated to
`runtime/storage-dexie/` on the same day as the extraction
but no consumer was rewired. The legacy files are still in
place AND export the *interface* (which the agent package
also defines).

| Legacy (delete) | Migrated home (already exists) | Agent's interface |
| --- | --- | --- |
| `web-acp/src/agent/session-store.ts` (+ test) | `runtime/storage-dexie/session-store.ts` (+ test) | `web-acp-agent/src/storage/session-store.ts` |
| `web-acp/src/features/feature-store.ts` (+ test) | `runtime/storage-dexie/feature-store.ts` (+ test) | `web-acp-agent/src/storage/feature-store.ts` |
| `web-acp/src/mcp/toggle-store.ts` (+ test) | `runtime/storage-dexie/mcp-toggle-store.ts` (+ test) | `web-acp-agent/src/storage/mcp-toggle-store.ts` |

The agent's barrel re-exports the interfaces already (verified
at `packages/web-acp-agent/src/index.ts` lines 12–18, 113–134).
The Dexie helpers in the runtime/storage-dexie/ versions
already import the interfaces from the agent package.

### D. Volumes — host-specific concrete, not duplicated

`web-acp/src/agent/volume-mount.ts` (153 LoC) + `volume-channel.ts`
(105 LoC) are FSA-specific and have no agent-package counterpart
(the agent ships `volume-registry.ts` as the abstract interface).
Migrated home is `web-acp/src/runtime/volumes-fsa/` (already
populated). Move + rewire, do not delete.

### E. Files that stay in web-acp (host-side ACP wire/engine split)

These are the host-side counterparts the spec calls out — keep
as-is, just switch internal imports to the agent package where
they currently reach into local engine copies:

```
packages/web-acp/src/acp/
├── client.ts, runtime.ts, streaming-reducer.ts (+ test)
├── builtin-dispatch.ts             # host-side builtin action dispatch (NOT the agent's engine builtin)
├── permissions.ts, fs-handlers.ts (+ tests)
├── message-shape.ts, session-meta.ts, wire-utils.ts
├── methods.ts, index.ts
```

## Target state

- `packages/web-acp/package.json` declares
  `"@bodhiapp/web-acp-agent": "*"` in `dependencies` (currently
  works via implicit workspace resolution; declare it explicitly
  so the import is contractual, not coincidental).
- `packages/web-acp/src/agent/agent-worker.ts` is a thin shim
  that:
  1. Constructs the `BodhiProvider` (imported from
     `@bodhiapp/web-acp-agent`).
  2. Opens the Dexie DB (`@/runtime/storage-dexie/db`) and
     constructs the three Dexie stores (also from
     `runtime/storage-dexie/`).
  3. Constructs the FSA-backed `VolumeRegistry` impl from
     `@/runtime/volumes-fsa/`.
  4. Calls `startAcpAgent(transport, services, opts)` from
     `@bodhiapp/web-acp-agent` (matching the cli-acp-client
     pattern in `packages/cli-acp-client/src/acp/embedded-host.ts`).
- The directories `packages/web-acp/src/acp/engine/`,
  `packages/web-acp/src/agent/{bodhi-provider,inline-agent,
  stream-fn,system-prompt,system-prompt.test,commands,mcp,
  tools}.{ts,/}`, `packages/web-acp/src/acp/agent-adapter.ts`
  + test, and the legacy store paths (`agent/session-store.ts`,
  `features/feature-store.ts`, `mcp/toggle-store.ts` plus
  their tests) are deleted.
- Volumes consolidated under `packages/web-acp/src/runtime/volumes-fsa/`
  (move `volume-mount.ts` + `volume-channel.ts` + test in).
- `packages/web-acp/src/{features,mcp}/` retain only the
  host-specific bits (e.g. `mcp/McpPanel.tsx`,
  `mcp/compose-mcp-servers.ts`, `mcp/useMcpInstances.ts`,
  `mcp/types.ts`, `mcp/url-canonical.ts`, `mcp/requested-mcps-store.ts`).
  `features/` becomes empty and is deleted.

## Cleanup steps

Each step is independently checkable (tsc + tests) so the
diff can be reviewed phase by phase.

### Step 1 — declare the dependency

- `packages/web-acp/package.json`: add
  `"@bodhiapp/web-acp-agent": "*"` to `dependencies`.
  Run `npm install` to refresh the workspace lockfile.

### Step 2 — switch host consumers from local interfaces to agent exports

Update every import in `packages/web-acp/src/` (excluding the
files about to be deleted) that currently reaches into the
duplicated engine / provider / store interfaces. Concrete
hits identified by grep:

| File | Current import | Switch to |
| --- | --- | --- |
| `acp/wire-utils.ts:8` | `type McpToggleSnapshot from '@/mcp/toggle-store'` | `from '@bodhiapp/web-acp-agent'` |
| `mcp/compose-mcp-servers.ts` (if it imports the toggle types) | `@/mcp/toggle-store` | agent package |
| Any host hook under `hooks/useAcp*.ts` referencing `BodhiModelDescriptor`, `FeatureSnapshot`, `McpToggleSnapshot`, `SessionStore`, etc. | local | agent package |

After this step the legacy interface files have no consumers
outside their own directory.

### Step 3 — finish the storage-dexie migration

- `packages/web-acp/src/runtime/storage-dexie/index.ts` already
  exists (301 B). Confirm it exports `createStoreFromDb`,
  `openSessionDb`, `createFeatureStore`, `createMcpToggleStore`
  + helper types (`FeatureSnapshot`, etc. — re-exported from
  the agent package barrel).
- Make `runtime/storage-dexie/feature-store.ts` re-export
  `FEATURE_DEFAULTS` and `isFeatureKey` (currently consumed by
  `acp/engine/ext-methods/features-set.ts` and `features-list.ts`
  — those files are about to be deleted, but if any host-side
  caller exists, it goes through this re-export).
- Delete `packages/web-acp/src/agent/session-store.ts` + test.
- Delete `packages/web-acp/src/features/` (entire directory).
- Delete `packages/web-acp/src/mcp/toggle-store.ts` + test.

### Step 4 — consolidate volumes under runtime/volumes-fsa/

- Move `packages/web-acp/src/agent/volume-mount.ts` →
  `packages/web-acp/src/runtime/volumes-fsa/volume-mount.ts`
  (or merge if an equivalent already exists in that dir).
- Move `volume-channel.ts` and `volume-mount.test.ts` similarly.
- Update the FSA-backed `VolumeRegistry` to implement the
  agent's `VolumeRegistry` interface (`@bodhiapp/web-acp-agent`).
- Update any consumer (`agent-worker.ts`, `hooks/useVolumes.ts`,
  components/volumes) imports.

### Step 5 — delete the duplicated engine + provider runtime

- Delete `packages/web-acp/src/acp/engine/` (entire directory).
- Delete `packages/web-acp/src/acp/agent-adapter.ts` and
  `agent-adapter.test.ts`.
- Delete `packages/web-acp/src/agent/bodhi-provider.ts`,
  `inline-agent.ts`, `stream-fn.ts`, `system-prompt.ts`,
  `system-prompt.test.ts`, `commands/`, `mcp/`, `tools/`.
- Delete the host-side reference to `pi-tui` if it was only
  used by deleted files (check `package.json`).

After this step `packages/web-acp/src/agent/` contains only
`agent-worker.ts` (the boot shim).

### Step 6 — rewrite agent-worker.ts to use startAcpAgent

Reference: `packages/cli-acp-client/src/acp/embedded-host.ts`
(canonical example; see also `packages/cli-acp-client/src/services/assemble.ts`).

Pseudocode for the new shim:

```ts
import { startAcpAgent, BodhiProvider, assembleServices } from '@bodhiapp/web-acp-agent';
import { createMessagePortStream } from '@/runtime/transport/worker-stream';
import { openSessionDb, createStoreFromDb, createFeatureStore, createMcpToggleStore } from '@/runtime/storage-dexie';
import { createFsaVolumeRegistry } from '@/runtime/volumes-fsa';

self.addEventListener('message', async (ev: MessageEvent) => {
  if (ev.data?.type !== 'init') return;
  const { agentPort, volumes } = ev.data as AgentWorkerInitMessage;
  const transport = createMessagePortStream(agentPort);
  const db = await openSessionDb();
  const services = assembleServices({
    provider: new BodhiProvider(/*…*/),
    sessionStore: createStoreFromDb(db),
    featureStore: createFeatureStore(db),
    mcpToggleStore: createMcpToggleStore(db),
    volumeRegistry: createFsaVolumeRegistry(volumes),
  });
  await startAcpAgent(transport, services);
});
```

The exact constructor shape comes from
`packages/web-acp-agent/src/bootstrap.ts` and
`packages/web-acp-agent/src/acp/engine/services.ts`. The
`BodhiProvider` constructor parameters today live in
`packages/web-acp/src/agent/bodhi-provider.ts`; carry them
across (the agent package's `BodhiProvider` constructor takes
the same shape per the verified diff).

### Step 7 — clean up tests

- Tests under `runtime/storage-dexie/{session,feature,mcp-toggle}-store.test.ts`
  are the canonical Dexie tests post-cleanup. Verify they
  cover what the deleted legacy tests covered; port any
  unique cases.
- `runtime/storage-dexie/agent-adapter.test.ts` (28 KB) is the
  migrated version of the deleted `acp/agent-adapter.test.ts`.
  Verify it still passes against the new wiring (it now
  exercises the agent package's adapter via
  `startAcpAgent` rather than constructing the adapter
  locally).

### Step 8 — verify imports converge

```bash
# every duplicated path should be gone
grep -r "from ['\"]@/acp/engine" packages/web-acp/src/   # must return zero
grep -r "from ['\"]@/agent/session-store" packages/web-acp/src/   # zero
grep -r "from ['\"]@/features/feature-store" packages/web-acp/src/   # zero
grep -r "from ['\"]@/mcp/toggle-store" packages/web-acp/src/   # zero
grep -r "from ['\"]@/agent/bodhi-provider\|@/agent/inline-agent\|@/agent/stream-fn" packages/web-acp/src/   # zero
grep -r "from ['\"]@/acp/agent-adapter" packages/web-acp/src/   # zero

# every duplicated path consumer should now route via the agent package
grep -rn "from ['\"]@bodhiapp/web-acp-agent['\"]" packages/web-acp/src/   # many hits
```

## Critical files to modify (summary)

- **Edit**: `packages/web-acp/package.json` (add dep);
  `packages/web-acp/src/agent/agent-worker.ts` (rewrite to
  `startAcpAgent`); host-side imports under `acp/wire-utils.ts`,
  `hooks/useAcp*.ts`, `mcp/compose-mcp-servers.ts`,
  `mcp/McpPanel.tsx`, `components/**`.
- **Delete**: `packages/web-acp/src/acp/engine/` (dir);
  `packages/web-acp/src/acp/agent-adapter.ts` + test;
  `packages/web-acp/src/agent/{bodhi-provider,inline-agent,stream-fn,system-prompt,session-store}.ts`,
  `system-prompt.test.ts`, `session-store.test.ts`,
  `agent/commands/`, `agent/mcp/`, `agent/tools/`;
  `packages/web-acp/src/features/` (dir);
  `packages/web-acp/src/mcp/toggle-store.ts` + test.
- **Move**: `packages/web-acp/src/agent/{volume-mount,
  volume-channel,volume-mount.test}.ts` →
  `packages/web-acp/src/runtime/volumes-fsa/`.

## Reused functions / utilities (no need to recreate)

- `assembleServices`, `startAcpAgent`, `BodhiProvider`,
  `createInlineAgent`, `createStreamFn`, `composeSystemPrompt`,
  `VolumeRegistry`, `VolumeInit`, `SessionStore`,
  `FeatureStore`, `FEATURE_DEFAULTS`, `isFeatureKey`,
  `McpToggleStore`, `McpToggleSnapshot`, `isToolEnabled`,
  `AcpAdapterServices`, `AssembleServicesOptions`,
  `StreamOverridesRef`, `SessionState`, `ExtMethodHost` —
  all re-exported from `packages/web-acp-agent/src/index.ts`
  (verified, lines 12–18, 35, 69, 103–134).
- Reference for wiring shape:
  `packages/cli-acp-client/src/acp/embedded-host.ts`
  (canonical `startAcpAgent` consumer) and
  `packages/cli-acp-client/src/services/assemble.ts`
  (services bag construction).

## Risks

- **Test parity.** Deleting `acp/agent-adapter.test.ts`
  removes ~28 KB of test code. Verify
  `runtime/storage-dexie/agent-adapter.test.ts` (also 28 KB)
  is the migrated equivalent and still passes; if a unique
  case lives only in the deleted file, port it before
  deleting.
- **`BodhiProvider` constructor drift.** web-acp's local
  copy is 18 lines longer than the agent's. Diff before
  deleting; either the agent's version is missing a needed
  case (port forward to the agent package — Step 0 if so),
  or web-acp's extra lines are stale.
- **Implicit workspace resolution today.** Without an
  explicit dep declaration in package.json, current imports
  resolve via npm workspaces. Adding the explicit dep is
  cosmetic for the runtime but makes the contract clear to
  future readers + linters. Confirm `npm run check` and
  `tsgo -p tsconfig.build.json` still pass after the
  declaration.
- **Worker bundling.** The agent package ships TypeScript
  source (`main: ./src/index.ts`); Vite picks it up via the
  workspace, but confirm the worker bundle still resolves
  ZenFS / pi-ai correctly through the new entrypoint after
  the rewrite. (cli-acp-client uses `tsx` and node native;
  the worker path is the new validation surface here.)
- **MCP and tool subdirectories.** `web-acp/src/agent/mcp/`,
  `tools/`, `commands/` are deleted — confirm there is no
  host-side React component reaching into them (grep
  before deletion).

## Verification

Run from `packages/web-acp/`:

```bash
npm run check       # biome + tsgo (project references)
npm test            # vitest unit tests
npm run test:e2e    # mandatory per CLAUDE.md after any change
                    # under packages/web-acp/ or packages/web-acp-agent/
```

Run from `packages/cli-acp-client/`:

```bash
npm run test:e2e    # confirms the agent package still works for
                    # the other host (canary against accidental
                    # agent-package edits)
```

Manual:

- Open the dev server (`npm run dev` from `packages/web-acp/`),
  authenticate, mount a volume, send a prompt, verify
  streaming + bash tool + MCP toggles + slash commands +
  built-ins (`/help`, `/copy`) all behave as before.
- Confirm the worker boots cleanly (no console errors about
  missing imports).
- `grep -r "from ['\"]@/acp/engine\|@/agent/session-store\|@/features/feature-store\|@/mcp/toggle-store\|@/acp/agent-adapter\|@/agent/bodhi-provider\|@/agent/inline-agent\|@/agent/stream-fn" packages/web-acp/src/`
  returns zero.

## Spec updates

Per `CLAUDE.md § Functional specs`, the same PR updates:

- `ai-docs/web-acp/specs/web-acp/index.md` — the folder
  layout block (drop `engine/`, agent runtime files; reflect
  consolidated `runtime/storage-dexie/`, `runtime/volumes-fsa/`).
- `ai-docs/web-acp/specs/web-acp/agent.md`,
  `acp.md`, `vault.md`, `features.md`, `mcp.md`,
  `commands.md`, `tools.md` — fix the
  "topic-file note" caveat at the top of `index.md` becomes
  unnecessary after the cleanup; rewrite the cited paths.
- `ai-docs/web-acp/milestones/index.md` — update the
  "Post-M4 phase B agent-package extraction" sub-bullet
  to record this PR as the completion of that extraction.
