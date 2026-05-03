# Volumes — `VolumeInit`, `VolumeRegistry`, `ZenfsVolumeRegistry`

**Source of truth (agent package):** `packages/web-acp-agent/src/agent/volume-registry.ts`.

## Purpose

The agent package owns the **mount lifecycle** for `/mnt/<name>`
volumes: register a backend, mount it, list active mounts, fan
out lifecycle events to the engine. It is **backend-agnostic**:
the host runtime supplies a pre-constructed
`@zenfs/core` `FileSystem` instance per volume; the registry
calls `mount(/mnt/<mountName>, fs)`. This is what lets the same
agent code run with FSA-backed mounts (browser),
`PassthroughFS` over `node:fs` (CLI), and future cloud-backed
mounts (HTTP host).

## `VolumeInit` — `volume-registry.ts:21`

```ts
interface VolumeInit {
    mountName: string;       // visible at /mnt/<mountName>
    description?: string;    // shown in system prompt + UI
    fs: FileSystem;          // pre-constructed ZenFS FS
    initialize?: () => Promise<void>;  // optional post-mount hook
}
```

- `mountName` is the slug. The bash tool refers to mounts at
  `/mnt/<mountName>`; the volume description list in
  `system-prompt.ts:composeSystemPrompt` lists every mount.
- `fs` is a constructed `@zenfs/core` `FileSystem`. The agent
  doesn't know whether it's `WebAccess` (FSA),
  `PassthroughFS` (node), `InMemory` (seeded test), or
  something else.
- `initialize` runs **after** `mount` in the registry. Hosts
  use this to seed `InMemory` backends with dev/test data
  via `@zenfs/core`'s global `fs.promises.*`. Keeps seeding
  logic out of the agent.

## `VolumeRegistry` interface — `volume-registry.ts:46`

```ts
interface VolumeRegistry {
    mountAll(initial: VolumeInit[]): Promise<void>;
    mount(init: VolumeInit): Promise<void>;
    unmount(mountName: string): Promise<void>;
    list(): VolumeSnapshot[];
    firstMountName(): string | undefined;
    onChange(listener: VolumeRegistryListener): () => void;
}
```

`VolumeSnapshot` (`:39`): `{ mountName, description? }`. The
listener fires after every state transition with a fresh array
snapshot.

Consumers in the engine layer:

- `acp/engine/session-runtime.ts:refreshAvailableCommands`
  reads `services.registry.list()` to find vault command
  sources.
- `acp/engine/prompt-driver.ts:run` reads `registry.list()`
  for `composeSystemPrompt(volumes)` and gates the bash tool
  on `volumes.length > 0`.
- `acp/engine/ext-methods/volumes-list.ts:volumesList`
  surfaces the snapshot through `_bodhi/volumes/list`.
- `agent/tools/bash-tool.ts:resolveCwd` calls
  `registry.firstMountName()` to default the shell's working
  directory.
- `agent/tools/bash-tool.ts:buildMountable` calls
  `registry.list()` to compose the per-turn `MountableFs` for
  the bash tool.

## `ZenfsVolumeRegistry` — `volume-registry.ts:55`

The default implementation. Owns:

- `#volumes: Map<string, VolumeSnapshot>` — keyed by
  `mountName`.
- `#listeners: Set<VolumeRegistryListener>`.
- `#zenfsConfigured: boolean` — guards a one-shot
  `await configure({ mounts: {} })` call so subsequent
  `mount(path, backend)` calls land on a known empty VFS
  surface. Idempotent across modules that reset the registry
  (e.g. test setup).

Method behaviour:

