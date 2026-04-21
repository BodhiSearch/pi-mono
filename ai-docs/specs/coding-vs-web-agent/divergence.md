# Where they diverge (and why)

These axes are intentional: each reflects a constraint one runtime imposes that the other does not.

## Transport: stdio JSONL vs `MessagePort` structured clone

- **coding-agent** RPC mode runs on top of stdin/stdout JSONL (`packages/coding-agent/src/modes/rpc/jsonl.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`). Commands and responses are JSON lines; streams are deterministic because stdout is taken over with `packages/coding-agent/src/core/output-guard.ts`.
- **web-agent** runs on top of `postMessage` + structured clone (`packages/web-agent/src/worker-agent/rpc/transport.ts`, `packages/web-agent/src/worker-agent/rpc/transports/`). This buys cheap `ArrayBuffer` / `MessagePort` / `FileSystemDirectoryHandle` transfer at the cost of a hard rule: **no functions may cross the RPC** (closures don't clone). That constraint ripples through the rest of the architecture — MCP tools can't ship across, `streamFn` is wired worker-side only, tool executors are installed by the worker host rather than configured via RPC.

## Auth + model registry: monolithic vs single provider seam

- **coding-agent** bundles **everything** — auth storage, OAuth flows, JSON-defined providers, model inventory, per-request header resolution — into `packages/coding-agent/src/core/auth-storage.ts` + `packages/coding-agent/src/core/model-registry.ts` (~1340 lines combined). A user can drop provider/model JSON into `~/.pi/` to extend the matrix; OAuth credentials live on disk.
- **web-agent** exposes a small `LlmProvider` interface (`packages/web-agent/src/worker-agent/llm/types.ts:LlmProvider`) with two methods (`getApiKeyAndHeaders`, `getAvailableModels`) plus an optional `setAuthToken` rotation sink. The **host** owns auth storage (React providers, `localStorage`, etc.) and **rotates credentials into the worker** via the `set_auth_token` RPC. The concrete provider (`packages/web-agent/src/worker-bodhi/bodhi-provider.ts`) fetches the catalog on demand from `/bodhi/v1/models` and maps every alias variant to `Model<Api>`.

**Why:** browsers don't have a file-system-level credential store, and the extracted `@bodhiapp/bodhi-web-agent` library needs to be usable behind any auth scheme (Bodhi, Supabase, custom OAuth, raw API key). Collapsing auth + catalog into one provider interface is the smallest possible coupling point.

## Sessions: append-only JSONL on disk vs Dexie with in-memory fallback

- **coding-agent**: one session = one `.jsonl` file under `~/.pi/sessions/`. `SessionManager` (~1425 loc, `packages/coding-agent/src/core/session-manager.ts`) does `appendFileSync` / `readFileSync` directly. Sessions are browsable with `cat`, `jq`, `grep`.
- **web-agent**: `SessionStore` interface with **Dexie (IndexedDB)** as the primary backend and an in-memory store for tests (`packages/web-agent/src/worker-agent/core/session/{store,dexie-store,memory-store}.ts`). The same entry shapes are persisted but addressed by `(sessionId, entryId)` rows instead of file offsets. A single write chain (`WorkerAgentHost.turnBoundaryPersistence`) serialises message persistence, auto-compaction, and `session_loaded` re-emission so parent-id links never dangle.

**Why:** browsers can't write JSONL files directly. Dexie gives transactional writes, indexed lookups, and survives tab refresh. The append-only invariant is still there — entries are only ever added, never mutated.

## Filesystem: `process.cwd()` vs FSA vault

- **coding-agent** tools walk real paths under `process.cwd()` and call Node `fs`.
- **web-agent** mounts a user-selected `FileSystemDirectoryHandle` (from the FSA picker) as a ZenFS volume at `VAULT_MOUNT`, or an in-memory seed for dev. Tool paths are always vault-relative and go through `resolveVaultPath` (`packages/web-agent/src/worker-agent/fs/path-utils.ts:resolveVaultPath`) for sandboxing. The vault handle is forwarded to the Worker over a dedicated `vfsPort`; mounting is driven by `mount_vault` / `unmount_vault` RPCs.

**Why:** the browser has no process-level CWD, and the security boundary must be enforced in code since the Worker can't `chroot`.

## Tool hosting: worker-local vs main-thread MCP proxy

- **coding-agent** tools are all local — `bashTool`, `readTool` etc. execute in-process with unrestricted access to the host Node environment.
- **web-agent** has **two tool origins**:
  1. **Worker-local vault tools** — `createVaultTools` runs inside the Worker against ZenFS.
  2. **MCP proxy tools** — descriptors are registered in the Worker via `set_mcp_tools`, but when the agent invokes one the Worker emits a `tool_call_request` event up to the main thread, the host runs the actual MCP call (where the `bodhiClient` + auth context lives), and pipes the result back via `tool_call_response`. This is web-agent only — coding-agent has no equivalent RPC round-trip inside a tool call.

**Why:** MCP clients in a browser need the fetch credential + OAuth context, which is host-owned; sending the live client across `postMessage` would require serialising functions.

## Skill execution: local `bash` vs sandboxed iframe + Worker

- **coding-agent** skills invoke any binary or script the host shell can reach. The `bash` tool in coding-agent spawns a real child process with full Node + `$PATH` access; SKILL.md authors write `node hello.js` and it runs on the user's machine under the user's credentials.
- **web-agent** replaces that with a **restricted `bash` shim** (`packages/web-agent/src/sandbox/bash-skill.ts`) whose parser only accepts `node <path>.js` / `./<path>.js` / `<path>.js` invocations, and only when the resolved path sits under `<vaultMount>/.pi/skills/`. Everything else is rejected as a tool error. Accepted invocations are routed to a `SandboxHost` that:
  1. Hides a `sandbox="allow-scripts"` iframe (null origin — no access to host cookies / storage) at document-ready time.
  2. Spawns a fresh Web Worker per run from a blob URL inside the iframe.
  3. Threads a curated capability API (`console`, `fetch`, `vault.readFile/writeFile/ls`, `process.argv/env/cwd`, `stdin`) into the script via `new Function(...)` parameters.
  4. Bounds execution with a timeout that calls `worker.terminate()` and returns `exitCode: 124`.

**Why:** the browser has no process model, so anything shell-shaped has to be synthesised. The iframe + Worker pattern gives us two isolation boundaries (null origin + separate thread) while keeping the skill author's mental model (`node script.js args`) intact. Capability requests round-trip Worker → iframe → host over structured-clone `postMessage`, and the host enforces path-traversal rejection + credential-header stripping (`authorization`, `cookie`) before any real fetch fires. See [`worker-agent/skills.md`](../worker-agent/skills.md) for the full capability table.

## Interactive UX: pi-tui TUI vs React host

- **coding-agent** ships three run modes — `InteractiveMode` (pi-tui TUI with model selector, theme picker, slash commands, extension widgets), `runPrintMode` (one-shot stdout), `runRpcMode` (embed-in-another-app). The TUI is the primary UX.
- **web-agent** has no shipped TUI and no print mode. The worker-agent library *is* the RPC surface; rendering is up to the host. The reference React app (`packages/web-agent/src/`) is one host; `@bodhiapp/bodhi-web-agent` consumers could build their own.

## `AgentSession` sizing

- **coding-agent** `AgentSession` is the centre of gravity — scoped models, thinking level cycling, steering / follow-up queues, bash queue, retry / overflow recovery, extension lifecycle, tool registry, system-prompt composition, skill parsing, `navigateTree`, `fork`, branch summarisation, session-stats.
- **web-agent** `AgentSession` deliberately stays tiny (plain-data surface only); all orchestration moves to `WorkerAgentHost`. This is because the Worker boundary already forces a clean "plain data ↔ non-serialisable state" split, so `AgentSession` exposes only what the RPC server needs and `WorkerAgentHost` does the wiring.
