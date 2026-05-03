# Transport — `MessagePort` byte-stream bridge + worker boot shim

**Source of truth:** `packages/web-acp/src/runtime/transport/worker-stream.ts`
+ `packages/web-acp/src/agent/agent-worker.ts`.

## Purpose

Bridges a browser `MessagePort` into the byte-stream pair
`@bodhiapp/web-acp-agent`'s `startAcpAgent` consumes. Two
files live in this layer — the stream adapter and the Worker
boot shim that uses it.

## `createMessagePortStream` — `runtime/transport/worker-stream.ts:12`

```ts
function createMessagePortStream(port: MessagePort): PortByteStream;

interface PortByteStream {
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
}
```

Both ends of the ACP connection (main thread + Worker) wrap
the same `MessagePort` shape with this helper. The agent
SDK's `ndJsonStream(writable, readable)` consumes the same
`{ readable, writable }` shape it would use over stdio — the
two transports are wire-equivalent.

### Readable (`:13`)

`new ReadableStream<Uint8Array>` with a `start(controller)`
that:

- Sets `port.onmessage` to enqueue chunks. Three input shapes
  accepted: `Uint8Array` (verbatim), `ArrayBuffer` (wrapped in
  a `Uint8Array`), and `string` (`TextEncoder().encode`). The
  agent always sends `Uint8Array`, but accepting strings keeps
  the bridge useful for ad-hoc debugging.
- Sets `port.onmessageerror` to error the controller.
- Calls `port.start()` — the port is in *paused* mode by
  default; the bridge owns the start. Callers must not call
  `port.start()` themselves.

`cancel()` clears handlers + `port.close()`.

### Writable (`:37`)

`new WritableStream<Uint8Array>` with `write(chunk)` that:

- Allocates a fresh `Uint8Array(chunk.byteLength)` and copies
  the chunk into it. **This per-chunk copy is intentional.**
  The caller's buffer might be reused on the next `write`,
  but `port.postMessage(out, [out.buffer])` *transfers* the
  buffer (zero-copy) — if we transferred the caller's buffer
  it would be detached on their side.
- Posts via `port.postMessage(out, [out.buffer])` — the
  transferable list. The receiving side gets a brand-new
  `Uint8Array` over the same memory; sender side observes
  the buffer detached.

`close()` / `abort()` close the port.

## Worker boot shim — `agent/agent-worker.ts`

The single file remaining in `packages/web-acp/src/agent/`.
~75 lines. It exists to:

1. Expose the `init` message contract the main thread posts
   into.
2. Convert host-shaped artefacts into the agent package's
   shapes.
3. Call `startAcpAgent` from `@bodhiapp/web-acp-agent`.

### Init message — `agent-worker.ts:21`

```ts
interface AgentWorkerInitMessage {
    type: 'init';
    agentPort: MessagePort;
    volumes?: HostVolumeInit[];
}
```

`agentPort` is `port2` of a `MessageChannel` constructed in
`acp/runtime.ts:ensureRuntime`; `port1` stays on the main
thread for the `ClientSideConnection`. `volumes` is the
host-shape array (FSA handle | seed) that
`runtime/volumes-fsa/backends.ts:toAgentVolumeInit` converts
into the agent's `VolumeInit { fs, initialize? }`.

### Build-time constants

The worker reads three Vite-injected globals and forwards
them as `startAcpAgent` options (the agent package can't see
Vite's `define` directly):

- `__WEB_ACP_DEV__` → `isDev: boolean` — gates the agent's
  DEV-only feature checks.
- `__WEB_ACP_VERSION__` → `buildVersion: string` — surfaced
  by `/version`.
- `__ACP_SDK_VERSION__` → `acpSdkVersion: string` — also
  surfaced by `/version`.

Each guard `typeof X === 'string' ? X : 'unknown'` keeps the
file buildable outside Vite (e.g. vitest's transform path
has the defines, but TypeScript language servers without the
Vite plugin don't).

### Boot sequence — `agent-worker.ts:54`

```
startAgent(port, hostVolumes):
  1. transport = createMessagePortStream(port)
  2. provider = new BodhiProvider()
  3. streamOverrides = { current: {} }     // mutable holder
  4. inline = createInlineAgent(
         createStreamFn(provider, () => consume-and-clear streamOverrides)
     )
  5. db = openSessionDb()                  // Dexie SessionStoreDb
  6. registry = new ZenfsVolumeRegistry()
  7. attachVolumeChannel(scope, registry)  // raw-postMessage sidechannel
  8. initialVolumes = await Promise.all(hostVolumes.map(toAgentVolumeInit))
  9. await registry.mountAll(initialVolumes)
 10. services = assembleServices({
        inline, bodhi: provider, store: createStoreFromDb(db),
        registry, features: createFeatureStore(db),
        mcpToggles: createMcpToggleStore(db), streamOverrides,
     })
 11. startAcpAgent(transport, services, { isDev, buildVersion, acpSdkVersion })
```

All steps are synchronous except the volume mount (step 9)
and the per-`HostVolumeInit` `toAgentVolumeInit` conversions
(step 8 — async because `WebAccess.create` resolves a real
FSA handle). The ACP connection comes online as soon as
`startAcpAgent` returns — the volumes are mounted *before*
that so the first `prompt` turn already sees them.

### One-shot `init`

The shim ignores subsequent `init` messages (`:46`):

```ts
if (initialized) {
    console.warn('[agent-worker] received duplicate init message; ignoring.');
    return;
}
```

This is defensive — `acp/runtime.ts:ensureRuntime` only posts
once per tab, but StrictMode-driven double-mount could
accidentally fire it twice without the guard.

## Volume-control sidechannel

The same Worker scope handles two distinct message shapes:

- ACP wire (NDJSON `Uint8Array` chunks) over `agentPort`'s
  `MessagePort`.
- **Volume mount/unmount commands** (`{ type: 'volumes/mount',
  ... }`) over the *raw* worker `self.addEventListener('message')`
  channel.

The two channels are separate by necessity: FSA
`FileSystemDirectoryHandle` is **structured-cloneable but not
JSON-serialisable**, so it can't ride the NDJSON wire. The
volume-control sidechannel uses raw `postMessage` with the
handle as a transferable.

`runtime/volumes-fsa/volume-channel.ts:attachVolumeChannel(scope,
registry)` (called at boot step 7) registers the listener.
It rejects messages whose `type` doesn't match
`volumes/mount` / `volumes/unmount` so the two channels
coexist on the same `self.addEventListener('message')` event.
See [`volumes.md`](./volumes.md) for the full contract.

## Why one transport per tab

The pattern `runtime/transport/worker-stream.ts` provides is
shape-only — there's nothing browser-specific about
`PortByteStream` itself. The CLI host's
`packages/cli-acp-client/src/acp/duplex.ts:createInMemoryDuplex`
returns the same `PortByteStream` shape using two
`TransformStream` pairs joined head-to-tail. Both hosts
hand the result to `startAcpAgent`, which then frames
`ndJsonStream` over either bridge. This is the proof point
that "transport is swappable" lives in the agent package's
boundary, not in the host.

## Cross-references

- Agent boot entry consumed:
  [`../web-acp-agent/index.md`](../web-acp-agent/index.md) §
  bootstrap; full flow at
  [`../web-acp-agent/startup-sequence.md`](../web-acp-agent/startup-sequence.md).
- Volume-control sidechannel:
  [`volumes.md`](./volumes.md).
- Browser-host startup flow:
  [`startup-sequence.md`](./startup-sequence.md).
- CLI host's transport reference (in-memory duplex):
  [`../cli-acp-client/index.md`](../cli-acp-client/index.md).
