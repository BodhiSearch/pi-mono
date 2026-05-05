# M5 — Agent-package extraction + ACP 0.21 compliance + engine split

**Status:** shipped (multiple commits between the M4 phase B exit gate
and 2026-05-05). This file is a digest of post-M4 work that shipped
outside the original milestone cadence. It reshapes the foundation
every subsequent milestone (M6 onward) builds on, so sequencing
docs link here instead of re-deriving the state.

## What this digest covers

Six independent threads landed after M4 phase B with no individual
milestone file. They are recorded here together because together
they are the **current** state of the codebase — any plan that
post-dates this digest starts from this shape, not the shape
`m0-foundation.md` … `m4-commands-and-skills.md` describe.

1. Agent-package extraction (`@bodhiapp/web-acp-agent`).
2. ACP 0.21 compliance migration.
3. Pre-M6 engine split — agent-side (wire / engine seam).
4. Pre-M6 engine split — host-side (hook + reducer split).
5. "adaptive plum" simplification (dropped `fs/*` advertisement,
   main-thread ZenFS mirror, main-thread permission stub).
6. "provider-agnostic embed" simplification (`PreferenceStore`
   unification, `VolumeInit[]` flow, server-info probe folded into
   `setAuthToken`).

Plus two side notes at the bottom:

- `cli-acp-client` was built as a transport-neutrality proof and is
  now **shelved** — it validated the assertion; the active roadmap
  covers the browser host only.
- Per-session volume namespacing is flagged as open tech debt.

## 1 — Agent-package extraction

**What shipped.** The worker-side ACP runtime moved out of
`packages/web-acp/src/{acp,agent,features,mcp/url-canonical,
mcp/toggle-store}` into a new private workspace package at
`packages/web-acp-agent/`, published internally as
`@bodhiapp/web-acp-agent` (still `"private": true` until M11 flips
it to a real npm publish).

**Public entry point.**

```ts
import { startAgent, BodhiProvider, ZenfsVolumeRegistry } from '@bodhiapp/web-acp-agent';

startAgent({
  transport: { readable, writable },     // byte-stream pair
  provider: new BodhiProvider(),         // or any LlmProvider impl
  registry,                              // host-constructed VolumeRegistry
  sessions,                              // optional SessionStore
  preferences,                           // optional PreferenceStore
  buildVersion: '...',
});
```

The returned handle exposes `dispose()` for teardown.

**Pluggable interfaces.** Four host-implementable surfaces, all
declared in the agent package's `storage/` + `agent/volume-registry.ts`:

- `SessionStore` (session rows + entries + cursor-paginated
  listing).
- `PreferenceStore` (unified replacement for the legacy
  `FeatureStore` + `McpToggleStore` pair — `get(sessionId, key)` /
  `set(sessionId, key, value)`). Typed accessors live in
  `agent/internal/{feature,mcp-toggle}-prefs.ts`.
- `VolumeRegistry` (`ZenfsVolumeRegistry` default; hosts construct
  the `FileSystem` instances and pre-mount via
  `registry.mountAll(initialVolumes)`).
- `LlmProvider` (`BodhiProvider` default; alternate providers
  implement `getApiKeyAndHeaders`, `getAvailableModels`,
  optional `setAuthToken`).

**Hard constraints.** The agent package ships with **zero
browser-only runtime deps**: no `@zenfs/dom`, `dexie`,
`idb-keyval`, `MessagePort`, `Worker`, FSA types, `navigator.*`,
or `window.*`. Runtime deps allowed: `@agentclientprotocol/sdk`,
`@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`,
`@modelcontextprotocol/sdk`, `@sinclair/typebox`, `@zenfs/core`,
`just-bash`, `zod`. Grep gates at
`packages/web-acp-agent/src/` enforce this.

**Host (`packages/web-acp/`) became a consumer.** The browser
host bundle now owns only:

- Vite entry + React app.
- Worker boot shim at `src/agent/agent-worker.ts` (opens Dexie,
  builds the FSA volume registry, calls `startAgent`).
- Host-runtime adapters under `src/runtime/{storage-dexie,
  transport,volumes-fsa}/` that implement the agent's interfaces.
- Host-side ACP wire layer at `src/acp/` (AcpClient, runtime
  singleton, streaming + panels reducers, builtin dispatch).
- React hook layer at `src/hooks/` (per-concern slices).
- MCP main-thread surface at `src/mcp/` (catalog fetch, compose,
  URL canonicaliser, wishlist).
- Vault FSA handles at `src/vault/`.

**Why it shipped now.** M4 phase B landed the last capability the
original plan bundled into the browser host. With the tool
registry, MCP wire, commands pipeline, and built-in dispatch all
stabilised, the agent code had stopped moving along the
host-specific axis. Lifting it into its own package at that point
cost one refactor; lifting later would have multiplied every
subsequent milestone's diff.

