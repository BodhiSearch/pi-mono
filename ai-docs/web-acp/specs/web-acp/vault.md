# vault

**Source of truth (agent — `packages/web-acp-agent/src/`):**
`agent/volume-registry.ts` (`ZenfsVolumeRegistry` — the worker-side
mount-point owner; replaces the M2 `volume-mount.ts`),
`agent/system-prompt.ts` (`composeSystemPrompt(volumes)` —
formats the `Volumes:\n- /mnt/<name>` block).

**Source of truth (browser host — `packages/web-acp/src/`):**
`vault/fsa-handle-store.ts` and `vault/main-zenfs.ts` (FSA-handle
persistence + main-thread duplicate ZenFS mount),
`runtime/volumes-fsa/` (`backends.ts`, `volume-channel.ts`,
`volume-control.ts`, `index.ts` — the FSA-backed `VolumeInit`
producer + the raw `postMessage` volume-control bridge),
`hooks/useVolumes.ts`, `components/volumes/`,
`acp/fs-handlers.ts` (the `fs/read_text_file` /
`fs/write_text_file` handlers served against the same FSA mounts
as an IDE-integration seam).

**Source of truth (CLI host — `packages/cli-acp-client/src/`):**
`services/cwd-volume.ts` produces a single `VolumeInit` over
`PassthroughFS(node:fs, $cwd)` and mounts it as `/mnt/cwd`; no
FSA, no `volumes/mount` postMessage channel.

## Purpose

`web-acp` M2 introduces *multi-volume* filesystem access. Each volume is
mounted at `/mnt/<name>` inside the worker's ZenFS VFS and exposed to the
`bash` tool (M2.2). The design intentionally keeps the **agent** as the
owner of the filesystem; ACP's `fs/*` methods are advertised in M2.3 as
an **IDE-integration seam**, not as the path the built-in tools call.

Two reasons drive the agent-owned stance:

1. `just-bash`'s `IFileSystem` surface (~25 methods: `readFile`,
   `readFileBuffer`, `stat`, `mkdir`, `readdirWithFileTypes`, `cp`,
   `mv`, `chmod`, `symlink`, `realpath`, `utimes`, …) can't be expressed
   through ACP's `readTextFile` / `writeTextFile` without a huge RPC
   tax on every shell invocation.
2. FSA `FileSystemDirectoryHandle`s live on the main thread but our tool
   host lives in the worker. Keeping the ZenFS backend in the worker
   lets us read bytes directly from `WebAccess` without round-tripping
   back over ACP for every `readdir`.

## Volume shapes

```ts
// packages/web-acp/src/agent/volume-mount.ts
interface VolumeInit {
  handle?: FileSystemDirectoryHandle;  // real FSA handle (production)
  seed?: VolumeSeed;                   // InMemory seed (dev / Playwright)
  mountName: string;                   // `/mnt/<mountName>`
  description?: string;                // free-text hint for the LLM
}
interface VolumeSeed {
  name: string;
  description?: string;
  files: Record<string, string>;       // absolute-under-mount paths
}
```

`VolumeRegistry` (`packages/web-acp/src/agent/volume-mount.ts`) is the
worker-side single source of truth. It owns the ZenFS mounts, notifies
listeners (adapter, future tool reloads) after every state transition,
and guarantees each `mountName` is unique within a tab's lifetime.

## Control plane: two channels

`web-acp` M2 runs **two data channels** between the main thread and the
agent worker:

| Channel | Wire | Carries |
| --- | --- | --- |
| ACP wire | `MessageChannel` + `ndJsonStream` (JSON-RPC 2.0) | `initialize`, `authenticate`, `session/*`, extension methods (including `_bodhi/volumes/list`) |
| Volume control | raw `worker.postMessage` with transfer list | `{type:'volumes/mount', init:VolumeInit}` / `{type:'volumes/unmount', mountName}` requests + their replies |

The volume-control channel is required because FSA handles are
**structured-cloneable but not JSON-serialisable**. Trying to push them
through JSON-RPC either loses the handle (if we stringify) or crashes
the framer (if we try to serialise the opaque wrapper). Keeping the
control plane outside ACP lets the handles flow end-to-end without
compromising the ACP invariant ("ACP is the only internal protocol")
for the *agent ↔ session* surface — volume lifecycle is a bootstrap /
control concern, comparable to the one-shot `init` message in M0.

The trade-off: main-thread UI state (`VolumeState`) is derived directly
from volume-control replies rather than from ACP `session/update`
traffic. This is documented as a deliberate divergence — cross-checked
by `_bodhi/volumes/list` (read-only) so an external ACP client can still
discover what the worker has mounted via the standard wire.

## Main-thread boot flow

```
useAcp() mounts
  └─ useVolumes() loads handles + dev seeds
       ├─ loadHandles()             // idb-keyval `web-acp:volumes`
       ├─ requestPermissions()      // FSA queryPermission({readwrite})
       └─ readDevSeeds()            // window.__zenfsSeed (Playwright)
  └─ onInitialVolumes(VolumeInit[])
       └─ runtime.resolveInit(volumes)
            └─ worker.postMessage({type:'init', agentPort, volumes})
                 └─ VolumeRegistry.mountAll(volumes)
```

The worker doesn't start its ACP loop until the main thread resolves
the initial volume list, so the first `session/prompt` turn always sees
the right `/mnt/<name>` entries (and the system prompt is composed
against the right list).

