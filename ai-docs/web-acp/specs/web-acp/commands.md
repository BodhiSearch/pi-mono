# commands

**Source of truth:** `packages/web-acp/src/agent/commands/`
(+ wiring in `src/acp/engine/session-runtime.ts`
(`refreshAvailableCommands`),
`src/acp/engine/prompt-driver.ts`
(`#applySlashCommandExpansion`),
`src/acp/engine/builtin-dispatch.ts` (built-in interception),
`src/acp/engine/ext-methods/get-session.ts` (transcript replay
with built-in pairs),
`src/components/chat/CommandPicker.tsx`,
`src/components/chat/MessageBubble.tsx`,
`src/hooks/useAcp.ts`, and `src/lib/builtin-format.ts`).

**Parent:** [`./index.md`](./index.md)

> **Note (post engine-split refactor).** Where this file
> references `AcpAgentAdapter.#refreshAvailableCommands` /
> `#applySlashCommandExpansion` / `#tryHandleBuiltin` /
> `extMethod(BODHI_GET_SESSION_METHOD, …)`, those have moved to
> the engine layer (`session-runtime.ts`, `prompt-driver.ts`,
> `builtin-dispatch.ts`, `ext-methods/get-session.ts`). Wire
> behavior is byte-identical. Mapping: see [`./acp.md`](./acp.md)
> § "Engine layer".

## Functional scope

The slash-command surface is split into **two phases**, both of
which use the same ACP wire shape (`available_commands_update`
notifications + `session/prompt` requests). The user types `/foo`
in the chat input; a picker advertises every available command;
selecting one inserts the literal `/cmd args` text into the input;
sending it ships a normal `session/prompt` to the worker. What
happens next depends on the phase that owns the command.

- **Phase A — vault-sourced commands (shipped, M4 phase A).**
  Markdown templates under `<mount>/.pi/commands/**/*.md` discovered
  at session boot. The agent expands the template body
  agent-side in `prompt()` and the LLM sees the **rendered template**.
  The user input never reaches the LLM verbatim; the LLM never sees
  the `/cmd` text.
- **Phase B — agent-handled built-ins (shipped, M4 phase B).**
  A static registry of commands the agent recognises before any
  LLM resolution: `/help`, `/version`, `/session`, `/copy`, `/mcp`.
  The agent runs a handler, emits the reply directly via
  `agent_message_chunk`, and **never invokes the LLM**. Built-in
  exchanges are persisted to a separate `'builtin'` `SessionEntry`
  kind and excluded from LLM-visible history on every subsequent
  prompt.

Both phases ride the same advertisement wire, so the
`CommandPicker` is a black-box consumer of `AvailableCommand[]` —
it does not know which phase a given command belongs to.

## Wire shape

### Advertisement — `available_commands_update`

Emitted once at the end of `newSession` and `loadSession`.
Carries the full advertised list (built-ins prepended, vault
commands appended). See ACP's stable
`available_commands_update` notification — no `_meta` extension is
used for advertisement. The picker filters by leading token; no
extra request/response on selection.

### Delivery — `session/prompt`

The literal `/cmd args` text flows in as a regular `text` content
block. Phase routing happens **inside** `AcpAgentAdapter.prompt()`:

1. `findBuiltin(rawText)` — phase B match? Run handler, emit chunk
   with `_meta.bodhi.builtin = { command, action? }`, persist as a
   `'builtin'` entry, return `{ stopReason: 'end_turn' }`. **Skip**
   model resolution and the inline LLM path entirely.
2. Otherwise, model resolution + `#applySlashCommandExpansion()` —
   phase A match? The matching `text` block is rewritten in place
   to the expanded template body. The LLM sees the expansion.
3. Otherwise, the literal text passes through to the LLM as-is.

### `_meta.bodhi.builtin` envelope (M4 phase B)

Rides on the standard `agent_message_chunk` notification the same
way `_meta.bodhi.mcp` rides MCP lifecycle events. Type definitions
in `packages/web-acp/src/acp/index.ts`:

