# vault-tools

**Source of truth:** `packages/web-agent/src/worker-agent/core/tools/`, `packages/web-agent/src/worker-agent/fs/`

**Parent:** [`../worker-agent/index.md`](./index.md)

## Functional scope

The vault is the agent's view of the user's working directory. It is backed by a ZenFS mount inside the Worker and exposed to the main thread as a mirrored mount over a `MessagePort`. Six tools are the agent's only interface to it: `read`, `write`, `edit`, `ls`, `glob`, `grep`.

Two mount sources are supported:

- **FSA handle** (`mountVault(handle)`) — a real Chrome `FileSystemDirectoryHandle` wrapped by `@zenfs/dom`'s `WebAccess`.
- **In-memory seed** (`mountDevSeed(seed)`) — a Playwright / dev seed with `{ files, name }`, mounted via ZenFS `InMemory`.

### Responsibilities

- Six tool implementations: `read`, `write`, `edit`, `ls`, `glob`, `grep`.
- Narrow per-tool `Operations` interfaces so tools are testable against in-memory fakes.
- A `VaultOperations` aggregate bound to the worker-local ZenFS.
- Main-thread ZenFS proxy that marshals over a Port channel.
- Path resolution against the mount cwd.
- File-mutation serialisation to prevent overlapping writes.
- Output truncation for context efficiency.

### Non-responsibilities

- Vault mounting lifecycle itself — lives in [`worker-host.md`](./worker-host.md).
- Persistence beyond the filesystem — session persistence is [`sessions.md`](./sessions.md).
- FSA handle acquisition / persistence — main-thread concern outside `worker-agent/`.

## Technical reference

### Tool factories (`core/tools/`)

Each tool factory returns a tightly-typed `AgentTool` wired against a narrow `Operations` interface:

| Factory | Purpose | Ops interface | Key methods on ops |
| --- | --- | --- | --- |
| `createReadTool` | Read a file. | `ReadOperations` | `readFile`, `access` |
| `createWriteTool` | Write a file. | `WriteOperations` | `writeFile`, `mkdir` |
| `createEditTool` | String-replace inside a file. | `EditOperations` | `readFile`, `writeFile`, `access` |
| `createLsTool` | List directory. | `LsOperations` | `stat`, `readdir` |
| `createGlobTool` | Pattern match files. | `GlobOperations` | `stat`, `readdir` |
| `createGrepTool` | Text search across files. | `GrepOperations` | `stat`, `readdir`, `readFile` |

All factories accept `{ operations, cwd }`. `cwd` is the absolute path tools resolve relative args against.

### `core/tools/index.ts`

Exports per-tool factories and schema types plus one aggregate factory:

- `createVaultTools(ops: VaultOperations, options?: CreateVaultToolsOptions) => AgentTool[]`.
  - `CreateVaultToolsOptions = { cwd? }` — defaults to `VAULT_MOUNT` (`/vault`).
  - Returns `[read, write, edit, ls, glob, grep]` wired against the supplied operations.
  - The return is cast to the broader `AgentTool[]` type to collapse a contravariant mismatch on the `execute` params type. Runtime behaviour is unchanged — the agent validates args against `parameters` before invocation.

### `core/tools/file-mutation-queue.ts`

`withFileMutationQueue(tool)` wraps a tool so that overlapping executions on the same path serialise. Used internally by the vault factories for write/edit tools to avoid interleaved writes.

### `core/tools/truncation.ts`

Helpers to cap tool output (byte + line caps) so large file / search results don't blow out the context window. Read, grep, and glob tools apply truncation before returning.

### `fs/zenfs-operations.ts`

Defines the per-tool operations interfaces (`ReadOperations`, `WriteOperations`, `EditOperations`, `LsOperations`, `GlobOperations`, `GrepOperations`) plus the aggregate `VaultOperations`.

`createZenfsVaultOperations()` binds all six interfaces to `fs.promises` from `@zenfs/core`:

- `readFileBytes(path)` → `readFile` then convert `Buffer`/`Uint8Array` view to a standalone `Uint8Array`.
- `readFileText(path)` → `readFile` + `TextDecoder.decode`.
- `statNormalized(path)` → `stat` then strip to `{ isDirectory, isFile }`.
- `readdirNormalized(path)` → `readdir` coerced to `string[]`.