## Name collisions + persistence

`deriveUniqueMountName(baseName, existing)` appends `-1`, `-2`, … on
collision (`wiki` → `wiki-1` → `wiki-2`). When a volume is removed its
slot is freed, so re-adding the same directory reclaims the original
name — the re-use policy chosen in the M2 prompt's open-question #2.
Non-alphanumeric characters (except `.`, `_`, `-`) are replaced with
`-`, leading `.`/`-` runs are stripped, and a fallback of `volume` is
used for empty names.

`VolumeHandleRecord[]` is persisted in IndexedDB under the key
`web-acp:volumes` via `idb-keyval`. Chrome does not persist the
permission grant itself, so every page load calls
`requestPermissions(records)` to partition handles into `ready`
(auto-granted) and `prompt` (needs a user gesture via the "Grant"
button in `VolumeRow`). Dev seeds are held purely in memory and
re-injected by Playwright on every reload via `page.addInitScript`.

## System prompt injection

`composeSystemPrompt(volumes)` in `packages/web-acp/src/agent/system-prompt.ts`
returns the empty string when no volumes are mounted; otherwise it emits:

```
You have access to the following volumes:
- /mnt/wiki — knowledge base
- /mnt/code
Use the bash tool to explore them.
```

The adapter calls this on every `prompt()` turn using the current
registry snapshot so late add/remove events are reflected in the next
LLM call without a session reset. The system prompt is appended to
whatever `AgentState.systemPrompt` carries — M2 leaves the rest of the
prompt empty; M4 (skills / commands) will layer richer content on top.

## IDE-integration seam: `fs/*` client handlers (M2.3)

`web-acp` advertises `fs.readTextFile` + `fs.writeTextFile` in
`initialize` as part of `clientCapabilities`. These are implemented on
the **main thread** (`packages/web-acp/src/acp/fs-handlers.ts`) and
never called by the built-in `bash` tool. They exist so external ACP
agents — or a future editor-buffer bridge — can read/write the same
mounted volumes without going through the worker's bash surface.

To let the main-thread handlers read the same bytes the worker reads,
`packages/web-acp/src/vault/main-zenfs.ts` keeps a *duplicate* ZenFS
context on the main thread and mounts the **same**
`FileSystemDirectoryHandle`s at `/mnt/<name>`. FSA handles are
structured-cloneable and the storage underneath is shared by the OS,
so both realms see the same files.

### Duplicate-mount caveat

Two backends sharing one handle do not coordinate writes. Since the
built-in `bash` tool doesn't use `fs/*`, concurrent writes from inside
and outside the worker don't happen in practice today. Once an
external ACP agent starts exercising `fs/*` alongside `bash`, it
should coordinate with the bash tool — a later milestone may add a
proper lease / versioning layer (deferred, tracked in
`milestones/deferred.md`).

For dev/test **seed** volumes, the main-thread and worker-side
`InMemory` backends are two independent allocations. Seeds are
re-applied on both sides, so `fs/readTextFile` sees the staged content;
writes from the worker's `bash` tool do **not** propagate to the
main-thread seed. This is acceptable because Playwright stages
fixtures on both sides via `addInitScript`, and production paths never
use seeds.

### Path safety

`fs-handlers` validates every `params.path` against four rules before
touching ZenFS:

1. Path is absolute under `/mnt/` — anything else rejects.
2. First segment after `/mnt/` matches a registered mount (queried via
   `MainZenfs.list()`), else reject.
3. POSIX-normalised path stays inside `/mnt/<mountName>/` (catches
   `..` escape, e.g. `/mnt/wiki/../../etc/passwd`).
4. `fs.promises.realpath` of the canonical path must still start with
   `/mnt/<mountName>` (catches symlink escape).

Writes additionally `mkdir -p` the parent directory before
`writeFile`; the parent's realpath is checked the same way to prevent
symlink escapes through the target directory.

## Deferred in M2

- **Permission bridge.** `session/request_permission` + allow-always
  persistence stay on `deferred.md`. A later milestone reinstates them.
- **Bash ↔ `fs/*` write coordination.** External agents using `fs/*`
  alongside the built-in bash tool have no arbitration today; a lease
  or versioning layer is deferred.
- **Cross-volume move/copy semantics.** `bash mv` across mount points
  falls back to read+write in ZenFS — acceptable given the scale we
  target in M2.

## Test surface

- Vitest: `packages/web-acp/src/agent/system-prompt.test.ts`,
  `packages/web-acp/src/vault/fsa-handle-store.test.ts`,
  `packages/web-acp/src/agent/volume-mount.test.ts`,
  `packages/web-acp/src/acp/fs-handlers.test.ts`,
  `packages/web-acp/src/acp/fs-handlers.integration.test.ts`.
- Playwright: `packages/web-acp/e2e/volumes.spec.ts` — seeds two
  volumes, removes one, reloads, and prompts the LLM to verify the
  description-laden system prompt reached the model.

## Change procedure

Any change to `packages/web-acp/src/vault/*`,
`packages/web-acp/src/agent/volume-*.ts`,
`packages/web-acp/src/acp/fs-handlers.ts`,
`packages/web-acp/src/hooks/useVolumes.ts`, or
`packages/web-acp/src/components/volumes/*` must update this file in
the same commit.