**Spec entries.**
[`../specs/web-acp-agent/index.md`](../specs/web-acp-agent/index.md)
is the living source of truth for the agent package's public
surface. [`../specs/web-acp-client/index.md`](../specs/web-acp-client/index.md)
is the browser host. Anything that used to live at `../specs/web-acp/*`
moved under one of those two folders.

## 2 — ACP 0.21 compliance migration

**What shipped.** Eight features the spec ships natively (but that
pre-extraction code had served via custom `_bodhi/*` extensions)
migrated to native ACP 0.21 surfaces:

| ACP 0.21 native               | Legacy surface (deleted)                          |
| ----------------------------- | ------------------------------------------------- |
| `Agent.listSessions`          | `bodhi/listSessions`                              |
| `Agent.closeSession`          | — (added for in-memory cleanup)                   |
| `Agent.unstable_setSessionModel` + `SessionModelState` | `bodhi/listModels` returning currentModelId via `_meta.bodhi.modelId` |
| `Agent.setSessionConfigOption` + `config_option_update` | `_bodhi/features/list` + `_bodhi/features/set` |
| `agentInfo` on `InitializeResponse` | — (new)                                    |
| Explicit reducer arms for all 11 `SessionUpdate` kinds | Default pass-through on the host side |
| `extNotification("_bodhi/mcp/state")` side-channel | Empty `agent_message_chunk` + `_meta.bodhi.mcp` envelope ride |
| `extNotification("_bodhi/builtin/action")` side-channel | `_meta.bodhi.builtin.action` envelope ride |

**Cursor pagination for `Agent.listSessions`** shipped in the
post-2026-05-04 sweep. Cursor is
`base64(page=N&per_page=10&sort_by=updated_at&sort_seq=desc)`; see
`packages/web-acp-agent/src/acp/handlers/list-sessions-cursor.ts`.
`SessionStore` grew
`listSummariesPage({page, perPage}): {rows, total}`; the Dexie
impl + the in-memory impl both support it. The host's
`AcpClient.listSessions(cursor?)` returns
`{sessions, nextCursor}`; `useAcpSession` exposes
`loadMoreSessions` and `nextSessionsCursor`; `SessionPicker` shows
a "Load more" button while `nextCursor !== null`.

**`_bodhi/session/get` removed.** Transcript + toggles now ride
natively on `LoadSessionResponse._meta.bodhi.{messages,
mcpToggles, title}` per `BodhiLoadSessionMeta`. The host's
`streamingReducer` seeds this as the authoritative transcript on
`session/load`.

**What stayed extension.** Anything the spec doesn't ship
natively still rides `_bodhi/*` per principle § 15:

- `_bodhi/volumes/list` (agent-owned FS is a documented
  divergence from ACP canonical).
- `_bodhi/mcp/toggles/set` + `_bodhi/mcp/state` notification.
- `_bodhi/sessions/delete` (destructive delete; `closeSession`
  only frees in-memory resources).
- `_bodhi/builtin/action` notification.
- `_bodhi/features/{bashEnabled,forceToolCall}` config-option ids.

**Driver.** An audit at
[`../reviews/acp-compliance-2026-05-03.md`](../reviews/acp-compliance-2026-05-03.md)
catalogued every divergence. The migration plan at
[`../../plans/reviewed-the-acp-compliance-report-peaceful-journal.md`](../../plans/reviewed-the-acp-compliance-report-peaceful-journal.md)
shipped the changes in M1–M8 sub-phases. The compliance-at-a-glance
table in [`index.md`](index.md) now reads "compliant" on every
row the migration touched.

## 3 — Pre-M6 engine split (agent-side)

**What shipped.** `acp/agent-adapter.ts` shrank from 1,254 → ~245
LoC by extracting the session and turn-level machinery into a
dedicated engine layer. Final shape:

```
packages/web-acp-agent/src/acp/
├── agent-adapter.ts            # thin Agent-interface dispatch
├── feature-config.ts           # SessionConfigOption builder + configId↔key map
├── wire-utils.ts               # pure ACP wire helpers
├── handlers/                   # one file per ACP method concern
│   ├── adapter-context.ts
│   ├── initialize.ts           # initialize / authenticate
│   └── session-crud.ts         # newSession / loadSession / listSessions /
│                               #   closeSession / unstable_setSessionModel /
│                               #   setSessionConfigOption / cancel
└── engine/
    ├── services.ts             # AcpAdapterServices deps bag + assembleServices()
    ├── session-runtime.ts      # AcpSessionRuntime — per-session lifecycle owner
    ├── prompt-driver.ts        # PromptTurnDriver — single prompt-turn loop
    ├── builtin-dispatch.ts     # tryHandleBuiltin (early-return before LLM)
    ├── replay.ts               # walkEntries(entries, callbacks) shared replay walker
    ├── types.ts                # SessionState, ExtMethodHost
    └── ext-methods/            # _bodhi/* extension methods (3 files + dispatch + schemas)
```

