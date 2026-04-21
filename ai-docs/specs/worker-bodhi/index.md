# worker-bodhi

**Source of truth:** `packages/web-agent/src/worker-bodhi/`

**Status:** living document — update as part of any plan that changes the source folder.

## Purpose

`worker-bodhi` is the concrete, Bodhi-specific `LlmProvider` implementation
that plugs into the generic [`worker-agent`](../worker-agent/index.md)
runtime. It is intentionally the **only** place in the worker stack that
knows anything about Bodhi's authentication scheme, base URLs, catalog
endpoint, or per-format model metadata.

The split mirrors the generic / concrete pattern used in `packages/agent/`
and `packages/coding-agent/`:

- `worker-agent/` declares interfaces (`LlmProvider`, `LlmAuthCredential`,
  `createStreamFn`) and consumes them.
- `worker-bodhi/` implements `LlmProvider` for Bodhi — both the auth surface
  (`getApiKeyAndHeaders`, `setAuthToken`) and the model catalog surface
  (`getAvailableModels`).

When `worker-agent` graduates into a standalone library, `worker-bodhi`
stays with the host app (or becomes a sibling adapter package) and ships as
the default provider for Bodhi-backed hosts.

## Navigation

| File | Scope |
| --- | --- |
| [`bodhi-provider.md`](./bodhi-provider.md) | `BodhiProvider` class — state, methods, catalog mapping, tests. |
| [`integration.md`](./integration.md) | Boot wiring, RPC rotation path, catalog fetch path, per-request resolution, extension scenarios. |

## Overview

### Scope in

1. A concrete `LlmProvider` implementation (`BodhiProvider`) suitable for
   the worker-agent boot sequence.
2. A public provider tag (`BODHI_PROVIDER_TAG = 'bodhi'`) used by both
   sides of the RPC boundary to label credentials.
3. Acceptance and storage of rotating access tokens delivered via
   `LlmAuthCredential` envelopes.
4. Per-request auth resolution returning an `apiKey` that pi-ai's
   built-in per-format provider code places into the correct HTTP header
   (OpenAI `Authorization: Bearer`, Anthropic `x-api-key`, Gemini key
   param).
5. On-demand fetching of `/bodhi/v1/models` and flattening the response
   into `Model<Api>[]` across all supported `api_format` variants, with
   accurate per-variant metadata extraction.

### Scope out

1. OAuth 2.1 flow — performed on the main thread before the credential
   reaches this provider.
2. Token refresh, revocation, expiry, or retry policies.
3. Catalog caching — each `getAvailableModels()` call re-fetches from the
   server. Upstream callers cache if they need to.
4. Main-thread state (React hooks, the Bodhi JS client, local storage).
5. Non-Bodhi providers — those live in sibling packages with their own
   `provider` tag.

### Actors & integration points

- **Worker boot** (`worker-agent/worker/agent-worker.ts`,
  `worker-agent/worker/boot.ts`): instantiates `BodhiProvider`, passes it
  to `createStreamFn` and `WorkerAgentHost`.
- **Main-thread host** (`packages/web-agent/src/hooks/useAgent.ts`):
  constructs an `LlmAuthCredential` envelope tagged `provider: 'bodhi'`
  and pushes it through `rpcClient.setAuthToken` on every auth state
  change. Reads the model catalog by calling
  `rpcClient.getAvailableModels()` which the worker services by delegating
  to this provider.
- **Worker RPC dispatch** (`worker-agent/rpc/rpc-server.ts`): forwards
  `set_auth_token` commands to `WorkerAgentHost.setAuthToken` (→
  `BodhiProvider.setAuthToken`) and `get_available_models` commands to
  `WorkerAgentHost.getAvailableModels` (→
  `BodhiProvider.getAvailableModels`).
- **pi-ai**: receives the resolved `apiKey` and composes the correct
  per-format auth header. `worker-bodhi` never constructs the streaming
  auth header itself.

### Folder layout

```
packages/web-agent/src/worker-bodhi/
├── index.ts                 # public barrel
├── bodhi-provider.ts        # BodhiProvider + BODHI_PROVIDER_TAG + catalog mapping
└── bodhi-provider.test.ts   # unit tests (auth + catalog)
```

### Public surface

`worker-bodhi/index.ts` re-exports exactly two names:

- `BodhiProvider` — the concrete provider class.
- `BODHI_PROVIDER_TAG` — the string constant `'bodhi'`.

Detail in [`bodhi-provider.md`](./bodhi-provider.md).

## Global guarantees & invariants

1. **Sole Bodhi entry point in the worker runtime.** No other file under
   `packages/web-agent/src/worker-agent/` may reference Bodhi; no other
   file under `packages/web-agent/src/worker-bodhi/` may exist unless it
   is part of the provider implementation.
2. **Interface conformance.** `BodhiProvider` satisfies `LlmProvider` from
   `worker-agent/llm/types.ts`; the worker's type system enforces this at
   build time.
3. **Tag isolation.** A credential tagged for a different provider never
   leaks into Bodhi's state — instead it clears whatever Bodhi was
   holding. Multiple providers can share a single `set_auth_token` RPC
   channel without collision.
4. **No streaming-header synthesis.** `worker-bodhi` must not construct
   `Authorization: Bearer` or similar headers for the streaming path
   manually. The resolved `apiKey` is the only auth surface;
   per-format header placement is pi-ai's job. (The catalog fetch does
   set its own `Authorization: Bearer`, but that traffic never leaves
   `BodhiProvider.getAvailableModels`.)
5. **Browser-Worker-safe.** No React, no `@bodhiapp/bodhi-js-react`
   runtime, no `window`-only APIs. Type-only imports from
   `@bodhiapp/bodhi-js-react/api` are allowed. Main-thread Bodhi
   integration lives elsewhere (the `useAgent` hook).

## Non-goals

- Exposing Bodhi-specific routing beyond the catalog response's
  per-format `baseUrl` derivation. pi-ai drives the final per-format
  path suffix.
- Caching or reusing tokens / catalogs across sessions — a fresh
  rotation is expected on every main-thread auth state change, and each
  `getAvailableModels()` call is a fresh fetch.

## Change procedure

Any plan that modifies files under `packages/web-agent/src/worker-bodhi/`
MUST include an explicit task to update the matching topic file(s) in this
folder. State that task in the plan, not as a follow-up. When the
functional/technical surface is unchanged (pure internal refactor), state
that explicitly rather than skipping the check.

Editing checklist:

1. Identify which topic file(s) cover the affected code.
2. Update content in the same PR as the code change.
3. If a new module is added (e.g. additional provider files), create a
   new topic file and link it from this `index.md`.
4. Changes that alter the public exports (`BodhiProvider`,
   `BODHI_PROVIDER_TAG`) also require verifying the consumers listed in
   [`integration.md`](./integration.md).

See `CLAUDE.md § Functional specs` for the hard rule.