The split lets a mock implementation stand up just the subset of methods a given tool needs.

### `fs/path-utils.ts`

- `resolveVaultPath(rawPath, cwd)` — resolves a relative path against `cwd` (or leaves an absolute path alone) and rejects any `..`-escape that would land outside the vault.
- `VaultPathError` — thrown when an escape is detected. Tools surface this as a tool error rather than a crash.

### `fs/zenfs-provider.ts`

This file is the **main-thread** ZenFS integration (not the Worker side — the Worker uses raw `@zenfs/core` APIs inside `WorkerAgentHost`). Exports:

- `VAULT_MOUNT = '/vault'` — canonical mount path.
- `fs` — the `@zenfs/core` binding re-exported for convenience.
- `mountVaultPort(port)` — idempotent mount of a ZenFS `Port` backend at `VAULT_MOUNT` against the Worker's `vfsPort`. Timeout bumped to 5s (default 250ms trips on cold Worker starts). Returns after the remote backend acknowledges `ready`.
- `isVaultMounted()` — `true` iff a port is currently mounted.
- `unmountVault()` — best-effort umount; clears internal state even if the umount throws.

Idempotency rule: mounting the same port twice is a no-op; mounting a different port detaches the previous mount first.

### Worker-side lifecycle

`WorkerAgentHost` owns the mount (see [`worker-host.md`](./worker-host.md)):

- `mountVault(handle)` wraps FSA handle with `WebAccess`, mounts at `vaultMount`, attaches the `vfsPort`, and builds tools via `createVaultTools(createZenfsVaultOperations(), { cwd: vaultMount })`.
- `mountDevSeed(seed)` builds an `InMemory` backend, seeds files with mkdir-then-writeFile (tolerates `EEXIST` on mkdir), and attaches the `vfsPort`.
- `unmountVault()` detaches + clears the tool set.
- `refreshTools()` rebuilds the combined `[vaultTools, mcpTools]` list on the `AgentSession`.

Beyond the six tools listed above, two conventional sub-paths of the vault are consumed by the worker itself — they are **data**, not tools:

- `<vaultMount>/.pi/prompts/*.md` — prompt-template library (`/name [args]`). Parsed by `core/commands/prompt-templates.ts`.
- `<vaultMount>/.pi/skills/<name>/SKILL.md` (+ sibling scripts) — skills, surfaced via `/skill:<name>` expansion, the worker-owned system prompt, and the `bash` sandbox shim. See [`skills.md`](./skills.md).

The vault tools (`read`, `write`, etc.) are oblivious to these
conventions — the loader code reads the files through
`VaultOperations` directly.

### Integration with the main thread

After the Worker is booted and the `mount_vault` RPC has succeeded, the main thread calls `mountVaultPort(vfsPort)` once. From that moment any `fs.promises.*` call on the main thread at `/vault/...` is marshalled over the Port channel to the Worker's real backend. UI consumers (file tree, file viewer, markdown editor) use this transparently.

## Constraints

1. **No node-only imports.** `fs/` binds to `@zenfs/core` + `@zenfs/dom`; no `node:fs`, no `fs/promises`.
2. **Path safety.** All tools must resolve via `resolveVaultPath` — never accept absolute paths outside the vault.
3. **Write serialisation.** Write and edit tools should run through `withFileMutationQueue` so two concurrent edits to the same file serialise.
4. **Output truncation.** Tools returning text must apply the `truncation` helpers to keep context usage bounded.

## Tests

- `core/tools/*.test.ts` — one per tool, using in-memory operations fakes.
- `core/tools/file-mutation-queue.test.ts`, `core/tools/truncation.test.ts`.
- `fs/zenfs-operations.test.ts`, `fs/path-utils.test.ts`.

## Change procedure

Any plan that edits `core/tools/` or `fs/` must update this file in the same PR. When adding a new tool:

1. Define its narrow operations interface in `fs/zenfs-operations.ts`.
2. Add a factory under `core/tools/`.
3. Include the factory in `createVaultTools`.
4. Reflect the new tool in the table above and in the public barrel (`worker-agent/index.ts`).

See [`./index.md` § Change procedure](./index.md#change-procedure).