**Why it matters for M6 onward.** Extensions register tools,
lifecycle hooks, commands, and providers against the engine —
not the wire shim. Having the engine layer stable (with
`AcpSessionRuntime`, `PromptTurnDriver`, and the
`ExtMethodHost` bag) means M6's extension contract can target a
small surface and not churn the wire. Same logic for M8 fork
(per-session state flows through `AcpSessionRuntime`) and M9
compaction (replay walker + turn driver own the transcript
boundary).

## 4 — Pre-M6 engine split (host-side)

**What shipped.** `packages/web-acp/src/hooks/useAcp.ts` shrank
from 1,133 → ~180 LoC by extracting the non-React ACP plumbing
into `src/acp/` and routing every concern through a dedicated
slice hook.

Final shape of `packages/web-acp/src/`:

```
acp/
├── client.ts                   # AcpClient
├── runtime.ts                  # AcpRuntime singleton (per-tab worker + auth keys)
├── streaming-reducer.ts        # pure reducer for session/update
├── panels-reducer.ts           # pure reducer for commands/mcp/configOptions
├── message-shape.ts            # content-block helpers
├── builtin-dispatch.ts         # host-side _bodhi/builtin/action handler
├── session-meta.ts             # _meta.bodhi view helpers
├── feature-keys.ts             # configId ↔ feature key (host-local copy for types)
├── empty-sentinels.ts          # frozen empties for reducer bail-out
└── index.ts                    # host-side wire barrel (re-exports from agent pkg)

hooks/
├── useAcp.ts                   # thin facade — composes the per-concern slices
├── useAcpRuntime.ts            # runtime singleton lifecycle
├── useAcpAuth.ts               # auth handshake + token push + re-auth
├── useAcpModels.ts             # model catalog + selector
├── useAcpMcp.ts                # MCP servers + toggles
├── useAcpSession.ts            # session CRUD + picker pagination
├── useAcpStreaming.ts          # consumes session/update via streamingReducer
└── useVolumes.ts               # FSA picker + handle persistence
```

**No more `useAcpFeatures` slice.** Per-session feature toggles are
read inline inside `useAcp` from `panelsState.configOptions` (the
`config_option_update` arm of the panels reducer is the one
source of truth).

**Why it matters for M6 onward.** Extensions in M6, session-tree
navigation in M8, and compaction UI in M9 all slot into the
existing reducers rather than introducing side-hooks with their
own effects. `streamingReducer` becoming a pure function is the
pre-req for any future extension hook on `before_prompt` /
`after_turn` that wants to mutate the transcript.

**Plan.** [`../../plans/kick-off-prompt-squishy-journal.md`](../../plans/kick-off-prompt-squishy-journal.md).

## 5 — "adaptive plum" simplification

**What shipped.**

- `clientCapabilities.fs` dropped entirely from
  `AcpClient.initialize()`. Was
  `{ readTextFile: true, writeTextFile: true }`; now the
  `_meta`-less response shape (`{}`).
- Main-thread `MainZenfs` duplicate of each `/mnt/<name>` mount
  removed. Was mounted to satisfy the `fs/read_text_file` /
  `fs/write_text_file` handlers; unused by the default bash
  tool, a latent concurrency hazard against the worker-side
  ZenFS.
- Main-thread `requestPermissionStub` removed. The SDK still
  requires `Client.requestPermission`; each host inlines a
  one-line cancelled-outcome stub at the `ClientSideConnection`
  construction site.

**Why.** The `fs/*` handlers + the permission stub were placeholder
IDE-integration seams advertised by earlier milestones as
future-proofing. After a few months of real usage nothing actually
consumed them and the duplicate mount was an active footgun. The
"adaptive plum" plan removed all three in one sweep; the bash tool
(the only real FS consumer) never round-tripped through them, so
the tool loop is unchanged.

**Re-entry path.** When the permission bridge lands (M10), it
re-uses `session/request_permission` — the stable ACP primitive —
not a host stub. When an external ACP agent ever needs read access
to mounted volumes through us, `clientCapabilities.fs` flips back
on deliberately (with a matching deploy-specific concurrency
story).

**Plan.**
[`../../plans/some-thoughts-on-the-adaptive-plum.md`](../../plans/some-thoughts-on-the-adaptive-plum.md).

## 6 — "provider-agnostic embed" simplification

