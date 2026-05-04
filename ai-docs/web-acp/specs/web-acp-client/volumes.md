# Volumes — FSA host shape, conversion, control channel, IDE seam

**Source of truth:** `packages/web-acp/src/runtime/volumes-fsa/`,
`packages/web-acp/src/vault/`, `packages/web-acp/src/hooks/useVolumes.ts`.

## Purpose

The browser host owns:

- The **FSA-shaped volume init type** (`HostVolumeInit`) the
  React layer constructs.
- The **conversion** from `HostVolumeInit` (FSA handle | seed)
  to the agent package's `VolumeInit { fs, initialize? }`.
- The **persistence** of FSA handles in IndexedDB (`idb-keyval`)
  with permission re-grant on reload.
- The **volume-control sidechannel** that carries FSA handles
  between the main thread and the worker (the ACP NDJSON wire
  can't carry handles because they're not JSON-serialisable).
- The **`useVolumes` React hook** that drives the picker UI.

The duplicate main-thread `MainZenfs` mirror that backed the
`fs/*` IDE-integration seam was removed in the "adaptive plum"
simplification — the worker's `ZenfsVolumeRegistry` is now the
only mount.

Agent-side counterparts (interface + ZenFS-backed registry)
live at [`../web-acp-agent/volumes.md`](../web-acp-agent/volumes.md).

## `HostVolumeInit` — `runtime/volumes-fsa/types.ts`

```ts
interface HostVolumeInit {
    mountName: string;
    description?: string;
    handle?: FileSystemDirectoryHandle;
    seed?: VolumeSeed;
}

interface VolumeSeed {
    name: string;
    description?: string;
    files: Record<string, string>;     // path → utf-8 content
}
```

Exactly one of `handle` / `seed` must be set. The handle path
is the production case (real FSA mount); the seed path is
dev/test injection via `window.__zenfsSeed` (Playwright +
DevTools tinkering).

## Backend conversion — `runtime/volumes-fsa/backends.ts`

`toAgentVolumeInit(host)` (`:16`) converts a `HostVolumeInit`
into the agent's `VolumeInit`. Branches on which of
`handle` / `seed` is present:

- **Handle**: `await WebAccess.create({ handle: host.handle })`
  → `{ mountName, description?, fs: <WebAccess FileSystem> }`.
  The agent mounts the FS directly; reads / writes hit the
  user's actual disk through the FSA backend.
- **Seed**: `InMemory.create({ label: seed.name })` →
  `{ mountName, description?, fs: <InMemory FileSystem>,
  initialize: () => seedInMemoryBackend('/mnt/<mountName>',
  seed) }`. The post-mount `initialize` hook writes the
  seed files via `@zenfs/core`'s global `fs.promises.*` so
  the agent's `mount(mountPath, fs)` finishes synchronously
  and the seeding happens after the path is registered.
- Neither: throws `'Volume <mountName> needs either a handle or a seed'`.

`seedInMemoryBackend` (`:38`) walks the sorted seed keys,
ensures parent directories exist (via recursive `mkdir`), and
writes UTF-8 content. The path-join helper handles both
`/mnt/<name>/file.txt` and `/file.txt`-relative seed keys.

This is the *only* place `@zenfs/dom` is imported in the host
runtime — the agent package depends only on `@zenfs/core`,
keeping the agent host-neutral.

## Volume-control sidechannel — `runtime/volumes-fsa/volume-channel.ts` + `volume-control.ts`

FSA `FileSystemDirectoryHandle` is structured-cloneable but
**not JSON-serialisable**, so it can't ride the ACP NDJSON
wire. The host uses a separate raw-postMessage sidechannel
on the worker's global scope.

### Wire shapes — `volume-channel.ts:14`

```ts
type VolumeControlRequest =
  | { type: 'volumes/mount';   id: string; init: HostVolumeInit }
  | { type: 'volumes/unmount'; id: string; mountName: string };

type VolumeControlReply =
  | { type: 'volumes/mount:reply';   id: string; ok: boolean; mountName: string; error? }
  | { type: 'volumes/unmount:reply'; id: string; ok: boolean; mountName: string; error? };
```

Correlation via `id` (UUID per call); both ends ignore messages
with unknown `type` so the sidechannel coexists with the ACP
init handshake on the same `self.addEventListener('message')`
in the worker.

### Worker side — `attachVolumeChannel(scope, registry)` — `volume-channel.ts:57`

Registers a `message` listener on the worker's global scope.
On `volumes/mount`:

1. `await toAgentVolumeInit(msg.init)`.
2. `await registry.mount(agentInit)` — calls into the agent's
   `ZenfsVolumeRegistry`.
3. Reply with `{ ok: true, mountName }` on success or
   `{ ok: false, error }` on failure.

On `volumes/unmount`: `await registry.unmount(mountName)`,
reply.

Returns the unregister function (`scope.removeEventListener`).
Called once per worker boot from inside `agent-worker.ts`'s
top-level `init`-message handler (the worker is a classic
`self.addEventListener('message', ...)` — there is no
exported `startAgent` entry point).

### Main side — `createVolumeControl(worker)` — `volume-control.ts:23`

Returns `VolumeControl { mount(init), unmount(mountName),
dispose() }`. Implementation:

- Wraps `worker.postMessage` with a UUID correlation scheme
  (`pending: Map<string, { resolve, reject }>`).
