# transport

**Source of truth (agent — `packages/web-acp-agent/src/`):**
`bootstrap.ts` — `startAcpAgent(transport, services, options)`.
The agent package defines the `AcpTransport` interface
(`{ readable, writable }` byte-stream pair) and the
`ndJsonStream` framing happens here; the host hands over a
transport pair and stays out of the framing entirely.

**Source of truth (browser host — `packages/web-acp/src/`):**
`runtime/transport/worker-stream.ts` — `createMessagePortStream`
adapting a `MessagePort` to the WHATWG byte-stream pair the
agent's `startAcpAgent` consumes.

**Source of truth (CLI host — `packages/cli-acp-client/src/`):**
`acp/duplex.ts` — `createInMemoryDuplex` joining two
`TransformStream`s head-to-tail to give the agent and the
client an in-process duplex byte-stream pair. No network,
no `MessagePort`, no socket: a deliberate proof point that
the framing is transport-agnostic.

**Parent:** [`./index.md`](./index.md)

## Functional scope

Today the transport layer is a single file — `worker-stream.ts` —
containing `createMessagePortStream`. It bridges a `MessagePort`
to the `{readable: ReadableStream<Uint8Array>, writable:
WritableStream<Uint8Array>}` shape that
`@agentclientprotocol/sdk`'s `ndJsonStream` consumes.

Why this layer exists:

- The ACP SDK was designed around stdio: it consumes two
  byte-streams and produces two, runs `ndJsonStream` over them,
  and hands framed JSON-RPC objects to its `ClientSideConnection`
  / `AgentSideConnection`. Reusing the SDK verbatim means
  adapting our `MessagePort`-based channel into that same
  byte-stream shape.
- The `MessagePort` is deliberately kept **byte-oriented**
  (encodes / decodes `Uint8Array`). ACP messages are
  UTF-8-encoded JSON with newline framing; the SDK's parser
  works against bytes. We do **not** send pre-parsed JSON
  across the port — that would mean two layers of framing and
  two chances to drift.

Scope invariants:

- **`port.start()` is called exactly once**, inside
  `createMessagePortStream`. Callers must not call it. Calling
  `start()` twice on a port after it has already been started is
  undefined across browsers.
- **Every write allocates a fresh buffer.** We copy each chunk
  into a new `Uint8Array` and post it with a transfer list
  including the new buffer. This survives structured-clone
  without detaching the caller's buffer mid-write and avoids
  Chrome's "buffer already detached" crash when the same slice
  is queued twice.
- **Close is idempotent.** `close()` and `abort()` both invoke
  `port.close()`; calling either more than once is safe.

## Technical reference

### `createMessagePortStream(port: MessagePort): PortByteStream`

Returns `{readable, writable}`. Setup:

- **Readable.** `new ReadableStream<Uint8Array>({start, cancel})`:
  - `start(controller)`:
    - `port.onmessage = event => {...}` — accepts three shapes
      for maximum compatibility with future sends from the
      browser's `ndJsonStream` implementation:
      - `Uint8Array` → enqueued as-is.
      - `ArrayBuffer` → wrapped with `new Uint8Array(data)`.
      - `string` → encoded via `new TextEncoder().encode(data)`.
      Anything else is silently dropped. This is intentional: the
      port may in theory receive unrelated `postMessage` traffic
      (though in practice our listener is exclusive per port).
    - `port.onmessageerror = event => controller.error(...)` —
      maps a `messageerror` event to a stream error. This
      surfaces structured-clone failures on the far side (e.g.
      trying to send a non-cloneable value).
    - `port.start()` — required on ports obtained from
      `MessageChannel`; without it the port buffers messages
      instead of delivering them. The SDK's `ndJsonStream`
      begins reading immediately, so we must call `start()`
      here rather than lazily in `pull`.
  - `cancel()`:
    - `port.onmessage = null; port.onmessageerror = null;
      port.close()`. Clearing the handlers first prevents a
      late message racing past `close()`.

- **Writable.** `new WritableStream<Uint8Array>({write, close,
  abort})`:
  - `write(chunk)` — allocates a fresh `Uint8Array(chunk.byteLength)`,
    copies via `out.set(chunk)`, then
    `port.postMessage(out, [out.buffer])`. The transfer list
    transfers ownership of the new buffer so the SDK's encoder
    can reuse its own buffer for the next chunk without the
    cross-thread recipient racing against it.
  - `close()` → `port.close()`.
  - `abort()` → `port.close()`. We don't forward the abort
    reason; the far side sees a stream close and surfaces its
    own error through the SDK.

### `PortByteStream`

Just `{readable, writable}`. The type exists so consumers can
name the returned shape; no runtime overhead.

## Usage today

Two call sites, one per side of the channel:

- **Main thread** (`src/hooks/useAcp.ts` → `ensureRuntime`):
  `createMessagePortStream(channel.port1)` → wrapped by
  `ndJsonStream(writable, readable)` → consumed by
  `ClientSideConnection`.
- **Worker** (`src/agent/agent-worker.ts` → `startAgent`):
  `createMessagePortStream(agentPort)` → wrapped by
  `ndJsonStream(writable, readable)` → consumed by
  `AgentSideConnection`.

Both sides run the same code; there is no "client" vs "agent"
asymmetry at the transport layer.

## Tests

No dedicated tests in M0; exercised end-to-end by
`packages/web-acp/e2e/chat.spec.ts`. A vitest-level fake MessageChannel
test is a natural follow-up when we add the second transport
implementation required by the original M0.b gate (see
[`../milestones/m0-foundation.md`](../../milestones/m0-foundation.md)).

## Known edge cases

- **Non-`Uint8Array` sends.** Browsers and Node may surface
  incoming data as either `Uint8Array` or `ArrayBuffer`
  depending on how the sender produced it. The `onmessage`
  handler handles both + `string` for defensiveness; downstream
  callers always see `Uint8Array`.
- **`onmessageerror` events.** Fired when the browser cannot
  structured-clone an incoming message. We surface this as a
  stream error so the SDK can propagate it as a connection
  failure rather than silently dropping the message.
- **Post-close writes.** Writing to a closed port throws. The
  SDK's `WritableStream` contract prevents this in normal flow
  (a stream in `closed` state rejects new writes); we don't
  defend against it explicitly.

## Constraints

- **Byte-oriented only.** Do not teach `createMessagePortStream`
  about JSON. The byte layer + `ndJsonStream` is the framing
  contract; adding a JSON fast-path here would fork the
  protocol.
- **Single use per port.** Calling `createMessagePortStream` on
  a port more than once yields two competing `onmessage`
  handlers; the second overwrites the first and the stream
  breaks. Enforce at the caller level (today: `useAcp` and
  `agent-worker.ts` each call it exactly once).
- **Buffer-allocation discipline.** The `write` callback MUST
  allocate a fresh buffer per chunk. Using the caller's buffer
  directly detaches it on transfer and breaks the next write
  that shares the same underlying `ArrayBuffer`.

## Change procedure

Any plan that touches `packages/web-acp/src/transport/` must
update this file in the same commit. When we add a second
transport (e.g. a test-double `InMemoryChannel` pair for the
M0.b follow-up), create a sibling file
`src/transport/in-memory-stream.ts` and describe it alongside
`worker-stream.ts` in this document, not in a new file — both
are small enough to share a spec.

See [`./index.md` § Change procedure](./index.md#change-procedure).
