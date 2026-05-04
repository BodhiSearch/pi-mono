# ACP Compliance Review — post-`startAgent` simplification

> **Status note (added post-publication).** All HIGH and MEDIUM
> findings (F-1, F-2, F-4, F-5, F-6, F-7, F-8) have been addressed
> per the implementation plan at
> `typescript-sdk/ai-docs/plans/agree-with-most-of-wondrous-thompson.md`.
> F-3 (agent reading `clientCapabilities`) is deliberately deferred.
> F-9 through F-14 are roadmap items; no action this round.
>
> Implementation summary:
> - F-1 / F-6 / F-7 — host advertises `clientCapabilities: {}`;
>   `listVolumes` host wrapper deleted; legacy boolean dropped.
> - F-2 / F-4 — `_bodhi/session/get` and `bodhi/getSession`
>   deleted; transcript + toggles ride
>   `LoadSessionResponse._meta.bodhi.{messages, mcpToggles, title}`.
> - F-5 — `/bodhiapp:status` slash-command removed; tutorial-cli-client
>   reads `_meta.bodhi.providerInfo` at boot via `readBodhiServerInfo`;
>   web-acp logs the same to console.
> - F-8 — cursor pagination shipped (page=10, base64-encoded
>   `page=N&per_page=10&sort_by=updated_at&sort_seq=desc`).
>
> See `packages/web-acp/TECHDEBT.md` for the Option-B chunk-stream
> replay follow-up parked for a later refactor.

**Date:** 2026-05-04
**Reviewed packages:** `packages/web-acp-agent/` (agent runtime) + `packages/web-acp/` (browser host)
**Reference:** ACP **0.21.0** (`@agentclientprotocol/sdk` v0.21.0; `agent-client-protocol/schema/schema.json` at tag v0.21.0)
**Out of scope:** `packages/cli-acp-client/`, `packages/tutorial-cli-client/`, `ws-acp-client`
**HEAD reviewed:** `e0b35359 feat(web-acp-agent): simplify embed API and remove unused layers`

This review supersedes nothing — it builds on the prior `acp-compliance-2026-05-03.md`-driven M1–M8 migration (now landed) and focuses on the **post-HEAD wire surface**. Already-migrated items appear only as a one-line confirmation in the scorecard.

---

## TL;DR

Three items need code changes; the rest is either documentation drift or roadmap.

| #       | Severity   | One-liner                                                                                                                                             |
| ------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F-1** | **HIGH**   | Host advertises `clientCapabilities.fs.{readTextFile,writeTextFile} = true` but the simplification commit deleted the handlers. Cap **must** be `{}`. |
| **F-2** | **HIGH**   | `bodhi/getSession` (un-prefixed) is a strict ACP-extensibility MUST violation. Time to drop the alias.                                                |
| **F-3** | **MEDIUM** | Agent ignores `params.clientCapabilities` on `initialize`; no future-proofing for `fs/*`/`terminal/*`/`permission/*` re-entry.                        |
| **F-4** | **MEDIUM** | `_bodhi/session/get` round-trips data that `loadSession` should carry. The M5-deferred path remains the right fix.                                    |
| **F-5** | **MEDIUM** | `AuthenticateResponse._meta.bodhi.providerInfo` is emitted but the host never consumes it — wire bandwidth waste.                                     |
| **F-6** | **LOW**    | `_bodhi/volumes/list` is exposed on `AcpClient` with zero call sites. Dead surface.                                                                   |
| **F-7** | **LOW**    | `setSessionConfigOption` request handler still accepts the legacy `boolean` shape. Drop now that the host emits `'on'`/`'off'`.                       |
| **F-8** | **LOW**    | `Agent.listSessions` honours neither `cursor` nor returns `nextCursor`. Document the unpaginated contract or implement it.                            |

Roadmap items (no code action this round): F-9 modes, F-10 fork, F-11 permission, F-12 terminal, F-13 provider-native tools.

---

## Methodology

I reproduced the wire surface from three angles in parallel:

1. **ACP 0.21.0 catalog** — sourced from the v0.21.0 tag of `agent-client-protocol/` (schema) and `typescript-sdk/` (`src/acp.ts` interfaces, `src/schema/index.ts:289` for `PROTOCOL_VERSION`, `src/schema/types.gen.ts` for shapes).
2. **Agent inventory** — traced every method in `packages/web-acp-agent/src/acp/agent-adapter.ts`, the per-handler files in `acp/handlers/`, the eight `_bodhi/*` ext-method files in `acp/engine/ext-methods/`, every `extNotification` site, every `_meta.bodhi.*` stamp, and the new single-call `startAgent` bootstrap at `src/api/start-agent.ts:11`.
3. **Host inventory** — traced every `client.<method>(...)` call from `src/acp/client.ts` and the seven `useAcp*` slice hooks; both reducers (`streamingReducer`, `panelsReducer`); the reducer arms for all 11 `SessionUpdate` kinds; the FSA volume sidechannel under `runtime/volumes-fsa/`.

I then cross-checked against the existing divergence docs (`web-acp-vs-standard-acp/m2.md`, `engine-split.md`), the ACP-0.21 migration plan (`reviewed-the-acp-compliance-report-peaceful-journal.md`), the two HEAD plan docs (`provider-agnostic-embed-simplification.md`, `some-thoughts-on-the-adaptive-plum.md`), and the per-package `TECHDEBT.md` files.

---

## A. Compliance scorecard

Concerns sorted by `agent-client-protocol/docs/protocol/` ordering, with current state vs ACP 0.21.0.