**What shipped.**

- `FeatureStore` + `McpToggleStore` unified into a single
  `PreferenceStore` interface (`get(sessionId, key)` /
  `set(sessionId, key, value)`). Typed accessors over this
  interface live in `agent/internal/{feature,mcp-toggle}-prefs.ts`
  and are only consumed by the engine — the public surface is
  the typeless `PreferenceStore`.
- Volumes flow as `VolumeInit[]` at boot, not via a registry
  passed around. Hosts construct and pre-mount the registry
  (`registry.mountAll(initialVolumes)`) then pass it to
  `startAgent({ registry })`. Multi-session hosts (future) can
  still share one registry across connections.
- `_bodhi/server/info` extension method removed. The
  connectivity probe now rides as a side-effect of
  `LlmProvider.setAuthToken`, surfacing on
  `AuthenticateResponse._meta.bodhi.providerInfo`. Agents swap
  their provider implementation (`BodhiProvider` → any other
  `LlmProvider`) without the wire changing.

**Why.** The three interfaces all had the same shape
(`sessionId → record<string, value>`); keeping them distinct
meant hosts implemented three near-identical stores. `FeatureStore`
wrote booleans; `McpToggleStore` wrote a structured snapshot;
both became "key-value on (sessionId, key)". Unifying them
shrinks the host boundary by ~200 LoC per impl. The
server-info probe was never ACP-native — collapsing it into
`setAuthToken` lets the agent ask any LlmProvider for a
connectivity check without the wire carrying a Bodhi-specific
method.

## Two side notes

### cli-acp-client — shelved

A second host runtime (`packages/cli-acp-client/`) shipped
post-extraction as a Node TTY that embedded
`@bodhiapp/web-acp-agent` in-process over an in-memory
`TransformStream` duplex. It included its own Node OAuth 2.1 +
PKCE client, SQLite-backed stores, and a `PassthroughFS`-backed
`$cwd` volume.

**The CLI validated the transport-neutrality claim.** The same
agent code that runs inside the browser Web Worker runs
unchanged inside the CLI; only the transport adapter and the
services bag differ. It closed the M0 hardening follow-up's
"second transport" item in practice.

**It is now shelved for roadmap purposes.** The active roadmap
(M6 onward) targets the browser host (`packages/web-acp/`)
only. The `packages/cli-acp-client/` folder stays in the repo
as frozen reference — useful when / if a future Node host
re-enters as a first-class deployment target — but does not
receive feature parity with browser host work. No cli addenda
on the new milestone files.

### Per-session volume namespacing — open tech debt

`@zenfs/core@2.5.6` exposes a single process-global `mounts`
map. Every session handled by one `web-acp-agent` instance
shares the registry; a mount added via `registry.mount(init)`
is visible to every active session. `bindContext({ root })`
does not isolate the mount table, only the path prefix the
consumer sees.

Today this is latent: the browser host is single-tab /
single-session at any moment. When multi-session or
multi-connection hosts re-enter (any future backend deployment
or M8 fork tree), per-session namespacing lands as part of that
work. Tracked in
[`../../../packages/web-acp-agent/TECHDEBT.md`](../../../packages/web-acp-agent/TECHDEBT.md)
§ "Per-session volume namespacing".

## Cross-references

- [`../specs/web-acp-agent/index.md`](../specs/web-acp-agent/index.md)
  — agent-package living spec (post-extraction, post-compliance).
- [`../specs/web-acp-client/index.md`](../specs/web-acp-client/index.md)
  — browser host living spec.
- [`../specs/cli-acp-client/index.md`](../specs/cli-acp-client/index.md)
  — CLI host living spec (frozen; reference only).
- [`../../plans/reviewed-the-acp-compliance-report-peaceful-journal.md`](../../plans/reviewed-the-acp-compliance-report-peaceful-journal.md)
  — ACP 0.21 migration plan.
- [`../../../.cursor/plans/extract_web-acp-agent_9dacac4b.plan.md`](../../../.cursor/plans/extract_web-acp-agent_9dacac4b.plan.md)
  — agent-package extraction plan.
- [`../../plans/indexed-dazzling-fairy.md`](../../plans/indexed-dazzling-fairy.md)
  — post-extraction cleanup that flipped every host consumer to
  import from `@bodhiapp/web-acp-agent`.
- [`../../plans/some-thoughts-on-the-adaptive-plum.md`](../../plans/some-thoughts-on-the-adaptive-plum.md)
  — `fs/*` + main-thread ZenFS mirror + permission stub removal.
- [`../../plans/kick-off-prompt-squishy-journal.md`](../../plans/kick-off-prompt-squishy-journal.md)
  — host-side hook split + `streamingReducer`.
