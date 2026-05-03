# Reorganize `ai-docs/web-acp/specs/` to mirror the post-extraction package split

## Context

The cleanup PR that just landed (this same plan file's earlier section) finished the post-M4 phase B extraction: the agent runtime is now exclusively at `packages/web-acp-agent/`, the browser host is exclusively at `packages/web-acp/`, and the CLI host (`packages/cli-acp-client/`) consumes the same agent code over a different transport.

The spec folder still has the **pre-extraction** shape: a single `ai-docs/web-acp/specs/web-acp/` tree whose 12 topic files mix agent-side and host-side concerns under one roof. Most file-path references inside those topic files point at locations that no longer exist (e.g. `src/agent/inline-agent.ts`, `src/features/feature-store.ts`, `src/transport/worker-stream.ts`). A topic-file note at the top of `index.md` warns the reader to mentally translate, but the prose is now genuinely misleading and the structure does not reflect the package split.

**Goal:** mirror the package split in the spec layout, with each spec folder grounded in concrete `<file>:<method>` references against the package it documents. Three discrete spec audiences:

1. **`packages/web-acp-agent/`** — host-neutral. Same code consumed by browser worker (today), Node CLI (today), HTTP/SSE host (future).
2. **`packages/web-acp/`** — browser-specific host runtime (Vite + React + Web Worker + Dexie + FSA).
3. **`packages/cli-acp-client/`** — Node TTY host runtime (already documented at `specs/cli-acp-client/`; **untouched** by this plan).

## Target spec folder layout

```
ai-docs/web-acp/specs/
├── README.md                    (untouched)
├── cli-acp-client/              (untouched — already correct)
├── web-acp-agent/               NEW
└── web-acp-client/              NEW
                                 ↑ web-acp/ deleted at the end of this plan
```

Inside each new folder, a `<topic>:<method>` grounding discipline: every claim about behaviour cites the file (and class/method) it describes. Code snippets only where logic is non-obvious (transport plumbing, streaming-reducer fold, prompt-driver cursor, command expander). Otherwise: prose + file references.

## Phasing

The migration runs in five phases so links stay intact and review stays bite-sized.

### Phase 1 — Scaffold the two new folders, port `index.md` files first

Create `web-acp-agent/index.md` and `web-acp-client/index.md`. Each is the "everything else points back to me" entry. Land them with an explicit nav table, the source-of-truth statement, public surface list, change procedure. Old `web-acp/index.md` keeps working in parallel for now.

### Phase 2 — Port agent-side topics → `web-acp-agent/`

Eight topic files. Source-of-truth: `packages/web-acp-agent/src/`.

### Phase 3 — Port host-side topics → `web-acp-client/`

Nine topic files. Source-of-truth: `packages/web-acp/src/`.

### Phase 4 — Port `startup-sequence.md` last

It crosses both packages. Land an agent-flavoured version in `web-acp-agent/startup-sequence.md` (the host-neutral wire flow, valid for any host) and a browser-flavoured one in `web-acp-client/startup-sequence.md` (React mount → worker spawn → FSA boot → auth → first turn) that links back to the agent's master flow. The CLI's already-shipped `cli-acp-client/index.md` plays the same role for the Node host.

### Phase 5 — Sweep and delete

- Update `ai-docs/web-acp/specs/README.md` (the parent README) to reference the new structure.
- Update root `CLAUDE.md` and `ai-docs/web-acp/steering/02-architecture.md` if they link into `specs/web-acp/<topic>.md` — replace with `specs/web-acp-agent/<topic>.md` or `specs/web-acp-client/<topic>.md`.
- Update `ai-docs/web-acp/milestones/index.md` load-when hooks (currently point at `specs/web-acp/`).
- `git rm -r ai-docs/web-acp/specs/web-acp/` once every link is repointed.

## Phase 2 detail — `web-acp-agent/` topic files

Source of truth: `packages/web-acp-agent/src/`.

### `web-acp-agent/index.md`
- Purpose, scope (host-neutral agent runtime; ACP JSON-RPC 2.0 wire), three host runtimes today/tomorrow.
- Hard constraints: no browser-only deps, no node-only deps, no react. Public surface only via `src/index.ts`.
- Folder layout (one-line description per file under `src/`).
- Public barrel exports — group by topic (engine, agent runtime, MCP, storage interfaces, commands, volumes, wire types, bootstrap).
- Global guarantees: ACP-only across the boundary, structured-clone safety, single `init` per host, NDJSON framing via SDK.
- Navigation table to topic files.
- Change procedure mirrors the existing rule.

### `web-acp-agent/acp.md`
- Wire shim: `acp/agent-adapter.ts:AcpAgentAdapter` (constructor signature, options, dispatch posture).
- Engine layer split:
  - `acp/engine/services.ts:assembleServices` — deps bag construction; `AcpAdapterServices` + `AssembleServicesOptions` + `StreamOverridesRef`.
  - `acp/engine/types.ts` — `SessionState`, `ExtMethodHost`, `BodhiPromptMeta`.
  - `acp/engine/session-runtime.ts:AcpSessionRuntime` — per-session lifecycle, MCP pool ownership, model resolver, command catalog refresh.
  - `acp/engine/prompt-driver.ts:PromptTurnDriver` — single prompt-turn loop; the `StreamCursor` delta-emit logic is the one snippet that genuinely earns its place. `cursor.messageId` reset on assistant-message change; `text.slice(cursor.emittedLength)` as wire delta.
  - `acp/engine/builtin-dispatch.ts:tryHandleBuiltin` — the early-return-before-LLM contract.
  - `acp/engine/ext-methods/` — list every `_bodhi/*` and `bodhi/*` handler with a one-line behavioural note (e.g. `list-models.ts: returns the agent's cached catalog; never re-fetches`).
- Permissions: `acp/permissions.ts:requestPermissionStub` (deferred work documented).
- Wire-utils: `acp/wire-utils.ts` pure helpers — list each export.
- Cross-link: each host's `acp.md` for the client-side counterpart.

### `web-acp-agent/agent.md`
- `agent/inline-agent.ts:createInlineAgent` — pi-agent-core wrapper (events, prompt, cancel, history rehydrate).
- `agent/bodhi-provider.ts:BodhiProvider` — `setAuthToken`, `getApiKeyAndHeaders`, `getAvailableModels`, alias-flattening (`flattenAlias`, `flattenApiAlias`, `buildLocalAliasModel`). API-format mapping (`apiFormatToPiApi`, `apiFormatToProvider`, `baseUrlForFormat`).
- `agent/stream-fn.ts:createStreamFn` — provider-to-`pi-ai` `streamSimple` adapter; `StreamOverridesRef` consume-and-clear pattern.
- `agent/system-prompt.ts:composeSystemPrompt` — volume descriptor injection.
- The `LlmProvider` interface (lives in this file): host-implementable seam.

### `web-acp-agent/sessions.md`
- `storage/session-store.ts:SessionStore` — interface contract: `createSession`, `recordNotification`, `recordTurn`, `recordBuiltin`, `listSummaries`, `readEntries`, `getSession`, `setTitle`, `deleteSession`.
- Entry shapes: `SessionEntry`, `SessionEntryKind`, `TurnPayload`, `BuiltinPayload`, `SessionRow`, `SessionSummary`.
- Replay contract with `session/load` (described from the agent's POV — the agent reads via `readEntries` to rebuild inline-agent history).
- Cross-link: `web-acp-client/storage-dexie.md` (concrete impl) and `cli-acp-client/index.md` (in-memory + future SQLite impl).

### `web-acp-agent/volumes.md`
- `agent/volume-registry.ts:VolumeInit` — host-neutral mount descriptor (`mountName`, `description?`, `fs: FileSystem`, `initialize?`).
- `agent/volume-registry.ts:VolumeRegistry` interface — `mount`, `unmount`, `mountAll`, `list`, `firstMountName`, `onChange`.
- `agent/volume-registry.ts:ZenfsVolumeRegistry` — concrete impl over `@zenfs/core` `mount`/`umount`. Why `@zenfs/core` (not `@zenfs/dom`) — host neutrality.
- Cross-link: `web-acp-client/volumes.md` (FSA handle ↔ `VolumeInit` conversion via `runtime/volumes-fsa/backends.ts:toAgentVolumeInit`) and `cli-acp-client/index.md` (PassthroughFS path).

### `web-acp-agent/tools.md`
- `agent/tools/bash-tool.ts:createBashTool` — single LLM-facing tool, `BASH_OUTPUT_BYTE_LIMIT`, just-bash + `MountableFs` composition.
- `agent/tools/volume-filesystem.ts:VolumeFileSystem` — `IFileSystem` adapter over ZenFS, the ~25-method surface.
- ACP `tool_call` / `tool_call_update` translation lives in `prompt-driver.ts:#forwardEvent` — cross-link to acp.md.
- Cancellation + truncation behaviour.

### `web-acp-agent/commands.md`
- Vault commands:
  - `agent/commands/loader.ts:loadCommandsFromVolumes` — `<mount>/.pi/commands/**/*.md` discovery; `CommandsFs` filesystem abstraction.
  - `agent/commands/loader.ts:loadPromptsFromVolumes` — `<mount>/.pi/prompts/**/*.md` mirror.
  - `agent/commands/expander.ts:expandCommand` — front-matter + body substitution.
  - `agent/commands/front-matter.ts:parseFrontMatter` — minimal YAML.
  - `agent/commands/path.ts:canonicalCommandName` — `<mount>:<name>` shape.
- Built-ins:
  - `agent/commands/builtins/index.ts:isBuiltinName`, `findBuiltin`, `builtinAvailableCommands`.
  - One file per builtin (`help`, `version`, `info`, `copy`, `mcp`) with `BuiltinHandlerCtx` deps.
- Wire surface:
  - `available_commands_update` advertisement on `session/new` + `session/load`.
  - `_meta.bodhi.builtin = { command, action? }` envelope on `agent_message_chunk`.
  - The `'builtin'` `SessionEntry` kind (and its persistence in `recordBuiltin`).
- Cross-link: `web-acp-client/commands.md` (CommandPicker + `dispatchBuiltinAction`).

### `web-acp-agent/features.md`
- `storage/feature-store.ts:FeatureStore` interface — `getSnapshot`, `setKey`.
- `FEATURE_DEFAULTS`, `FeatureKey`, `isFeatureKey`. Ship list (`bashEnabled`, `forceToolCall`).
- ACP wire: `_bodhi/features/list`, `_bodhi/features/set` (handlers in `acp/engine/ext-methods/features-{list,set}.ts`).
- DEV-only gating for `forceToolCall` — agent enforces `isDev` from `AcpAgentAdapterOptions`.
- Cross-link: `web-acp-client/features.md` (`useAcpFeatures`, `FeaturePanel`).

### `web-acp-agent/mcp.md`
- `agent/mcp/client.ts:createMcpClient` — Streamable-HTTP only.
- `agent/mcp/connection-pool.ts:McpConnectionPool` — fingerprint eviction, refcounting, lifecycle event emission (`McpPoolEventType`).
- `agent/mcp/tool-adapter.ts:createMcpAgentTool` — MCP descriptor → `AgentTool` adapter; `<srv>__<tool>` namespacing via `mcpToolName`.
- `storage/mcp-toggle-store.ts:McpToggleStore` interface; `EMPTY_MCP_TOGGLES`, `isServerEnabled`, `isToolEnabled`.
- Wire: `_bodhi/mcp/toggles/set` handler + `_meta.bodhi.mcp` lifecycle notifications.
- Cross-link: `web-acp-client/mcp.md` (catalog UI, `compose-mcp-servers`, `McpPanel`).

### `web-acp-agent/startup-sequence.md`
- Host-neutral ACP boot: any host hands a transport + services bag; `bootstrap.ts:startAcpAgent(transport, services, options)` returns the live `AgentSideConnection`.
- ACP handshake (`initialize`, `authenticate` with `bodhi-token`, capability advertisement: `agentCapabilities.loadSession`, `clientCapabilities.fs` reporting).
- Per-session lifecycle: `session/new` → `available_commands_update` → first `session/prompt` → engine-layer event flow → `agent_message_chunk` deltas → `tool_call` → final response.
- Cross-link to host startup specs (browser, CLI).

## Phase 3 detail — `web-acp-client/` topic files

Source of truth: `packages/web-acp/src/`.

### `web-acp-client/index.md`
- Purpose: browser host runtime; embeds `@bodhiapp/web-acp-agent` as a Web Worker.
- Hard constraints: no engine code (lives in agent package); no Bodhi auth-server contact (delegated to `@bodhiapp/bodhi-js-react`).
- Folder layout (post-cleanup tree under `packages/web-acp/src/`).
- Public surface: the host-runtime library boundary at extraction (M8) — `acp/index.ts` constants, `AcpClient`, `agent/agent-worker.ts:AgentWorkerInitMessage`, the `runtime/{storage-dexie,volumes-fsa,transport}/` adapters.
- Navigation table.
- Change procedure.

### `web-acp-client/transport.md`
- `runtime/transport/worker-stream.ts:createMessagePortStream` — `MessagePort` ↔ `ReadableStream`/`WritableStream` bridge.
- Structured-clone safety: per-chunk fresh `Uint8Array` allocation + transfer.
- `agent/agent-worker.ts:startAgent` — boot shim that calls `startAcpAgent` (cross-link to `web-acp-agent/startup-sequence.md`). One snippet showing the assembleServices wiring is justified here.
- The volume-control raw-postMessage sidechannel rationale (FSA handles non-JSON-serialisable).

### `web-acp-client/acp.md`
- Host-side wire/engine split — the symmetric counterpart to `web-acp-agent/acp.md`.
- `acp/client.ts:AcpClient` — main-thread wrapper over `ClientSideConnection`.
- `acp/runtime.ts:ensureRuntime` — singleton (worker, client, MainZenfs, volume control).
- `acp/streaming-reducer.ts:streamingReducer` — pure reducer over `session/update` notifications. Snippet justified for the `agent_message_chunk` accumulation path (messageId-aware reset, delta concatenation, builtin-tag carry).
- `acp/builtin-dispatch.ts:dispatchBuiltinAction` — `/copy`, `/mcp add`, `/mcp remove` host actions.
- `acp/fs-handlers.ts:buildFsHandlers` — the IDE-integration `fs/*` seam (deferred; not used by built-in bash).
- `acp/permissions.ts:requestPermissionStub` (mirrors the agent stub; cross-link).
- `acp/{message-shape,session-meta,wire-utils,methods,index}.ts` — purpose per file, list each export.

### `web-acp-client/hooks.md`
- `hooks/useAcp.ts` — thin facade composing eight slice hooks.
- One file per slice hook with a behavioural one-liner:
  - `useAcpRuntime` — `ensureRuntime` + `useVolumes`.
  - `useAcpAuth` — Bodhi auth observation, `setAuthToken` posting, model load, token-rotation `session/load` rebuild.
  - `useAcpModels` — `selectedModel`, `ensureDefaultModel`, `applyLastModel`, `loadModels`.
  - `useAcpFeatures` — `_bodhi/features/*` slice.
  - `useAcpMcp` — `mcpToggles`, `composeCurrentMcpServers`, `dispatchAction`, `setMcpToggle`.
  - `useAcpSession` — `ensureSession`, `loadSession`, `clearMessages`, `deleteSession`.
  - `useAcpStreaming` — `session/update` listener + `sendMessage`/`stop`/`clearError` driving the reducer.
  - `useVolumes` — `addVolume`, `removeVolume`, `restoreAccess`, dev-seed merge.
- StrictMode invariants (singleton survival).

### `web-acp-client/storage-dexie.md`
- `runtime/storage-dexie/db.ts:SessionStoreDb` — Dexie v3 schema (sessions / entries / features / mcpToggles).
- `runtime/storage-dexie/session-store.ts:createStoreFromDb` — `SessionStore` impl.
- `runtime/storage-dexie/feature-store.ts:createFeatureStore` — `FeatureStore` impl.
- `runtime/storage-dexie/mcp-toggle-store.ts:createMcpToggleStore` — `McpToggleStore` impl.
- Schema-version + migration discipline.
- Cross-link: agent-side interface specs.

### `web-acp-client/volumes.md`
- `runtime/volumes-fsa/types.ts:HostVolumeInit` — host-shaped volume init (FSA handle | seed).
- `runtime/volumes-fsa/backends.ts:toAgentVolumeInit` — converts `HostVolumeInit` → agent's `VolumeInit` by constructing a `WebAccess` (real handle) or `InMemory` (seed) FS.
- `runtime/volumes-fsa/volume-channel.ts:attachVolumeChannel` — worker-side raw-postMessage mount/unmount listener.
- `runtime/volumes-fsa/volume-control.ts:createVolumeControl` — main-thread `Worker.postMessage` client.
- `vault/fsa-handle-store.ts` — `idb-keyval` persistence + permission re-grant.
- `vault/main-zenfs.ts:MainZenfs` — duplicate FSA mount on main thread (the `fs/*` IDE-integration seam).
- Test seam: `useDevSeedBoot` + `window.__zenfsSeed`.
- Cross-link: `web-acp-agent/volumes.md`.

### `web-acp-client/mcp.md`
- `mcp/types.ts` — `McpInstanceView`, `McpConnectionState`, `BodhiMcpUpdateMeta`.
- `mcp/useMcpInstances.ts` — React hook over `bodhiClient.mcps.list()`.
- `mcp/compose-mcp-servers.ts:compose` — `(instances, jwt, baseUrl, toggles?) → McpServerHttp[]`.
- `mcp/requested-mcps-store.ts` — IndexedDB wishlist of MCP URLs requested at login.
- `mcp/url-canonical.ts` — re-exported by both packages; canonicalisation rules.
- `mcp/McpPanel.tsx` — status chips + per-server/per-tool toggles.
- Cross-link: `web-acp-agent/mcp.md` for worker-side runtime.

### `web-acp-client/commands.md`
- `components/chat/CommandPicker.tsx` — palette UI consuming `available_commands_update`.
- `acp/builtin-dispatch.ts` (host-side dispatch already covered in `acp.md`; cross-link, no duplication).
- `lib/builtin-format.ts` — markdown rendering for built-in replies (the `data-test-state` "muted-builtin" bubble).
- Wire shape consumed: `_meta.bodhi.builtin` envelope (cross-link to `web-acp-agent/commands.md`).

### `web-acp-client/features.md`
- `hooks/useAcpFeatures.ts` — feature slice; `setFeature(key, value)` over `_bodhi/features/set`.
- `components/features/FeaturePanel.tsx` — UI; DEV-gated `forceToolCall` toggle.
- The DEV gate (`import.meta.env.DEV`) and how it pairs with the agent-side `isDev` enforcement.

### `web-acp-client/startup-sequence.md`
- Browser-host startup, top-down (cross-links into `web-acp-agent/startup-sequence.md` once the agent boots):
  1. `App.tsx` mounts; `BodhiProvider` (from `@bodhiapp/bodhi-js-react`) gates auth.
  2. `useAcp` mounts; `useAcpRuntime` → `ensureRuntime` (`acp/runtime.ts`) — Worker spawn, MessageChannel, `ndJsonStream`, fs handler installation.
  3. `useVolumes` resolves persisted FSA handles + dev seeds → `runtime.resolveInit(volumes)` posts `init` message with `agentPort` + `HostVolumeInit[]`.
  4. Worker `agent-worker.ts:startAgent` — converts via `toAgentVolumeInit`, builds Dexie stores + `ZenfsVolumeRegistry` + `BodhiProvider`, calls `startAcpAgent`.
  5. ACP handshake completes (cross-link to agent-side flow).
  6. `useAcpAuth` observes Bodhi auth state → `client.authenticate({ token, baseUrl })` → `client.listModels()`.
  7. First `useAcpStreaming.sendMessage` → `prompt` → reducer-driven streaming → `turn-end`.
- E2E priming via `useDevSeedBoot` (DEV only).

## Cross-spec linking discipline

- Spec files in `web-acp-agent/` link to peer files via relative paths (e.g. `[`acp.md`](./acp.md)`). To `web-acp-client/`, use `../web-acp-client/<file>.md`. To `cli-acp-client/`, use `../cli-acp-client/index.md`.
- Cross-package source citations use absolute repo paths (e.g. `packages/web-acp-agent/src/acp/agent-adapter.ts:AcpAgentAdapter`).
- One snippet per topic file, max — only for genuinely complex logic (the streaming-reducer fold, the prompt-driver `StreamCursor` delta logic, the `toAgentVolumeInit` FSA→FileSystem bridge).

## Critical files

**Created:**
- `ai-docs/web-acp/specs/web-acp-agent/index.md`, `acp.md`, `agent.md`, `sessions.md`, `volumes.md`, `tools.md`, `commands.md`, `features.md`, `mcp.md`, `startup-sequence.md` (10 files)
- `ai-docs/web-acp/specs/web-acp-client/index.md`, `transport.md`, `acp.md`, `hooks.md`, `storage-dexie.md`, `volumes.md`, `mcp.md`, `commands.md`, `features.md`, `startup-sequence.md` (10 files)

**Edited:**
- `ai-docs/web-acp/specs/README.md` — point at the new sub-folders.
- `ai-docs/web-acp/milestones/index.md` — repoint load-when hooks (every link into `specs/web-acp/<topic>.md`).
- `ai-docs/web-acp/steering/02-architecture.md` — repoint inline links to `specs/web-acp/...`.
- Root `CLAUDE.md` — `@ai-docs/web-acp/specs/web-acp/index.md` → split reference (link both new index files).

**Deleted (last):**
- `ai-docs/web-acp/specs/web-acp/` (entire directory, all 12 files).

## Source-grounding rules (recap, applied in every new file)

- Every behavioural claim cites `<package>/<path>:<symbol>` (file + class / function / interface).
- Existing utilities to reuse (do not re-derive prose):
  - Public barrel of agent: `packages/web-acp-agent/src/index.ts` (canonical export list).
  - Bootstrap signature: `packages/web-acp-agent/src/bootstrap.ts:startAcpAgent`.
  - Worker boot reference: `packages/web-acp/src/agent/agent-worker.ts`.
  - CLI peer for cross-host comparison: `packages/cli-acp-client/src/acp/embedded-host.ts`.
- Do NOT paste large prose blocks from existing `specs/web-acp/<topic>.md` — the grounding contract requires re-reading the source. The old prose can seed a structure, never the wording.

## Verification

End-to-end check after the migration lands:

```bash
# 1. No file in the old folder remains.
test ! -d ai-docs/web-acp/specs/web-acp/ && echo "ok"

# 2. Every internal link from the spec tree resolves.
find ai-docs/web-acp/specs -name "*.md" | xargs grep -l "specs/web-acp/" \
  | grep -v "specs/web-acp-agent\|specs/web-acp-client" || echo "ok: no stale links"

# 3. Every cited source path actually exists.
for path in $(grep -rhE 'packages/web-acp(-agent)?/src/[a-zA-Z/.-]+' ai-docs/web-acp/specs/web-acp-agent ai-docs/web-acp/specs/web-acp-client | grep -oE 'packages/web-acp(-agent)?/src/[a-zA-Z/.-]+\.ts' | sort -u); do
  test -e "$path" || echo "MISSING: $path"
done

# 4. Cross-references resolve in both directions (sample).
grep -l "web-acp-agent/acp.md" ai-docs/web-acp/specs/web-acp-client/
grep -l "web-acp-client/acp.md" ai-docs/web-acp/specs/web-acp-agent/

# 5. CLAUDE.md auto-load works.
grep -n "specs/web-acp" CLAUDE.md  # should only show the two new index links, not the old folder.

# 6. Code-level sanity unaffected (no source changes in this plan).
cd packages/web-acp && npm run check && npm test
```

Manual review: open each new `index.md` and follow every navigation link by hand — confirm topic boundaries hold and nothing reads as duplicated/contradictory between the agent and client halves.