- `mount` and `unmount` return promises that resolve when the
  matching `:reply` arrives; reject with the error on `ok: false`.
- `dispose()` removes the listener and rejects every pending
  promise with `'volume-control disposed'`.

## FSA handle persistence — `vault/fsa-handle-store.ts`

`VolumeHandleRecord` (`:19`) — `{ handle, mountName,
description? }`. Persisted to IndexedDB via `idb-keyval`
under the key `'web-acp:volumes'` (chosen to avoid collision
with the legacy `web-agent` key on the same origin).

Key functions:

- `loadHandles()` (`:25`) — read array; filter out malformed
  records (records where `mountName` isn't a string or
  `handle` is missing). Returns `[]` on any read error.
- `saveHandles(records)` (`:35`) — full replace. Empty array
  → `del(VOLUMES_IDB_KEY)`. The `try/catch` swallows write
  errors with a `console.warn` because Playwright's handle
  objects (POJOs injected via `__zenfsSeed`) aren't
  structured-cloneable for `idb-keyval` — tests drive
  persistence through the init script directly.
- `clearHandles()` (`:55`) — `del(VOLUMES_IDB_KEY)`.
- `requestPermissions(records)` (`:76`) — re-requests
  `readwrite` permission on every persisted handle. Returns
  two buckets:
  - `ready` — permission `'granted'` (or query failed but
    the handle is usable).
  - `prompt` — permission `'prompt'` or `'denied'`. Caller
    surfaces these in the UI with a "needs access" affordance.
- `deriveUniqueMountName(baseName, existing)` (`:112`) —
  produces a non-colliding mount name. Sanitises via
  `sanitizeMountName` (strips non-`[A-Za-z0-9._-]`,
  collapses runs of `-`, strips leading/trailing `.`/`-`),
  then appends `-1`, `-2`, … if needed. Once a volume is
  removed the name is free again — re-adding the same
  directory right after removing it keeps the original name.

## React hook — `hooks/useVolumes.ts`

`useVolumes({ volumeControl, onInitialVolumes })` —
multi-volume state machine for the picker UI.

State per entry:

```ts
type VolumeState = 'idle' | 'mounting' | 'mounted' | 'prompt' | 'error';

interface VolumeEntry {
    mountName: string;
    description?: string;
    state: VolumeState;
    errorMessage?: string;
    needsPermission: boolean;
}
```

Boot effect (runs once on mount):

1. `loadHandles()` from IDB.
2. `readDevSeeds()` from `window.__zenfsSeed` (DEV-only, gated
   by `import.meta.env.DEV` / `typeof window !== 'undefined'`).
3. `requestPermissions(records)` — partition into `ready` /
   `needsPrompt`.
4. Build `initialEntries: VolumeEntry[]` and `initialMounts:
   HostVolumeInit[]`.
5. `setEntries(initialEntries)` + `onInitialVolumes(initialMounts)`
   — the latter is the callback that drives
   `runtime.resolveInit` (see [`acp.md`](./acp.md) §
   `ensureRuntime`).
6. Optimistically transition `mounting` → `mounted` entries
   in the same async tick (back-to-back `setEntries` calls
   with no await between them). The hook does not read
   volume-control replies. Real per-action state transitions
   come from awaited `volumeControl.mount(...)` /
   `volumeControl.unmount(...)` promises inside `addVolume`
   and `restoreAccess`, which call `patch(name, { state:
   'mounted' | 'error' })`. The boot effect's flip is
   fire-and-hope — it assumes success and leaves error
   handling to per-action callers.

User actions:

- `addVolume(description?)` — calls
  `window.showDirectoryPicker({ mode: 'readwrite' })`,
  derives a unique mount name, optimistically inserts the
  entry as `mounting`, then calls `volumeControl.mount({
  handle, mountName, description })`. On the awaited
  success, appends to `recordsRef.current` and calls
  `saveHandles`. On failure, flips the entry to `'error'`
  but does **not** mutate `recordsRef.current` and does
  **not** call `saveHandles` — the failed entry is
  in-memory only, so a tab reload sees no record of the
  failed attempt.
- `removeVolume(mountName)` — `volumeControl.unmount(mountName)`,
  drops the record + entry.
- `setDescription(mountName, description)` — patches the
  record + entry; re-persists.
- `restoreAccess(mountName)` — re-requests permission on a
  `prompt`-state entry. On grant, transitions to `mounting`
  → `mounted` and calls `volumeControl.mount(...)`.

Returns `{ entries, ready, addVolume, removeVolume,
setDescription, restoreAccess }`.

`readDevSeeds()` (`:59`) reads `window.__zenfsSeed` and
returns either `[]` (when absent) or the array form (single
seed → `[seed]`, array → as-is). The hook merges seeds with
persisted handles into `initialMounts`.

## Cross-references

- Agent-side interface + `ZenfsVolumeRegistry`:
  [`../web-acp-agent/volumes.md`](../web-acp-agent/volumes.md).
- Worker boot that calls `attachVolumeChannel`:
  [`transport.md`](./transport.md).
<!-- IDE-integration fs/* handlers were removed in the
"adaptive plum" simplification; see acp.md § "fs/* and
permissions — removed". -->
- React hook composition:
  [`hooks.md`](./hooks.md).
- E2E priming via `useDevSeedBoot`:
  [`startup-sequence.md`](./startup-sequence.md).