```ts
// Generic descriptor — `params` field is conditional: present iff
// `P` is non-void. `/copy` carries no params; `/mcp add` and
// `/mcp remove` carry `{ url }`.
export type BodhiBuiltinAction<K extends string = string, P = void> = [P] extends [void]
  ? { kind: K }
  : { kind: K; params: P };

export interface BodhiMcpUrlParams {
  url: string;
}

export type BodhiBuiltinCopyAction = BodhiBuiltinAction<'copy'>;
export type BodhiBuiltinMcpAddAction = BodhiBuiltinAction<'mcp-add', BodhiMcpUrlParams>;
export type BodhiBuiltinMcpRemoveAction = BodhiBuiltinAction<'mcp-remove', BodhiMcpUrlParams>;

// Discriminated union — switch on `kind` to narrow.
export type AnyBodhiBuiltinAction =
  | BodhiBuiltinCopyAction
  | BodhiBuiltinMcpAddAction
  | BodhiBuiltinMcpRemoveAction;

export interface BodhiBuiltinMeta {
  command: string;
  action?: AnyBodhiBuiltinAction;
}

export interface BodhiBuiltinTag {
  // Same shape as BodhiBuiltinMeta but used as the in-memory marker
  // attached to the AgentMessage envelope (`_builtin` field) returned
  // by `bodhi/getSession` and tracked on the client for rendering.
  command: string;
  action?: AnyBodhiBuiltinAction;
}
```

Action payloads are typed per-kind. `/copy` carries `{ kind: 'copy' }`
and the client builds the markdown payload from its own `messages`
state at dispatch time. `/mcp add` and `/mcp remove` carry
`{ kind: 'mcp-add' | 'mcp-remove', params: { url } }` because the
client needs the canonical URL to mutate the persisted IDB list
before re-issuing `auth.login`. Future kinds with no params
(`'share'`, `'feedback'`, …) plug in by adding a single-arg alias
to the union; kinds with payload extend the union with a second
generic parameter.

`extractBuiltinMeta` in `lib/builtin-format.ts` validates the wire
blob against the per-kind shape — unknown kinds and malformed
payloads return `undefined` so the dispatcher only ever sees
fully-narrowed values.

### No new `_bodhi/*` extension method

Phase B activation, dispatch, and persistence ride existing ACP
surfaces (`available_commands_update`, `session/prompt`,
`session/update`, `bodhi/getSession`). No new extension method
constants land in `acp/index.ts`.

## Phase A — vault-sourced commands

### Discovery

`AcpAgentAdapter.#refreshAvailableCommands()` walks the agent's
`IFileSystem` (M2) at the end of every `newSession` / `loadSession`
and reads `<mount>/.pi/commands/**/*.md` from every mounted volume.
Front-matter is parsed by a hand-rolled minimal parser
(`agent/commands/front-matter.ts`); the supported fields are
`description` and `argument-hint`. Richer Claude-Code fields
(`allowed-tools`, `model`, `disable-model-invocation`, named
`arguments`, `when_to_use`) are out of scope for M4 and re-enter
with M5 extensions.

### Naming

Every command name is mount-prefixed:
`<mount>:<subdir>:<name>`. Conflicts within a mount resolve
first-wins by sorted relative path with a warning. The picker
always shows the fully qualified name.

### Expansion

`#applySlashCommandExpansion()` rewrites the last `text` block in
`params.prompt` when it starts with `/` and matches a cached
`CommandDef`. Tokenisation is bash-style (single + double quotes,
backslash escapes). Substitutions: `$1..$9`, `$@`, `$ARGUMENTS`
(alias of `$@`). Unmatched positional placeholders stay literal so
authors notice the typo. Unknown `/cmd` and non-slash text pass
through untouched.

### Persistence