| Concern                                                | ACP 0.21 canonical                                                                               | web-acp posture (HEAD)                                                                                                                                                                                                                                                                                                  | Status                                   |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `initialize` + protocol negotiation                    | `min(client, agent)` clamp                                                                       | `handlers/initialize.ts:18` clamps; advertises `protocolVersion`, `agentInfo`, `agentCapabilities`, `authMethods`                                                                                                                                                                                                       | ✅ compliant                              |
| `agentInfo`                                            | `Implementation { name, version, title? }`                                                       | Stamped (`name='@bodhiapp/web-acp-agent'`, `title='Bodhi Web ACP Agent'`, `version=ctx.buildVersion`)                                                                                                                                                                                                                   | ✅ compliant                              |
| `clientCapabilities` (request)                         | Negotiated                                                                                       | **Host advertises `fs.{readTextFile,writeTextFile}=true` (`client.ts:57-61`); agent ignores entirely (`handlers/initialize.ts`)**                                                                                                                                                                                       | **divergent — F-1, F-3**                 |
| `agentCapabilities` (response)                         | Optional                                                                                         | `loadSession` (dynamic), `mcp.{http:true,sse:false}`, `prompt.{image:false,audio:false,embeddedContext:false}`, `session.{list:{},close:{}}`                                                                                                                                                                            | ✅ compliant                              |
| `authenticate`                                         | `{ methodId }` → `{}` or `_meta`                                                                 | `methodId='bodhi-token'`; credentials carried on `_meta.bodhi.{token,baseUrl}` (the request-side carrier is fine since `_meta` is exactly the right escape hatch). Response stamps `_meta.bodhi.providerInfo` but host discards it                                                                                      | ⚠ wire-compliant, host wastes meta — F-5 |
| `session/new`                                          | `{ cwd, mcpServers, additionalDirectories? }` → `{ sessionId, modes?, models?, configOptions? }` | Returns `{ sessionId, models?, configOptions }` natively. Reads `_meta.bodhi.{requestedMcpUrls,mcpInstances}` from request                                                                                                                                                                                              | ✅ compliant                              |
| `session/load`                                         | Returns `{ modes?, models?, configOptions? }` and replays history via `session/update`           | Returns `{ models?, configOptions, _meta.bodhi.{title,mcpToggles} }`. Replays only `'notification'` entries; `'turn'` and `'builtin'` rows replay via `_bodhi/session/get` round-trip                                                                                                                                   | ⚠ partial — F-4                          |
| `session/list`                                         | Cursor-paginated `{ sessions, nextCursor? }`                                                     | Returns full set unpaginated; `cursor` ignored; `nextCursor` not returned. Stamps `SessionInfo._meta.bodhi.{turnCount,lastModelId,createdAt}`                                                                                                                                                                           | ⚠ underspec — F-8                        |
| `session/close`                                        | Stable in 0.20.0                                                                                 | Implemented (`handlers/session-crud.ts:163`); aborts active driver if matching session                                                                                                                                                                                                                                  | ✅ compliant                              |
| `session/cancel`                                       | Notification (no response)                                                                       | Implemented as notification (`agent-adapter.ts:121`)                                                                                                                                                                                                                                                                    | ✅ compliant                              |
| `session/prompt`                                       | Streaming                                                                                        | Single-flight per session (rejects with `-32011`); built-in dispatch first; otherwise streams via `prompt-driver.ts`                                                                                                                                                                                                    | ✅ compliant                              |
| `session/set_model`                                    | `unstable_setSessionModel` (still unstable in 0.21)                                              | Native `unstable_setSessionModel`; validates against catalog                                                                                                                                                                                                                                                            | ✅ compliant (unstable surface)           |
| `session/set_config_option`                            | Stable in 0.21.0; discriminated `{type:'boolean',value}` or `{value:SessionConfigValueId}`       | Native; emits `config_option_update`. **Accepts legacy `boolean` value alongside `'on'`/`'off'` string**                                                                                                                                                                                                                | ⚠ legacy alias — F-7                     |
| `session/set_mode`                                     | `availableModes` advertised at create/load                                                       | Not implemented; agent doesn't surface `SessionMode`                                                                                                                                                                                                                                                                    | ⚪ non-goal — F-9                         |
| `session/fork` (unstable)                              | Behind `sessionCapabilities.fork`                                                                | Roadmap M6                                                                                                                                                                                                                                                                                                              | ⚪ planned — F-10                         |
| `session/resume` (stable in 0.20.0)                    | Resumes without history replay                                                                   | Not implemented; not advertised                                                                                                                                                                                                                                                                                         | ⚪ unconsidered                           |
| `permission/request`                                   | `{outcome: 'cancelled' \| 'selected'}`                                                           | Host returns one-line `'cancelled'` stub (`runtime.ts:54-56`); agent never calls. Real bridge deferred per `deferred.md`                                                                                                                                                                                                | ⚪ deferred — F-11                        |
| `fs/read_text_file`, `fs/write_text_file`              | Behind `clientCapabilities.fs.*`                                                                 | **Host advertises true but has no handlers (capability/code mismatch).** Agent never calls                                                                                                                                                                                                                              | ❌ broken — F-1                           |
| `terminal/*`                                           | Behind `clientCapabilities.terminal`                                                             | Not advertised, not used                                                                                                                                                                                                                                                                                                | ⚪ non-goal — F-12                        |
| `elicitation/*` (unstable)                             | Behind `clientCapabilities.elicitation`                                                          | Not used                                                                                                                                                                                                                                                                                                                | ⚪ non-goal                               |
| `providers/*` + `logout` (unstable, **new in 0.21.0**) | Behind `agentCapabilities.providers`                                                             | Not used; the `LlmProvider` surface partially overlaps (auth + catalog). Worth re-evaluating at M8 library extract                                                                                                                                                                                                      | ⚪ unconsidered                           |
| `extMethod` / `extNotification` (`_`-prefixed)         | Allowed; vendor-namespaced                                                                       | All custom traffic uses `_bodhi/*` except `bodhi/getSession` legacy alias                                                                                                                                                                                                                                               | ❌ alias — F-2                            |
| `SessionUpdate` kinds (11 in spec)                     | All explicit                                                                                     | Three rendered (`agent_message_chunk`, `tool_call`, `tool_call_update`); six accepted-no-op (`user_message_chunk`, `agent_thought_chunk`, `plan`, `current_mode_update`, `session_info_update`, `usage_update`); two routed to `panelsReducer` (`available_commands_update`, `config_option_update`); default arm warns | ✅ compliant                              |
| `_meta` extensibility                                  | All custom fields under `_meta`, no top-level extras on spec types                               | Every `bodhi.*` extra rides under `_meta`. No top-level non-spec fields observed                                                                                                                                                                                                                                        | ✅ compliant                              |
| `agent_message_chunk` builtin envelope                 | (Custom)                                                                                         | `_meta.bodhi.builtin = { command }` for built-in `/help`, `/version`, `/info`, `/copy`, `/mcp` replies                                                                                                                                                                                                                  | ✅ compliant (uses `_meta`)               |
| MCP lifecycle                                          | No first-class transport; `_`-prefixed extension allowed                                         | `extNotification("_bodhi/mcp/state", {sessionId,server,state,error?,tools?})`                                                                                                                                                                                                                                           | ✅ compliant                              |
| Built-in actions side-channel                          | No first-class transport                                                                         | `extNotification("_bodhi/builtin/action", {sessionId,command,action})` with `kind: 'copy'\|'mcp-add'\|'mcp-remove'`                                                                                                                                                                                                     | ✅ compliant                              |
| MCP transport                                          | `McpServer.{http,sse,stdio}`; `http.{url,headers}`                                               | Only HTTP supported; JWT in `headers`                                                                                                                                                                                                                                                                                   | ✅ compliant                              |
| Volume mounts                                          | Not modelled by ACP                                                                              | Sidechannel via raw `postMessage` on the worker global scope (FSA handles aren't JSON-cloneable). Distinct from ACP NDJSON wire                                                                                                                                                                                         | ⚠ documented divergence (acceptable)     |
| Filesystem                                             | Client-delegated `fs/*` (2 verbs)                                                                | Agent owns FS via worker-mounted ZenFS + just-bash `IFileSystem` (~25 methods)                                                                                                                                                                                                                                          | ✅ documented divergence                  |

---

## B. Findings

Each finding has: **Where** (file:line), **What** (current state), **Why** (compliance argument), **Fix** (concrete change), **Effort** (S/M/L).

### F-1 [HIGH] — Host advertises `fs/*` capabilities without handlers

**Where.** `packages/web-acp/src/acp/client.ts:54-71`:

```ts
async initialize(): Promise<InitializeResponse> {
  const response = await this.#conn.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      // Advertise fs/* for external ACP agents / IDE integrations.
      // Built-in bash does not use these entry points (see volumes.md).
      fs: { readTextFile: true, writeTextFile: true },
    },
  });
```

**What.** Host says it implements `fs/read_text_file` and `fs/write_text_file`. The HEAD simplification commit deleted `src/acp/fs-handlers.ts`, `fs-handlers.test.ts`, and `fs-handlers.integration.test.ts` (-497 LoC). The `Client` handler at `runtime.ts:51-63` registers only `requestPermission`, `sessionUpdate`, `extNotification` — the SDK has nowhere to dispatch `fs/*` calls.

**Why.** Per `agent-client-protocol/schema/schema.json` (v0.21.0) and `typescript-sdk/src/acp.ts:1835-1839`, `clientCapabilities.fs.readTextFile = true` is a **promise that the client implements `fs/read_text_file`**. An agent reading the cap is entitled to call it; the SDK on the agent side will treat any error as a runtime fault. The agent in this repo never calls `fs/*` (so no observable break today), but the moment a third-party ACP-conformant agent attaches to this host — exactly the case the comment cites as motivation — it will fail.

**Fix.** Drop the field to match the actual implementation. The simplification commit message + spec at `specs/web-acp-client/index.md` line ~150 already say `clientCapabilities: {}`.

```ts
clientCapabilities: {},
```

**Effort.** S (one line).

**Note.** The original "advertise for external ACP agents" rationale is no longer valid — without handlers, the advertisement is a lie. If we want IDE-integration in future, restore the handlers AND the `MainZenfs` mirror at the same time.

---

### F-2 [HIGH] — `bodhi/getSession` legacy alias violates ACP extensibility MUST

**Where.** `packages/web-acp-agent/src/wire/index.ts:25-27`:

```ts
export const BODHI_GET_SESSION_METHOD = '_bodhi/session/get';
/** Deprecated synonym for `_bodhi/session/get`; accepted for one release window. */
export const BODHI_GET_SESSION_METHOD_LEGACY = 'bodhi/getSession';
```

Routed at `acp/engine/ext-methods/index.ts:24` with a deprecation warning logged on each call.

**What.** `bodhi/getSession` is an **un-prefixed** custom method — i.e. it occupies a method-name slot that ACP reserves for future protocol extensions.

**Why.** `agent-client-protocol/docs/protocol/extensibility.mdx:43` (read on `main`):

> Method names starting with `_` are reserved for application-specific extensions. Implementations MUST NOT define methods that don't start with `_`.

The "one release window" comment in the source has now spanned the M1–M8 ACP-0.21 migration. The host now uses `_bodhi/session/get` exclusively (`client.ts:130-133` references `BODHI_GET_SESSION_METHOD`, never the legacy constant). Time to remove.

**Fix.**
1. Delete `BODHI_GET_SESSION_METHOD_LEGACY` from `wire/index.ts`.
2. Drop the `bodhi/getSession` route from `ext-methods/index.ts:24` and the deprecation log lines.
3. Drop the type re-export from `index.ts` and `test-utils/index.ts` if present.
4. Update `specs/web-acp-agent/acp.md` to say "no un-prefixed extension methods remain"; update the milestones-index ACP-0.21 row from `partial (M5 deferred)` to `compliant`.

**Effort.** S (5 minutes; risk is contained — one un-prefixed method, host no longer calls it).

**Caveat.** Strictly this becomes compliant only after the deletion lands AND any tutorial-cli / cli-acp-client/ ws-acp-client consumers are updated. Per the existing "leave broken" direction for those packages, that's already accepted.

---

### F-3 [MEDIUM] — Agent ignores `clientCapabilities` on `initialize`

**Where.** `packages/web-acp-agent/src/acp/handlers/initialize.ts:14-51`. The function signature accepts `params: InitializeRequest` but `params.clientCapabilities` is never read; the `AcpAdapterContext` (`handlers/adapter-context.ts`) has no slot to record it.

**What.** The agent has no record of which optional client-side methods are available. Today the agent never calls `fs/*`, `terminal/*`, or `permission/request`, so no harm; but every future bridge re-entry (M2.3 permission, M5+ fs delegation, ever-terminal) needs the cap.

**Why.** Defensive. Per ACP, capabilities are negotiated for exactly this purpose. Recording them once at handshake time is essentially free; not recording them means the future code has to either re-fetch (impossible — `initialize` is one-shot) or re-derive (impossible too).

**Fix.** Add a slot:

```ts
// handlers/adapter-context.ts
export interface AcpAdapterContext {
  // ... existing fields ...
  clientCapabilities?: ClientCapabilities;
}

// handlers/initialize.ts
export async function handleInitialize(ctx, params) {
  ctx.clientCapabilities = params.clientCapabilities;
  // ... existing return ...
}
```

Add a typed accessor (`ctx.canCallFsRead()`, etc.) when the first consumer lands.

**Effort.** S.

---

### F-4 [MEDIUM] — `_bodhi/session/get` duplicates what `loadSession` should carry

**Where.** Agent: `acp/engine/ext-methods/get-session.ts`. Host: `useAcpSession.ts:211` (issued before every `loadSession`).

**What.** ACP 0.21's `session/load` is supposed to replay session history via `session/update` notifications and return enough state to reconstruct the UI. The agent's `walkEntries` at `replay.ts` only re-emits `'notification'` entries (`session-crud.ts:98-108`); `'turn'` and `'builtin'` rows — which carry user text and built-in command exchanges — never reach the client. The host compensates by issuing `_bodhi/session/get` to fetch the full snapshot in a side request.

This is the M5-deferred item already in TECHDEBT (`packages/web-acp/TECHDEBT.md` § "M5 deferred").

**Why.** Two compliance angles:
1. **Round-trip overhead** — every session pick costs N+1 RPCs.
2. **Architectural redundancy** — two truth sources (ACP replay vs ext snapshot) for the same data; risk of drift.

**Fix.** Two paths, per the existing TECHDEBT analysis:

- **(a) Quick stop-gap:** ride messages + toggles on `LoadSessionResponse._meta.bodhi.{messages,mcpToggles}`. Keeps the wire round-trip count down and stays under `_meta`. Drop `_bodhi/session/get` once the host migrates.
- **(b) ACP-aligned:** a replay-folding reducer that synthesises `user_message_chunk` + `agent_message_chunk` notifications from the persisted `'turn'` and `'builtin'` entries during `loadSession`. Emit these via `runtime.sendRawNotification` like the existing `'notification'` replay. The host's existing reducer already handles these kinds — this is the cleanest path.

Recommend (b) as the durable fix; (a) is a 1-PR alternative if (b) is too large a change in a single milestone.

**Effort.** (a) M (handful of files); (b) M (replay walker change + reducer assertion that user-text reconstruction is correct).

---

### F-5 [MEDIUM] — `_meta.bodhi.providerInfo` emitted but never read

**Where.** Agent emits at `handlers/initialize.ts:72`:

```ts
return providerInfo !== undefined ? { _meta: { bodhi: { providerInfo } } } : {};
```

Host calls `await this.#conn.authenticate(...)` at `client.ts:73-78` — return is `void`-typed; nobody reads `response._meta`. `useAcpAuth.ts` does not surface `providerInfo` in any state.

**What.** The post-HEAD design replaces `_bodhi/server/info` with a fold-in to `setAuthToken`'s return value. The information surfaces on `AuthenticateResponse._meta.bodhi.providerInfo`, but the host doesn't consume it.

**Why.** Emit-without-consume is wire bandwidth waste; either use it (UI: connection-status badge, server-version-mismatch toast) or remove it.

**Fix.** Two viable paths:

- **Wire it through.** `client.ts:authenticate` returns `BodhiServerInfoResponse | undefined`; `useAcpAuth.ts` exposes it on state; a `Header.tsx` indicator shows "Connected to Bodhi v… (client_id …)". Useful for support — confirms the user is talking to the right server.
- **Drop it.** Convert `setAuthToken` to throw on probe failure; the response stays `{}`. Removes a hidden surface.

I'd take the first — the probe info is genuinely useful and the wire cost is negligible. If we keep emitting, **it must be read.**

**Effort.** S either direction.

---

### F-6 [LOW] — `_bodhi/volumes/list` is a dead host surface

**Where.** `packages/web-acp/src/acp/client.ts:148-152` exposes `listVolumes()`. Searched `packages/web-acp/src/` for callers — zero hits.

**What.** Volumes flow main-thread → worker via the `volume-control.ts` raw-`postMessage` sidechannel; the host already knows what's mounted. The ACP-side `_bodhi/volumes/list` ext method exists on the agent (`ext-methods/volumes-list.ts`) for external clients but the in-monorepo host doesn't need it.

**Why.** Dead code is a maintenance liability. Either someone wires it up later, or it should be deleted.

**Fix.** Delete the `listVolumes` wrapper from `AcpClient`. Keep the agent-side handler — it's a legitimate external-client affordance (`_bodhi/volumes/list` lets a third-party ACP client know what mount roots the agent has). Document the asymmetry in `specs/web-acp-client/acp.md`.

**Effort.** S (delete one method on `AcpClient`).

---

### F-7 [LOW] — `setSessionConfigOption` accepts legacy `boolean` value

**Where.** `packages/web-acp-agent/src/acp/handlers/session-crud.ts:204-216`:

```ts
const value = params.value;
let nextBool: boolean;
if (typeof value === 'boolean') {
  nextBool = value;
} else if (value === 'on') {
  nextBool = true;
} else if (value === 'off') {
  nextBool = false;
} else { ... }
```

**What.** The features are modelled as `select` options (`acp/feature-config.ts:49-61` — `type:'select'` with `[{value:'on'},{value:'off'}]`), so per ACP the request should always carry `value: 'on' | 'off'`. The boolean branch was the legacy migration bridge.

**Why.** Per ACP 0.21 schema (`types.gen.ts:4796,4834`), the request is discriminated:
- `{type:'boolean', value: bool}` for boolean options.
- `{value: SessionConfigValueId}` for select options.

The agent should accept whichever shape matches the option's declared `type`. Today it accepts both regardless, which is forgiving but invites bug-prone callers.

**Fix.** Drop the `typeof value === 'boolean'` branch; add a check that `params.type` (if present) matches the registered option's discriminator. Update the host's `useAcp.ts:103-121` if it ever sends a boolean (it doesn't — already sends `'on'`/`'off'`).

**Effort.** S.

---

### F-8 [LOW] — `Agent.listSessions` drops `cursor`/`nextCursor`

**Where.** `packages/web-acp-agent/src/acp/handlers/session-crud.ts:136-161`. Comment at line 144 says:

```
// Unpaginated — `sessionCapabilities.list = {}` does not advertise cursor support.
```

**What.** Per ACP 0.21 schema, `ListSessionsRequest{cursor?}` and `ListSessionsResponse{sessions, nextCursor?}` are pagination-shaped. Advertising `sessionCapabilities.list = {}` (the empty object) means "supported"; cursor support is implicit and conformant clients may pass `cursor`. The agent today doesn't read `params.cursor` and never returns `nextCursor` — for our store sizes (single-user, single-tab, dozens of sessions) this is fine, but the contract is weak.

**Why.** Defensive: third-party ACP clients (or future internal tooling) may assume cursor semantics. Either implement, or document explicitly.

**Fix.** Three options ordered by cost:

- (a) Document explicit non-pagination in `specs/web-acp-agent/sessions.md`; advertise `sessionCapabilities.list._meta.bodhi.unpaginated = true` so clients can probe (per the extensibility convention). **Cheap.**
- (b) Implement cursor pagination in `MemorySessionStore` + `DexieSessionStore`. Trivial for memory; Dexie supports `where(...).aboveOrEqual(cursor).limit(N)`. **M.**
- (c) Defer until M8 library extraction; flag in TECHDEBT. **Free.**

Recommend (a) now, (b) at M8.

**Effort.** S (a) / M (b).

---

### F-9 to F-13 [Roadmap — no action this round]

These are acknowledged non-implementations that should NOT change in this review cycle. Recording for completeness:

- **F-9 — `setSessionMode` / `availableModes`.** Not used. ACP supports plan/edit-style mode toggles. Coding-agent uses it; web-acp could later. Document in `deferred.md` if not already.
- **F-10 — `unstable_forkSession`.** Roadmap M6.
- **F-11 — `permission/request`.** Carved out at M2.3; bash runs commands as-is. Re-enters with the destructive-command bridge.
- **F-12 — `terminal/*`.** Browsers have no shell; explicit non-goal for v1.
- **F-13 — Provider-native tools.** `_bodhi/providers/nativeTools` deferred at M3.3.
- **F-14 — `unstable_listProviders` / `unstable_setProvider` / `unstable_disableProvider` / `unstable_logout`** (new in 0.21.0). Worth evaluating: the existing `LlmProvider` interface partially overlaps the `providers/*` surface. Could front the per-provider auth/credential management natively if M8 extracts the agent as a third-party-consumable library. Park for M8.

---

## C. Acknowledged divergences (no action)

These are documented at `web-acp-vs-standard-acp/m2.md` and surveyed here as compliance-table rows; no changes recommended.

1. **Agent owns the FS.** ACP `fs/*` has 2 verbs; just-bash's `IFileSystem` has ~25. Mounting on the agent is structurally cheaper than ~12 `_bodhi/fs/*` extension methods. Permanent.
2. **Volume-mount sidechannel uses raw `postMessage`.** FSA handles aren't JSON-cloneable; there is no path through ACP NDJSON wire. Permanent (browser-host-specific).
3. **Volumes advertised via system prompt.** No canonical ACP shape exists for "here's a list of mount roots and their human-readable purposes". Permanent until ACP adds a primitive.
4. **MCP toggle storage on the agent side.** Per-session per-server/per-tool MCP toggles are not in any ACP shape. `_bodhi/mcp/toggles/set` rides as a custom extension method; per-session config-option category `_bodhi/feature` is the closest standard analog but the toggle key space is dynamic per-server. Permanent until ACP models per-session MCP gating.
5. **`agent_message_chunk._meta.bodhi.builtin` for built-in turns.** Legitimate `_meta` extension; rendering hint to the host. Permanent.
6. **Inbound `_meta.bodhi.{requestedMcpUrls, mcpInstances}` on `session/new` + `session/load`.** Host originates, agent reads; canonical use of the `_meta` carrier. Permanent.
7. **`SessionInfo._meta.bodhi.{turnCount, lastModelId, createdAt}`.** UI-affordance fields ACP doesn't carry on its own `SessionInfo` shape. Permanent.

---

## D. Action plan & sequencing

If I had to land these as PRs:

| PR                                                      | Includes | Effort | Risk                                                                                   |
| ------------------------------------------------------- | -------- | ------ | -------------------------------------------------------------------------------------- |
| **PR1 — clientCapabilities truth-up**                   | F-1, F-3 | S      | Low — F-1 matches spec/code, F-3 is additive                                           |
| **PR2 — drop `bodhi/getSession` legacy alias**          | F-2, F-7 | S      | Low — host already migrated. Will break tutorial-cli/cli-acp-client per "leave broken" |
| **PR3 — providerInfo wired or dropped**                 | F-5      | S      | None                                                                                   |
| **PR4 — delete dead `listVolumes` host wrapper**        | F-6      | S      | None                                                                                   |
| **PR5 — `loadSession` carries transcript natively**     | F-4      | M      | Medium — needs careful test coverage of replay path; landed-with-spec-update           |
| **PR6 — pagination contract documented or implemented** | F-8      | S–M    | None                                                                                   |

PR1 + PR4 + PR6(a) + PR2 are quick wins (~1 hour total). PR3 is a UX call (wire through vs delete). PR5 is the only meaningful engineering work and the only one that closes a real architectural redundancy.

After PR1–PR6 land, the compliance-at-a-glance row in `milestones/index.md` for "Extension methods" can flip from `partial (M5 deferred)` to `compliant`. The "Filesystem" row stays `divergent (documented)` — that's the permanent FS posture.

---

## E. What I did NOT review

- **`packages/cli-acp-client/`** — out of scope per user direction.
- **`packages/tutorial-cli-client/`** — out of scope.
- **`packages/web-acp-agent` MCP wire details beyond extNotification surface.** The `_bodhi/mcp/state` shape was re-confirmed as the migration target (M6 of ACP-0.21). MCP transport (Streamable HTTP only) was confirmed compliant. I did not audit the per-tool refcounting / `<srv>__<tool>` namespacing.
- **Performance / streaming framing.** ACP framing is delegated to `@agentclientprotocol/sdk`'s `ndJsonStream`; nothing to review on our side.
- **Tool-call `kind` / `status` shapes.** Spot-checked; the agent emits `tool_call` / `tool_call_update` via `prompt-driver.ts` and the SDK validates them. No issues observed but I did not exhaustively trace every tool-call lifecycle path.
- **`providers/*` (new in 0.21.0).** Flagged as F-14 for M8 evaluation; not reviewed for present-day adoption.

---

## F. References

**ACP 0.21.0 surface citations** in this review come from:

- `agent-client-protocol/schema/schema.json` (tag v0.21.0)
- `typescript-sdk/src/acp.ts:1724-1895` (`Client` interface), `1903-2270` (`Agent` interface)
- `typescript-sdk/src/schema/index.ts:245-289` (method-name constants, `PROTOCOL_VERSION`)
- `typescript-sdk/src/schema/types.gen.ts` (request/response shapes; `SessionUpdate` discriminated union at `4693-4726`)
- `agent-client-protocol/docs/protocol/extensibility.mdx` (the MUST clause for `_`-prefixed methods, the `_meta` convention)

**web-acp surface citations:**

- `packages/web-acp-agent/src/acp/agent-adapter.ts`
- `packages/web-acp-agent/src/acp/handlers/{initialize,session-crud}.ts`
- `packages/web-acp-agent/src/acp/engine/{services,session-runtime,prompt-driver,builtin-dispatch,replay,types}.ts`
- `packages/web-acp-agent/src/acp/engine/ext-methods/{index,get-session,volumes-list,mcp-toggles-set,sessions-delete}.ts`
- `packages/web-acp-agent/src/acp/feature-config.ts`
- `packages/web-acp-agent/src/wire/index.ts`
- `packages/web-acp-agent/src/api/start-agent.ts`
- `packages/web-acp/src/acp/{client,runtime,streaming-reducer,panels-reducer,builtin-dispatch,empty-sentinels,feature-keys,index}.ts`
- `packages/web-acp/src/hooks/{useAcp,useAcpAuth,useAcpModels,useAcpSession,useAcpStreaming,useAcpMcp,useAcpRuntime,useVolumes}.ts`
- `packages/web-acp/src/runtime/volumes-fsa/{volume-control,volume-channel,backends}.ts`
- `packages/web-acp/src/agent/agent-worker.ts`

**Prior compliance / divergence material:**

- `ai-docs/web-acp/web-acp-vs-standard-acp/{m2,engine-split}.md`
- `ai-docs/plans/reviewed-the-acp-compliance-report-peaceful-journal.md` (the M1–M8 ACP-0.21 migration; landed)
- `ai-docs/plans/{provider-agnostic-embed-simplification,some-thoughts-on-the-adaptive-plum}.md` (the two HEAD plans)
- `ai-docs/web-acp/milestones/index.md` § "ACP compliance at a glance"
- `packages/web-acp/TECHDEBT.md` § "M5 deferred"