| Method | `volume-registry.ts` line | Behaviour |
| --- | --- | --- |
| `mountAll(initial)` | `:60` | Sequential `mount(init)` per entry. Errors are caught and logged (`console.error`); the next mount still runs. The agent stays available even when one volume backend fails. |
| `mount(init)` | `:70` | Throws on duplicate `mountName`. Otherwise `await #ensureZenfs()`, `mount('/mnt/' + mountName, init.fs)`, `await init.initialize?.()`, populate `#volumes`, fire listeners. |
| `unmount(mountName)` | `:87` | No-op when unknown. Otherwise `umount('/mnt/' + mountName)` (catching failures and logging via `console.warn` — note `mountAll` uses `console.error` for the parallel boot path; `unmount` warns because a failed unmount during teardown is recoverable), drop from `#volumes`, fire listeners. |
| `list()` | `:98` | Snapshot copy via `[...#volumes.values()]`. |
| `firstMountName()` | `:102` | Returns the first key in insertion order, or `undefined`. |
| `onChange(listener)` | `:107` | Registers + returns an unregister function. |

Listener invocation (`#notify`, `:121`) catches each
listener's exception so a buggy listener can't break the
registry.

## Why `@zenfs/core`, not `@zenfs/dom`

`@zenfs/dom` ships browser-only backends (`WebAccess`,
`IndexedDB`, etc.); importing it would taint the agent
package's bundle for non-browser hosts. The agent depends only
on `@zenfs/core` (which provides the VFS configuration,
`mount`/`umount`, and the `FileSystem` interface). Hosts that
need a specific backend import the corresponding
`@zenfs/<backend>` package on **their** side and hand a
constructed `FileSystem` to `VolumeInit.fs`.

## Host-side conversion patterns

| Host | Backend factory | File |
| --- | --- | --- |
| Browser (`web-acp`) | `WebAccess` from `@zenfs/dom` (real FSA) or `InMemory` from `@zenfs/core` (dev seed) | `packages/web-acp/src/runtime/volumes-fsa/backends.ts:toAgentVolumeInit`. The `backends.ts` file constructs the backend, optionally chains an `initialize` hook to seed `InMemory`, and returns a host-shaped `HostVolumeInit` → agent's `VolumeInit`. See [`../web-acp-client/volumes.md`](../web-acp-client/volumes.md). |
| Node CLI (`cli-acp-client`) | `PassthroughFS` over `node:fs` rooted at `$cwd` | `packages/cli-acp-client/src/services/cwd-volume.ts:createCwdVolumeInit` + `volume-init.ts:createPathVolumeInit` for additional paths. The CLI also seeds extra `extraVolumes` from `assembleNodeServices(opts)` for tests. |

## Lifecycle events

The agent package does **not** itself ride registry changes
onto the ACP wire — there is no first-class
`session/update` for "volume mounted" today. Hosts that want
to surface mount state to the UI subscribe to `onChange` on
their own. The `_bodhi/volumes/list` extension method
(`acp/engine/ext-methods/volumes-list.ts`) gives the host an
on-demand snapshot when needed.

When a host re-mounts a volume mid-session, the next `prompt`
turn picks it up automatically: `prompt-driver.ts:run` reads
`registry.list()` afresh for the system prompt and the bash
tool's `MountableFs`. Vault-sourced commands also reload from
the new mount on the next `refreshAvailableCommands` call
(typically tied to `session/load`).

Hosts that need runtime mount/unmount drive `registry.mount(init)`
/ `registry.unmount(name)` directly when they share a process
with the agent (e.g. the CLI host in-process). The browser host
runs the agent in a Web Worker and ferries mounts across via a
dedicated `volumes/mount`/`volumes/unmount` raw-postMessage
sidechannel that lives **outside** the ACP stream pair —
the agent itself sees those calls as `registry.mount(...)` /
`registry.unmount(...)` invocations on this same registry. See
[`../web-acp-client/transport.md`](../web-acp-client/transport.md)
§ "Volume-control sidechannel" for the host wire shape.

## Cross-references

- Bash tool that consumes the registry per turn:
  [`tools.md`](./tools.md).
- System prompt that lists volumes:
  [`agent.md`](./agent.md).
- Vault-sourced commands sourced from `<mount>/.pi/commands/`:
  [`commands.md`](./commands.md).
- Browser host backend factory + control-channel wire:
  [`../web-acp-client/volumes.md`](../web-acp-client/volumes.md).
- CLI host `PassthroughFS` setup:
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