Vault commands flow through the normal `'turn'` entry path —
`recordTurn` writes the **expanded** `userText` (the LLM's view),
plus `finalMessages` from `inline.getMessages()`. Reload via
`session/load` rehydrates the LLM context from the last turn's
`finalMessages`; the picker repopulates from the
`available_commands_update` re-emit at the end of `loadSession`.

### Prompt templates (M4.2)

`<mount>/.pi/prompts/**/*.md` discovered alongside commands at the
end of every `newSession` / `loadSession`. Mechanically identical
to commands: same `CommandDef` shape, same canonical naming
(`<mount>:<subdir>:<name>`), same supported front-matter
(`description`, `argument-hint`), same expansion via
`expandCommand` from `agent/commands/expander.ts`.

The wire is also identical — `AvailableCommand` carries no kind
discriminator, so the picker stays a black-box consumer of the
merged list. A user-visible template behaves indistinguishably from
a vault command.

**Why a separate directory at all.** Templates capture *intent*
authors want to reuse repeatedly ("write a haiku about $1");
commands capture *agent affordances* ("review the API at $1").
Keeping them in different directories preserves that authorial
intent without leaking it into the wire — when M4.3 lands skills,
the same vault-directory split extends naturally.

**Conflict rule.** When the same canonical name resolves under both
`.pi/commands/` and `.pi/prompts/` of the same mount,
`#refreshAvailableCommands` keeps the **command** version and drops
the prompt with a `[prompts]`-tagged `console.warn`. Rationale:
commands existed first; the conflict is the user putting the same
file in two places, and the command directory carries the more
specific intent. The picker shows one entry; the LLM sees the
command body when the user expands it.

**Loader factoring.** Both directories are scanned by a single
private `loadFromVolumes(input, dirRelpath, kind)` helper in
`agent/commands/loader.ts`; `loadCommandsFromVolumes` and
`loadPromptsFromVolumes` are thin wrappers that fix the directory
relpath and the warning prefix. Cross-source dedup happens in the
agent's `#refreshAvailableCommands`, not in the loader (the
loader's `seen` Map only prevents intra-call duplicates).

**Out of scope for M4.2 first slice.** Parameter forms (named
parameters in front-matter triggering a quick form before
expansion) — the milestone preview pre-authorises this as a
follow-up slice. Bash slice operators (`${@:N:L}`) carried by the
frozen web-agent template module — not in M4.1's expander, not
added here. Live vault watcher / re-emit on file change — same
posture as commands; refresh fires once per `newSession` /
`loadSession`.

## Phase B — agent-handled built-ins

### Initial registry

`packages/web-acp/src/agent/commands/builtins/`:

| File | Role |
| --- | --- |
| `types.ts` | `BuiltinCommand`, `BuiltinHandlerCtx`, `BuiltinMcpInstance`, `BuiltinResult`, `BuiltinAction` (re-export of `AnyBodhiBuiltinAction`) |
| `help.ts` | `/help` — markdown table over `ctx.advertisedCommands` (built-ins + vault, post-merge) |
| `version.ts` | `/version` — `__WEB_ACP_VERSION__`, `__ACP_SDK_VERSION__`, current model id, server URL |
| `session.ts` | `/session` — id, turn count, message count, connected MCP servers |
| `copy.ts` | `/copy` — emits `action: { kind: 'copy' }` if any assistant text exists, else "Nothing to copy yet." |
| `mcp.ts` | `/mcp` — list / add / remove MCP servers; subcommand dispatch is local to the handler |
| `index.ts` | `BUILTIN_COMMANDS`, `findBuiltin`, `isBuiltinName`, `builtinAvailableCommands` |

### Handler context

```ts
interface BuiltinHandlerCtx {
  sessionId: string;
  modelId: string | null;       // from params._meta.bodhi.modelId; nullable
  serverUrl: string | null;     // from BodhiProvider.getBaseUrl()
  sessionStats: { turnCount: number; messageCount: number };
  mcpServersConnected: string[];
  /** Approved Bodhi instances pushed in via _meta.bodhi.mcpInstances. */
  mcpInstances: BuiltinMcpInstance[];
  /** Persisted requested-URL list pushed in via _meta.bodhi.requestedMcpUrls. */
  requestedMcpUrls: string[];
  advertisedCommands: AvailableCommand[];
  inlineMessages: AgentMessage[];   // for /copy — built-ins are absent by construction
  buildVersion: string;             // Vite `define` constant
  acpSdkVersion: string;            // Vite `define` constant
}
```

`/copy` reads `ctx.inlineMessages` to decide whether there is
anything to copy; the inline runtime never receives built-in
exchanges so a previous `/help` cannot mask a "real" assistant
turn.

### `/mcp` — manage requested MCP servers

`/mcp` lets the user mutate the list of MCP servers their Bodhi
identity has access to, from inside the chat. Source of truth for
the list is a main-thread IDB store at `web-acp:mcp-requested`
(see [`./mcp.md` § Requested-MCPs IDB store](./mcp.md#requested-mcps-idb-store)).
The list is pushed into the worker on every `session/new` and
`session/load` via `_meta.bodhi.requestedMcpUrls` so the handler
can list, validate, and dedupe without round-tripping to the
main thread.

**Subcommands** (parsed locally in `mcp.ts` — `findBuiltin` only
matches the leading `/mcp`, the rest of the input is the
handler's `args`):

| Form | Behaviour |
| --- | --- |
| `/mcp` | List Connected (matched approved instances → original URL via slug heuristic; fall back to Bodhi proxy URL when unmatched) and Pending or denied (requested URLs with no matching instance). Empty state hints at `/mcp add <url>`. |
| `/mcp add <url>` | Canonicalise + check IDB list. **Already present** → reply explains, no action. **New** → reply `Re-authenticating to add \`<url>\`. …`, action `{ kind: 'mcp-add', params: { url } }`. **Parse fail** → reply names the bad URL, no action. |
| `/mcp remove <url>` | Canonicalise + check IDB list. **Missing** → reply explains, no action. **Present** → reply `Removing \`<url>\` and re-authenticating …`, action `{ kind: 'mcp-remove', params: { url } }`. **Parse fail** → reply names the bad URL, no action. |
| any other subcommand | Usage hint, no action. |

**Slug-derivation heuristic** (`mcp/url-canonical.ts`
`deriveSlugFromUrl`): strip leading `mcp.` / `api.` / `www.`
hostname labels, take the next label; fall back to the last
meaningful path segment when the host is generic. Match against
`instance.slug` and `instance.name` (case-insensitive) plus a
substring fallback. Best-effort — unmatched approved instances
still render with the Bodhi proxy URL, so a missed match degrades
to "URL appears in Pending" rather than data loss.

**Action dispatch** in `useAcp.ts`: switch on `action.kind`. For
`mcp-add` / `mcp-remove`, delegate to `addRequestedMcp` /
`removeRequestedMcp` (idempotent, canonicalised), then call
`triggerLoginWithRequested(list)` which **must logout first**
before calling `auth.login(builderFromList)`. Errors and
idempotent no-ops surface via `toast`.

**Logout-then-login surprise** (Principle § 16): the Bodhi SDK's
`login()` short-circuits at the very top with
`if (existingAuth.status === 'authenticated') return existingAuth;`
(see `node_modules/@bodhiapp/bodhi-js/dist/bodhi-web.esm.js`).
Calling `auth.login(opts)` directly from `/mcp add` while the
user holds a valid token therefore no-ops silently — the
transcript line prints, but no redirect happens.

The fix: call `auth.logout()` first. Bodhi's `logout()` only
revokes the **refresh token** at the auth server's `/revoke`
endpoint and clears localStorage; it does **not** call the IDP's
`end_session_endpoint`, so the Keycloak SSO cookie stays valid.
The immediate `login(opts)` that follows then proceeds through
the access-request creation + redirect path; Keycloak's authorize
flow short-circuits silently against the live SSO session, so the
user sees a Bodhi access-request approval screen with **no**
username/password prompt and lands back in the chat with a fresh
token whose scopes reflect the updated MCP list.

**Calling `bodhiClient.requestAccess(body)` directly is not a
viable alternative**: the redirect afterwards needs the
SDK-internal `storageKeys.ACCESS_REQUEST_ID` localStorage key so
`handleAccessRequestCallback` (called automatically by
BodhiProvider on the post-redirect page load) can complete the
OAuth PKCE. That key is `protected` on `DirectClientBase`; we
don't have a public path to write it. Logout-then-login keeps
the dance entirely inside the SDK's public surface.

**The transcript line is durable.** The worker's `prompt()` path
emits the `agent_message_chunk` and writes the `'builtin'`
`SessionEntry` **before** returning (and therefore before the
client's action dispatcher kicks the `auth.login` redirect).
Reload after redirect rebuilds the transcript from Dexie; the
`/mcp add` line is still there, the LLM still hasn't seen it.

**Authenticated-only.** `/mcp` invocations require an active
session, which itself requires authentication. A brand-new user
with an empty IDB list logs in by clicking the standard Login
button (which now reads from the same IDB list, defaulting to
zero MCP scopes). After login, `/mcp add` becomes the path for
expanding the scope set.

### Persistence — the `'builtin'` `SessionEntry` kind

See [`./sessions.md` § Entry kinds](./sessions.md#entry-kinds).
A new `BuiltinPayload` shape is appended to the `entries` table
under the existing `[sessionId+seq]` primary key — no Dexie
version bump because the row's `payload` column is polymorphic
from M1.

```ts
interface BuiltinPayload {
  command: string;
  userText: string;
  replyText: string;
  action?: AnyBodhiBuiltinAction;
}
```

`recordBuiltin` bumps `sessions.updatedAt` but does **not** touch
`turnCount` and does **not** claim the title slot (the first real
prompt still wins).

### Reload — `bodhi/getSession` interleaving

`AcpAgentAdapter.extMethod(BODHI_GET_SESSION_METHOD, …)` walks
entries in `seq` order:

- Each `'turn'` entry's `finalMessages` is the cumulative
  LLM-visible history at that point. The handler appends the
  delta (the new user + assistant pair, if any) to the rendered
  list and remembers the snapshot for the next diff.
- Each `'builtin'` entry inserts a synthetic user + assistant pair
  in the rendered list, both tagged with a `_builtin` field carrying
  `BodhiBuiltinTag` (`{ command, action? }`).

`inline.restoreMessages()` (called from `loadSession`) reads only
the last `'turn'`'s `finalMessages`; built-in entries never enter
LLM-visible history.

### LLM blindness invariant

The contract:

> The LLM never sees the `/help` invocation, the `/help` reply,
> or any built-in exchange. This holds for fresh sessions and for
> sessions resumed via `session/load`.

Mechanism:

1. `prompt()` short-circuits before `inline.prompt(text)` for
   built-ins. No LLM call, no `inline.state.messages` mutation, no
   `recordTurn`.
2. `loadSession` rebuilds inline state from `'turn'` entries only;
   `'builtin'` entries are silently skipped.
3. The `BODHI_GET_SESSION_METHOD` snapshot returns built-ins in
   the rendered transcript for the UI but the inline runtime is
   untouched on the worker side.

Verified by the adapter tests
`packages/web-acp/src/acp/agent-adapter.test.ts` (see "M4 phase B"
describe block).

## Client-side surfaces

### User-bubble tagging

`useAcp.sendMessage` runs a lightweight `detectBuiltinTag(input)`
against the static built-in name list before appending the local
user message. When the input is a built-in invocation the local
bubble carries a `_builtin: { command }` field. The worker is
**not** involved — the worker emits no user-message-side `_meta`
for built-ins. Reload-time tagging falls out of the worker's
`bodhi/getSession` interleaving (the worker stamps `_builtin` on
both bubbles for any persisted `'builtin'` entry).

### Assistant-bubble tagging + action dispatch

In the `session/update` handler in `useAcp.ts`:

- `extractBuiltinMeta(notification._meta)` returns the
  `BodhiBuiltinTag` carried on a built-in's `agent_message_chunk`.
- During chunk accumulation the streaming message is tagged via
  `withBuiltinTag(...)`.
- After `runtime.client.prompt(...)` resolves, if the streaming
  message carries an `action`, the client dispatches it via the
  in-hook `dispatchBuiltinAction` switch. Each `kind` narrows
  to its per-kind shape:

  ```ts
  switch (action.kind) {
    case 'copy':
      await dispatchCopyAction(messagesRef.current);
      return;
    case 'mcp-add': {
      const { list, added, canonical } = await addRequestedMcp(action.params.url);
      // …idempotency + parse-failure paths surface via toast…
      await triggerLoginWithRequested(list); // builds LoginOptions, calls auth.login
      return;
    }
    case 'mcp-remove': /* mirror */
  }
  ```

  Failures and idempotent no-ops surface via `toast.error` /
  `toast.info` while the in-transcript line still renders
  (transcript = optimistic agent record; toast = actual client
  outcome).

### Markdown rendering — `renderConversationMarkdown`

In `src/lib/builtin-format.ts`. Filters out:

- `_builtin`-tagged messages (so `/help` exchanges don't end up in
  a `/copy` payload).
- `role === 'toolResult'` messages.
- Empty user/assistant text (so tool-call-only assistant turns
  don't produce stub blocks).

Renders the rest as `**You:** … **Assistant:** …` blocks separated
by blank lines. The output is what `clipboard.writeText` receives.

### Render distinction — `MessageBubble`

When `getBuiltinTag(message)` is set:

- Background switches to a muted variant
  (`bg-blue-100 text-blue-900` for user; `bg-gray-100 text-gray-700`
  for assistant).
- A small "not sent to LLM" badge renders above the body:
  `data-testid="builtin-badge"`, `data-test-state="builtin"` on
  the bubble, `data-builtin-command="<command>"` for selectors.

Test seams are stable enough that Playwright can assert without
reaching into `page.evaluate`.

## Build constants — `vite.config.ts`

Added to the existing `define` block:

```ts
__WEB_ACP_VERSION__: JSON.stringify(WEB_ACP_VERSION),
__ACP_SDK_VERSION__: JSON.stringify(ACP_SDK_VERSION),
```

Sourced via `JSON.parse(readFileSync(...))` against this package's
own `package.json` and the resolved
`@agentclientprotocol/sdk/package.json` at config-eval time.
Ambient declarations live alongside `__WEB_ACP_DEV__` in
`src/vite-env.d.ts`. The constants are read by
`src/acp/agent-adapter.ts` (`BUILD_VERSION`, `ACP_SDK_VERSION`)
and surfaced to handlers via `BuiltinHandlerCtx`.

## Tests

### Unit (vitest)

- `packages/web-acp/src/agent/commands/builtins/builtins.test.ts` —
  one block per built-in handler + `findBuiltin` + `isBuiltinName`
  + `builtinAvailableCommands`.
- `packages/web-acp/src/lib/builtin-format.test.ts` —
  `extractBuiltinMeta`, `getBuiltinTag` / `withBuiltinTag` round
  trip, `renderConversationMarkdown` filtering rules.
- `packages/web-acp/src/agent/session-store.test.ts` (extended) —
  `recordBuiltin` round-trip, action persistence, error on unknown
  session, interleaving with `recordTurn`.
- `packages/web-acp/src/acp/agent-adapter.test.ts` (extended) —
  no LLM call on built-in, `_meta.bodhi.builtin` on the chunk,
  persisted `'builtin'` entries distinct from `'turn'`, real prompt
  after a built-in still calls `inline.prompt` exactly once,
  `bodhi/getSession` interleaves built-in entries with tagged
  user+assistant pairs.

### Playwright e2e

`packages/web-acp/e2e/builtins.spec.ts` — single spec with
`test.step` blocks: picker shows built-ins; `/copy` no-op path;
`/help` muted bubbles + badge; real LLM turn → `/copy` writes
markdown to clipboard, toasts, and the markdown excludes built-in
turns; reload preserves built-in bubbles still tagged.

## Critical files

- `packages/web-acp/src/agent/commands/{loader,expander,front-matter,path,types}.ts`
  (phase A vault loader)
- `packages/web-acp/src/agent/commands/builtins/{types,help,version,session,copy,mcp,index}.ts`
  (phase B registry)
- `packages/web-acp/src/acp/agent-adapter.ts`
  (`#refreshAvailableCommands`, `prompt()` interception, `loadSession`,
  `BODHI_GET_SESSION_METHOD` interleaving, `#tryHandleBuiltin`,
  `extractSessionMeta`)
- `packages/web-acp/src/agent/session-store.ts`
  (`SessionEntryKind`, `BuiltinPayload`, `recordBuiltin`)
- `packages/web-acp/src/acp/index.ts`
  (`BodhiBuiltinAction<K, P>`, `AnyBodhiBuiltinAction`,
  `BodhiBuiltinMeta`, `BodhiBuiltinTag`, `BodhiSessionMeta`,
  `BodhiMcpInstanceDescriptor`)
- `packages/web-acp/src/hooks/useAcp.ts`
  (send-time tagging, `_meta.bodhi.builtin` extraction,
  `dispatchBuiltinAction` discriminated-union switch,
  `composeSessionMeta`, `triggerLoginWithRequested`)
- `packages/web-acp/src/mcp/requested-mcps-store.ts`
  (`web-acp:mcp-requested` IDB key, `loadRequestedMcps`,
  `addRequestedMcp`, `removeRequestedMcp`)
- `packages/web-acp/src/mcp/url-canonical.ts`
  (`canonicalizeMcpUrl`, `deriveSlugFromUrl`)
- `packages/web-acp/src/agent/commands/builtins/mcp.ts`
  (`/mcp` handler + subcommand dispatch + slug-match logic)
- `packages/web-acp/src/components/Header.tsx`
  (login click reads `loadRequestedMcps()` instead of
  hardcoded URLs)
- `packages/web-acp/src/lib/builtin-format.ts`
  (`extractBuiltinMeta`, `getBuiltinTag`, `withBuiltinTag`,
  `renderConversationMarkdown`)
- `packages/web-acp/src/components/chat/MessageBubble.tsx`
  (muted variant + badge + test-state attributes)
- `packages/web-acp/vite.config.ts`,
  `packages/web-acp/src/vite-env.d.ts` (build constants)

## Out of scope (carried forward)

State-mutation built-ins (`/name`, `/model`, `/new`, `/resume`,
`/settings`, `/login`, `/logout`) land in the next slice.
`/compact` ships with M7. `/fork` and `/tree` ship with M6.
`/export`, `/import`, `/share`, `/quit` are browser-incompatible
and stay deferred. Extension-registered commands / templates /
skills enter with M5. Prompt templates and skills are M4.2 / M4.3
sub-milestones not yet started.

## Change procedure

Any plan that edits files under
`packages/web-acp/src/agent/commands/` or the wiring in
`src/acp/agent-adapter.ts`, `src/hooks/useAcp.ts`,
`src/lib/builtin-format.ts`, or `src/components/chat/MessageBubble.tsx`
must update this file in the same commit. New built-ins land here
with their handler shape and the `BuiltinHandlerCtx` fields they
consume; new client-action kinds land here with their dispatch
contract.

See [`./index.md` § Change procedure](./index.md#change-procedure).
