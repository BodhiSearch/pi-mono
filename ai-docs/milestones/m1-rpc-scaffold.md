# M1 — RPC-shaped scaffold

**Status:** ✅ done (`06d02b81`). Test seam: 4 vitest round-trip tests in `src/web-agent/rpc/rpc.test.ts`.

What landed:

- `packages/web-agent/src/web-agent/` tree established.
- `core/agent-session.ts` — thin wrapper over `pi-agent-core`'s `Agent` with a plain-data surface.
- `core/extensions/{types,registry}.ts` — minimal stubs, M8 extends.
- `core/tools/index.ts` — empty stub, M3 populates.
- `rpc/transport.ts` — the `Transport` interface.
- `rpc/transports/in-process.ts` — MessageChannel-backed pair.
- `rpc/rpc-types.ts` — `RpcCommand` / `RpcResponse` / `RpcEventEnvelope` schema.
- `rpc/rpc-server.ts` — dispatcher + exported `AgentSessionHost` interface.
- `rpc/rpc-client.ts` — typed promise + event-subscription client.
- `rpc/rpc.test.ts` — 4 round-trip tests against a fake session.
- `index.ts` — barrel.
- `hooks/useAgent.ts` rewired through `RpcClient`; public hook shape preserved, components untouched.

Surprises worth remembering (also captured inline in code/commit):

- `RpcServer` is retained automatically via the transport's event-listener closure — no module-level variable needed.
- `Omit<Union, K>` is non-distributive and drops per-variant fields; use a `DistributiveOmit` helper.
- `tsc --noEmit` at a package with project-references tsconfig silently checks zero files — use `tsc -b`.
