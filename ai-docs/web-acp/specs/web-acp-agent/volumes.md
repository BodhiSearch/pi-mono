# Volumes — `VolumeInit`, `VolumeRegistry`, `ZenfsVolumeRegistry`

**Source of truth (agent package):** `packages/web-acp-agent/src/agent/volume-registry.ts`.

## Why `startAgent` takes the registry, not volumes

ZenFS keeps a process-global mount table (`@zenfs/core@2.5.6` —
`dist/vfs/shared.js` `mounts: Map`; tracked upstream at
[zen-fs/core#218](https://github.com/zen-fs/core/issues/218)). Two
`ZenfsVolumeRegistry` instances in one process call
`configure({ mounts: {} })` against the same global map, clobbering
each other's mounts; two registries also collide on duplicate paths
like `/mnt/cwd`. The earlier `startAgent({ volumes })` shape always
news a fresh registry, so multi-connection hosts (e.g.
`ws-acp-client`, with one WebSocket per accepted browser tab) had to
fall back to the agent's internal `assembleServices` /
`AcpAgentAdapter` surface (now hidden behind `/test-utils`) to share
one registry.

The current API takes a **required** `registry: VolumeRegistry`.
Hosts construct the registry, pre-mount whatever they want, and pass
the same instance into every `startAgent` call. `startAgent` never
mounts, unmounts, or disposes the registry — host owns its
lifecycle. Making `registry` mandatory removes any borrowed-vs-owned
ambiguity: there is exactly one mount surface and the host always
holds it.

`ZenfsVolumeRegistry.#ensureZenfs()` carries a process-wide
`zenfsConfiguredGlobally` guard so a second registry that is
accidentally constructed (typically in tests) cannot re-`configure`
the global VFS and clobber the first registry's mounts. Production
hosts should still own a single shared registry.

**Per-session isolation** — each session seeing only its own
`/mnt/<sid>/...` — is **not implemented**. Tracked at
[`packages/web-acp-agent/TECHDEBT.md`](../../../../packages/web-acp-agent/TECHDEBT.md).

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

## `VolumeInit` — `volume-registry.ts`

```ts
interface VolumeInit {
    mountName: string;       // visible at /mnt/<mountName>
    description?: string;    // shown in system prompt + UI
    fs: FileSystem;          // pre-constructed ZenFS FS
    initialize?: () => Promise<void>;  // optional post-mount hook
    tags?: readonly string[];          // free-form labels (see below)
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
- `tags` is a free-form `string[]`. The registry deduplicates
  duplicate values on mount and freezes the resulting array.
  The agent itself never interprets tag values; consumers
  (extension installer, future skill loader) call
  `VolumeRegistry.findByTag(tag)` to locate the volume they
  want. See [tag taxonomy](#tag-taxonomy) below.

## `VolumeRegistry` interface — `volume-registry.ts`

```ts
interface VolumeRegistry {
    mountAll(initial: VolumeInit[]): Promise<void>;
    mount(init: VolumeInit): Promise<void>;
    unmount(mountName: string): Promise<void>;
    list(): VolumeSnapshot[];
    firstMountName(): string | undefined;
    findByTag(tag: string): VolumeSnapshot | undefined;
    onChange(listener: VolumeRegistryListener): () => void;
}
```

`VolumeSnapshot`: `{ mountName, description?, tags: readonly
string[] }`. `tags` is **always** present (empty array when no
tags were declared); the wire mapping in
`acp/engine/ext-methods/volumes-list.ts:volumesList` omits the
field from JSON payloads when empty.

`findByTag(tag)` returns the first snapshot whose `tags`
includes `tag`, or `undefined`. Iteration order matches
`list()` (insertion order). The listener fires after every
state transition with a fresh array snapshot.

Consumers in the engine layer:

- `acp/engine/session-runtime.ts:refreshAvailableCommands`
  reads `services.registry.list()` to find vault command
  sources.
- `acp/engine/prompt-driver.ts:#runTurn` reads
  `registry.list()` for `composeSystemPrompt(volumes)` and
  gates the bash tool on `volumes.length > 0`.
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

| Method | Behaviour |
| --- | --- |
| `mountAll(initial)` | Sequential `mount(init)` per entry. Errors are caught and logged (`console.error`); the next mount still runs. The agent stays available even when one volume backend fails. |
| `mount(init)` | Throws on duplicate `mountName`. Otherwise `await #ensureZenfs()`, `mount('/mnt/' + mountName, init.fs)`, `await init.initialize?.()`, populate `#volumes` with deduplicated `init.tags`, fire listeners. |
| `unmount(mountName)` | No-op when unknown. Otherwise `umount('/mnt/' + mountName)` (catching failures and logging via `console.warn`), drop from `#volumes`, fire listeners. |
| `list()` | Snapshot copy via `[...#volumes.values()]`. |
| `firstMountName()` | Returns the first key in insertion order, or `undefined`. |
| `findByTag(tag)` | First match in insertion order, or `undefined`. |
| `onChange(listener)` | Registers + returns an unregister function. |

Listener invocation (`#notify`) catches each listener's
exception so a buggy listener can't break the registry.

## Tag taxonomy

`agent/well-known-volume-tags.ts` exports the agent's own
vocabulary as `WELL_KNOWN_VOLUME_TAGS` (re-exported from the
public barrel):

| Constant | Wire value | Consumer |
| --- | --- | --- |
| `AGENT_WD` | `"agent-wd"` | `/extension add` unpack target (M6 phase 13). At most one volume should carry this tag. |
| `CWD` | `"cwd"` | Default cwd for the bash tool. |
| `DATA` | `"data"` | Read-only user data (skill manifests, prompt-template libraries — M7). |

Hosts and extensions SHOULD reach for these constants instead
of literal strings; private tags are still fine.

The host owns tag assignment policy. The browser host
(`packages/web-acp/`) plumbs tags through the
`HostVolumeInit.tags` and `VolumeSeed.tags` fields; persisted
FSA records carry `tags?` on `VolumeHandleRecord` and the
`useVolumes` hook merges them into the worker's
`VolumeInit.tags` on every boot. See
[`../web-acp-client/volumes.md`](../web-acp-client/volumes.md)
§ "Tags".

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
turn picks it up automatically:
`prompt-driver.ts:#runTurn` reads `registry.list()` afresh for
the system prompt and the bash tool's `MountableFs`. Vault-sourced commands also reload from
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
