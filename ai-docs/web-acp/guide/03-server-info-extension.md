# Chapter 3 — Adding `_bodhi/server/info` to the agent

> Goal: extend `@bodhiapp/web-acp-agent` with a new ACP extension
> method that proxies BodhiApp's `/bodhi/v1/info` endpoint. Six small
> edits across five files. By the end the agent itself works; the
> CLI side wires up in Chapter 4.

## 3.1 What the new method does

Wire summary:

```
client ──► extMethod("_bodhi/server/info", {})
agent  ──► BodhiProvider.fetchServerInfo()
       ──► GET ${baseUrl}/bodhi/v1/info
                with Authorization: Bearer <token>
                  ◄── { version, status, url, client_id? }
       ──► returns the response body verbatim
```

Two invariants matter:

1. **No try/catch swallow** — failure throws back to the caller as a
   JSON-RPC error. That's the property that turned us off `newSession`
   in §2.4.
2. **Snake_case preserved** — BodhiApp returns
   `client_id`/`status`/`url`. We pass through unchanged. The wire
   stays a faithful pipe.

## 3.2 The diff in dependency order

The order we edit matters because the schema and handler reference
the wire constant.

### 3.2.1 `wire/index.ts` — constant + response type

`packages/web-acp-agent/src/wire/index.ts`. New entries:

```ts
export const BODHI_SERVER_INFO_METHOD = "_bodhi/server/info";

export interface BodhiServerInfoResponse extends Record<string, unknown> {
  version: string;
  status: string;
  url: string;
  client_id?: string;
}
```

Why this file: it's the single source of truth for `_bodhi/*` method
names. Spec rule (`steering/04-principles.md` §15): every ext method
goes through a named constant, never an inline string at the call
site. Makes upstream renames a one-edit job.

### 3.2.2 `agent/bodhi-provider.ts` — the actual HTTP call

`packages/web-acp-agent/src/agent/bodhi-provider.ts`. New method on
the existing `BodhiProvider` class:

```ts
async fetchServerInfo(): Promise<Record<string, unknown>> {
  const { baseUrl, token } = this.requireCredentials();
  const response = await fetch(`${baseUrl}/bodhi/v1/info`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${token}`,
    },
  });
  if (!response.ok) {
    const detail = await this.readErrorDetail(response);
    throw new Error(
      `Failed to fetch BodhiApp server info: ${response.status} ${response.statusText}${detail}`,
    );
  }
  return (await response.json()) as Record<string, unknown>;
}
```

Two things to notice:

- It reuses `requireCredentials()` — the private helper that throws
  if `setAuthToken` hasn't been called yet. So if a host calls
  `_bodhi/server/info` *before* `authenticate`, we get a clean error
  instead of a fetch-with-undefined-baseUrl.
- The return type is `Record<string, unknown>`, not the typed
  `BodhiServerInfoResponse`. The typing happens at the wire boundary
  (next step) — this method is a pure HTTP pipe.

### 3.2.3 `acp/engine/ext-methods/server-info.ts` — the handler

New file, ~15 lines.

```ts
import type { BodhiServerInfoResponse } from "../../../wire";
import type { ExtMethodHost } from "../types";

export async function serverInfo(
  _params: unknown,
  host: ExtMethodHost,
): Promise<BodhiServerInfoResponse> {
  const body = await host.bodhi.fetchServerInfo();
  return body as BodhiServerInfoResponse;
}
```

`ExtMethodHost` is a narrow facade defined at
`packages/web-acp-agent/src/acp/engine/types.ts`. It exposes
`bodhi`, `store`, `registry`, `mcpPool`, etc. — *what handlers are
allowed to touch*. Handlers don't see the full adapter, so the wire
surface and the engine surface stay decoupled.

The handler is the smallest functional unit: take params (we ignore),
call into the provider, cast the result to the typed wire shape.

### 3.2.4 `acp/engine/ext-methods/schemas.ts` — Zod schema

```ts
import { BODHI_SERVER_INFO_METHOD, ... } from "../../../wire";

const empty = z.object({}).passthrough();

export const EXT_METHOD_SCHEMAS: Record<string, z.ZodType<unknown>> = {
  // ...existing...
  [BODHI_SERVER_INFO_METHOD]: empty,
};
```

The dispatcher in `index.ts` validates incoming `params` against the
schema before invoking the handler. We accept anything (`empty +
.passthrough()`) — there are no params today. If we later add some
(e.g. `{ refresh: true }`), this is the only file that constrains
them.

### 3.2.5 `acp/engine/ext-methods/index.ts` — registration

```ts
import { serverInfo } from "./server-info";
import { BODHI_SERVER_INFO_METHOD, ... } from "../../../wire";

const HANDLERS: Record<string, ExtMethodHandler> = {
  // ...existing...
  [BODHI_SERVER_INFO_METHOD]: serverInfo,
};
```

`dispatchExtMethod(method, params, host)` is the entry point used by
`AcpAgentAdapter.extMethod`. It looks up `HANDLERS[method]`, runs the
schema check, calls the handler. Adding a row here is the last wiring
step on the agent side.

### 3.2.6 `src/index.ts` — public barrel

`packages/web-acp-agent/src/index.ts` re-exports the new constant and
type so consumers (the CLI in Chapter 4) can `import { ... } from
"@bodhiapp/web-acp-agent"` rather than reach into the internal
`wire/` path:

```ts
export {
  BODHI_AUTH_METHOD_ID,
  // ...
  BODHI_SERVER_INFO_METHOD,    // new
  // ...
} from "./wire";

export type {
  BodhiAuthenticateMeta,
  // ...
  BodhiServerInfoResponse,     // new
  // ...
} from "./wire";
```

The barrel is the **extraction contract**. A spec rule
(`ai-docs/web-acp/specs/web-acp-agent/index.md`) says every change to
this file must be documented — keeps consumers safe across releases.

## 3.3 Why the change is so small

Five very thin files do the work because the agent already has the
right factoring:

- `wire/` is pure types/constants — adding one is a constant + an
  interface.
- `BodhiProvider` already encapsulates credentials and base URL;
  adding an HTTP method is just another fetch with the same auth
  shape as `getAvailableModels`.
- The `ext-methods/` registry is dispatch + Zod + handler — three
  files per method, none of them coupled to the rest of the engine.

That's the payoff for the wire/engine/handler split documented in
the existing chapter 1: extending the agent costs surface area
proportional to the new feature, not to the agent's overall size.

## 3.4 Before moving on

The agent now exposes `_bodhi/server/info`. Run the agent package's
own typecheck:

```sh
cd packages/web-acp-agent && npm run check
```

(Note: that script intentionally short-circuits via `tsconfig.json`'s
`files: []` + references; the real verification is the e2e in
Chapter 5.)

In Chapter 4 we'll embed this agent inside the tutorial CLI and make
the call.
