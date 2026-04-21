# worker-bodhi

**Source of truth:** `packages/web-agent/src/worker-bodhi/`

**Status:** living document — update as part of any plan that changes the source folder.

## Purpose

`worker-bodhi` is the concrete, Bodhi-specific LLM auth implementation that plugs into the generic [`worker-agent`](../worker-agent/index.md) runtime. It is intentionally the **only** place in the worker stack that knows anything about Bodhi's authentication scheme, base URLs, or provider semantics.

The split mirrors the generic / concrete pattern used in `packages/agent/` and `packages/coding-agent/`:

- `worker-agent/` declares interfaces (`LlmAuthProvider`, `LlmAuthCredential`, `createStreamFn`) and consumes them.
- `worker-bodhi/` implements `LlmAuthProvider` for Bodhi.

When `worker-agent` graduates into a standalone library, `worker-bodhi` stays with the host app (or becomes a sibling adapter package) and ships as the default provider for Bodhi-backed hosts.

## Navigation

| File | Scope |
| --- | --- |
| [`bodhi-auth-provider.md`](./bodhi-auth-provider.md) | `BodhiAuthProvider` class — state, methods, constants, tests. |
| [`integration.md`](./integration.md) | Boot wiring, RPC rotation path, per-request resolution, extension scenarios. |

## Overview

### Scope in

1. A concrete `LlmAuthProvider` implementation (`BodhiAuthProvider`) suitable for the worker-agent boot sequence.
2. A public provider tag (`BODHI_PROVIDER_TAG = 'bodhi'`) used by both sides of the RPC boundary to label credentials.
3. Acceptance and storage of rotating access tokens delivered via `LlmAuthCredential` envelopes.
4. Per-request auth resolution returning an `apiKey` that pi-ai's built-in per-format provider code places into the correct HTTP header (OpenAI `Authorization: Bearer`, Anthropic `x-api-key`, Gemini key param).

### Scope out

1. OAuth 2.1 flow — performed on the main thread before the credential reaches this provider.
2. Token refresh, revocation, expiry, or retry policies.
3. Base-URL selection per API format (pi-ai resolves this off the `Model<Api>` catalog; the host seeds that catalog).
4. Main-thread state (React hooks, the Bodhi JS client, local storage).
5. Non-Bodhi providers — those live in sibling packages with their own `provider` tag.

### Actors & integration points

- **Worker boot** (`worker-agent/worker/agent-worker.ts`, `worker-agent/worker/boot.ts`): instantiates `BodhiAuthProvider`, passes it to `createStreamFn` and `WorkerAgentHost`.
- **Main-thread host** (`packages/web-agent/src/hooks/useAgent.ts`): constructs an `LlmAuthCredential` envelope tagged `provider: 'bodhi'` and pushes it through `rpcClient.setAuthToken` on every auth state change.
- **Worker RPC dispatch** (`worker-agent/rpc/rpc-server.ts`): forwards `set_auth_token` commands to `WorkerAgentHost.setAuthToken`, which delegates to `BodhiAuthProvider.setAuthToken`.
- **pi-ai**: receives the resolved `apiKey` and composes the correct per-format auth header. `worker-bodhi` never constructs an auth header itself.

### Folder layout

```
packages/web-agent/src/worker-bodhi/
├── index.ts                      # public barrel
├── bodhi-auth-provider.ts        # BodhiAuthProvider + BODHI_PROVIDER_TAG
└── bodhi-auth-provider.test.ts   # unit tests
```

### Public surface

`worker-bodhi/index.ts` re-exports exactly two names:

- `BodhiAuthProvider` — the concrete provider class.
- `BODHI_PROVIDER_TAG` — the string constant `'bodhi'`.

Detail in [`bodhi-auth-provider.md`](./bodhi-auth-provider.md).

## Global guarantees & invariants

1. **Sole Bodhi entry point in the worker runtime.** No other file under `packages/web-agent/src/worker-agent/` may reference Bodhi; no other file under `packages/web-agent/src/worker-bodhi/` may exist unless it is part of the provider implementation.
2. **Interface conformance.** `BodhiAuthProvider` satisfies `LlmAuthProvider` from `worker-agent/llm/types.ts`; the worker's type system enforces this at build time.
3. **Tag isolation.** A credential tagged for a different provider never leaks into Bodhi's state — instead it clears whatever Bodhi was holding. Multiple auth providers can share a single `set_auth_token` RPC channel without collision.
4. **No header synthesis.** `worker-bodhi` must not construct `Authorization: Bearer` or similar headers manually. The resolved `apiKey` is the only auth surface; per-format header placement is pi-ai's job.
5. **Browser-Worker-safe.** No React, no `@bodhiapp/bodhi-js-react`, no `window`-only APIs. Main-thread Bodhi integration lives elsewhere (the `useAgent` hook).

## Non-goals

- Exposing Bodhi-specific routing (`/v1`, `/anthropic/v1`, `/v1beta`). That lives on the `Model<Api>` entries in the catalog the host seeds; this provider is oblivious.
- Caching or reusing tokens across sessions — a fresh rotation is expected on every main-thread auth state change.

## Change procedure

Any plan that modifies files under `packages/web-agent/src/worker-bodhi/` MUST include an explicit task to update the matching topic file(s) in this folder. State that task in the plan, not as a follow-up. When the functional/technical surface is unchanged (pure internal refactor), state that explicitly rather than skipping the check.

Editing checklist:

1. Identify which topic file(s) cover the affected code.
2. Update content in the same PR as the code change.
3. If a new module is added (e.g. additional provider files), create a new topic file and link it from this `index.md`.
4. Changes that alter the public exports (`BodhiAuthProvider`, `BODHI_PROVIDER_TAG`) also require verifying the consumers listed in [`integration.md`](./integration.md).

See `CLAUDE.md § Functional specs` for the hard rule.
