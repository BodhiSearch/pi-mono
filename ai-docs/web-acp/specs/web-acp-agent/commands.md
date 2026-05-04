# Commands — vault sources, prompt templates, built-ins

**Source of truth (agent package):**
`packages/web-acp-agent/src/agent/commands/`,
`packages/web-acp-agent/src/acp/engine/builtin-dispatch.ts`.

## Purpose

The agent advertises a single merged list of slash commands
through ACP `available_commands_update` notifications. Three
sources, all with the same wire shape (`AvailableCommand` —
ACP has no kind discriminator):

1. **Built-ins** — agent-handled (`/help`, `/version`,
   `/info`, `/copy`, `/mcp`). Source:
   `agent/commands/builtins/`.
2. **Vault commands** — `<mount>/.pi/commands/**/*.md`. Source:
   `agent/commands/loader.ts:loadCommandsFromVolumes`.
3. **Prompt templates** — `<mount>/.pi/prompts/**/*.md`. Source:
   `agent/commands/loader.ts:loadPromptsFromVolumes`.

Built-ins are intercepted in
`acp/engine/prompt-driver.ts:#runTurn` *before* LLM resolution
(early-return path), so they never count against the LLM
history. Vault commands and prompt templates are **template
substitutions**: the literal `/<name> <args>` in the prompt is
replaced with the rendered template body before the LLM sees
the request.

## Discovery — `agent/commands/loader.ts`

The loader walks `<mount>/<dirRelpath>/**/*.md` for every
mounted volume. Two public entry points sharing one private
implementation:

- `loadCommandsFromVolumes(input)` (`:47`) — `dirRelpath =
  COMMANDS_DIR_RELPATH = '.pi/commands'`. Warning prefix
  `[commands]`.
- `loadPromptsFromVolumes(input)` (`:61`) — `dirRelpath =
  PROMPTS_DIR_RELPATH = '.pi/prompts'`. Warning prefix
  `[prompts]`.

Input shape (`CommandsLoaderInput`, `:39`):

```ts
interface CommandsLoaderInput {
    mounts: ReadonlyArray<{ mountName: string }>;
    fs: CommandsFs;
    warn?: (msg: string, err?: unknown) => void;
}
```

`CommandsFs` (`:32`) is a tiny abstraction so unit tests can
drive the loader with a synthetic file system. Production
calls construct it via
`agent/commands/loader.ts:createZenfsCommandsFs` (`:174`),
which wraps `@zenfs/core`'s global `zenfs.promises` and
swallows `ENOENT` / `ENOTDIR` so a missing `.pi/commands/`
directory reads as empty.

Per-mount discovery flow (`loadFromVolumes`, `:71`):

1. Recursively walk `/mnt/<mountName>/<dirRelpath>` collecting
   `*.md` files (skips dotfiles via the `entry.name.startsWith('.')`
   guard).
2. Sort `files` via `localeCompare` (locale-aware) so output is
   stable.
3. For each file: derive `name` via
   `canonicalCommandName({ mountName, pathBelowCommands: rel })`;
   skip with warning if invalid path.
4. **First-wins dedup** within the load: if `name` already
   seen, skip with warning (`'duplicate <name> from /mnt/...
   ignored (first registered from /mnt/...)'`).
5. Read + parse front-matter; on parse failure skip with
   warning.
6. Build `CommandDef`:
   - `name` — canonical, fully-qualified.
   - `description` — `frontMatter.description ?? trim() ||
     fallbackDescription(body)`. `fallbackDescription` returns
     the first non-empty body line (truncated to 120 chars), or
     the literal `'(no description)'` if the body has no
     non-empty first line.
   - `argumentHint` — `frontMatter['argument-hint']`.
   - `template` — body (front-matter stripped).
   - `source` — `{ mountName, relPath: '<dirRelpath>/<rel>' }`.

Cross-source dedup happens upstream in
`acp/engine/session-runtime.ts:refreshAvailableCommands`
(`:243`): commands win on canonical-name collision; prompts
losing get a `[prompts]` warning logged.

## Canonical naming — `agent/commands/path.ts`

`canonicalCommandName({ mountName, pathBelowCommands })`
(`:22`) derives the wire-name from the mount + relative path.
Rules:

- Pattern: `[a-z][a-z0-9-]*` per segment.
- File at `<mount>/.pi/commands/a/b/name.md` →
  canonical name `<mount>:a:b:name` (Claude Code's
  `<plugin>:<skill>` namespacing applied to volumes).
- The `.md` suffix is stripped from the leaf segment before
  validation.
- Throws `InvalidCommandPathError` (also exported from the
  module) if any segment fails the pattern; the loader
  catches and warns rather than crashing the whole load.

Constants `COMMANDS_DIR_RELPATH` (`'.pi/commands'`) and
`PROMPTS_DIR_RELPATH` (`'.pi/prompts'`) are exported so hosts
can advertise the layout to users.

## Front-matter — `agent/commands/front-matter.ts`

Minimal YAML-ish parser: `parseFrontMatter(raw)` returns
`{ frontMatter: Record<string, string>, body: string }`.

Supports:

- `---` opening delimiter on the first line; closing `---` on
  some later line.
- `key: value` lines (single-line strings only; no nested
  arrays / objects / multi-line scalars).
- Lines starting with `#` are skipped as comments.
  Inline `# trailing` comments after a value are not stripped —
  they end up in the value string.

Failures throw `FrontMatterError` (also exported); the loader
catches and warns.

## Expansion — `agent/commands/expander.ts`

`expandCommand(text, commands)` (`:26`) is the substitution
engine. Pattern `^/(\S+)(?:[ \t]+([\s\S]*))?$` (`:24`) — the
slash command must occupy the entire text block. Matching is
exact-name only.

Argument tokenization via `tokenizeBash(input)` (`:47`) —
bash-style: single quotes verbatim, double quotes unescape
`\\`, `\"`, `\$`, and `` \` `` (everything else literal),
backslash escapes outside quotes, whitespace separates
tokens. **Variable interpolation (`$VAR`) is intentionally
skipped** so a template can reference `$HOME` literally without
surprise.

Substitution (`substitute`, `:123`):

1. Replace `$ARGUMENTS` with the raw args string (verbatim,
   pre-tokenisation).
2. Replace `$@` with the raw args string.
3. Replace `$1`..`$9` with the matching positional token,
   leaving the `$N` literal untouched when out of range (so
   authors notice missing args).

Order matters: named tokens (`$ARGUMENTS`, `$@`) replace
*before* positional `$N` to avoid partial eats.

Result (`ExpansionResult`, `:18`):

```ts
{ matched: true, expanded: '<rendered>', commandName: '<name>' }
// or
{ matched: false }
```

The driver substitutes `block.text = result.expanded` only
when `matched && typeof expanded === 'string'`. Unmatched
texts pass through to the LLM untouched (so the user / model
gets to interpret unknown slashes — useful when the user
types `/hello` for casual chat).

## Built-ins — `agent/commands/builtins/`

Five commands ship today:

| Command | File | Description |
| --- | --- | --- |
| `help` | `help.ts` | Lists every advertised command (built-ins + vault). |
| `version` | `version.ts` | Reports `web-acp` build, `ACP SDK` version, `Model` (`ctx.modelId`), and `Bodhi server` URL (`ctx.serverUrl`) from `BuiltinHandlerCtx`. |
| `info` | `info.ts` | Reports current session: `Id`, `Turns`, `Messages (LLM-visible)`, `Model`, `MCP servers`. Renamed from `/session` so it doesn't collide with the CLI host's session-management command. |
| `copy` | `copy.ts` | Returns `{ replyText: '…copied…', action: { kind: 'copy' } }`. The host dispatcher (`web-acp-client`'s `acp/builtin-dispatch.ts:dispatchCopyAction`) builds the markdown locally from `messages` state — the agent doesn't ship the payload across the wire. |
| `mcp` | `mcp.ts` | `/mcp` (no args) lists Connected + Pending; `/mcp add <url>` / `/mcp remove <url>` emit `{ action: { kind: 'mcp-add' \| 'mcp-remove', params: { url } } }`. List emits no action. URLs are canonicalised via `mcp/url-canonical.ts:canonicalizeMcpUrl` before comparison; idempotent. |

### `BuiltinCommand` shape — `builtins/types.ts:68`

```ts
interface BuiltinCommand {
    name: string;
    description: string;
    inputHint?: string;
    handler: (args: string, ctx: BuiltinHandlerCtx)
        => BuiltinResult | Promise<BuiltinResult>;
}
```

### `BuiltinHandlerCtx` — `builtins/types.ts:34`

The narrow snapshot every handler sees. Built by
`acp/engine/builtin-dispatch.ts:tryHandleBuiltin` (`:42`).
`modelId` reads from `session?.currentModelId` (per-session
state set by `unstable_setSessionModel`); `serverUrl` reads
`services.bodhi.getBaseUrl()`; `mcpInstances` and
`requestedMcpUrls` read from the **per-session** `SessionState`
(`session?.mcpInstances` / `session?.requestedMcpUrls`);
`sessionStats` and `mcpServersConnected` come through runtime
accessors.

Fields: `sessionId`, `modelId`, `serverUrl`,
`sessionStats: { turnCount, messageCount }`,
`mcpServersConnected: string[]`,
`mcpInstances: BuiltinMcpInstance[]`,
`requestedMcpUrls: string[]`,
`advertisedCommands: AvailableCommand[]`,
`inlineMessages: AgentMessage[]`, `buildVersion`,
`acpSdkVersion`. Treat as immutable.

`BuiltinMcpInstance` (`:21`): `{ slug, name, path }` — the
projection of a Bodhi-side MCP entry the worker received via
`_meta.bodhi.mcpInstances` on `session/new` / `session/load`.

### `BuiltinResult` — `builtins/types.ts:63`

```ts
{ replyText: string; action?: BuiltinAction }
```

`BuiltinAction` is a re-export of the wire-level
`AnyBodhiBuiltinAction` (`packages/web-acp-agent/src/wire/index.ts:134`):

```ts
type AnyBodhiBuiltinAction =
    | BodhiBuiltinCopyAction          // { kind: 'copy' }
    | BodhiBuiltinMcpAddAction        // { kind: 'mcp-add', params: { url } }
    | BodhiBuiltinMcpRemoveAction     // { kind: 'mcp-remove', params: { url } }
```

The discriminated-union pattern `BodhiBuiltinAction<K, P>` is
defined at `wire/index.ts:117` — payload-conditional
(`[P] extends [void] ? { kind: K } : { kind: K; params: P }`).
New built-ins that need a client-side action either reuse one
of the existing kinds or extend the union by adding a new
alias type.

### Detection — `builtins/index.ts:findBuiltin`

`findBuiltin(text)` (`:40`) is the dispatcher's match
function. Matches `/<name>` strictly: end-of-string or
followed by whitespace. Vault commands sharing a longer
prefix can never be misclassified as built-ins because of the
strict whitespace boundary.

`isBuiltinName(name)` (`:52`) returns `true` if `name` is in
`BUILTIN_NAMES`. Used by the host's `acp/message-shape.ts` to
detect a built-in invocation when constructing a *user*
message tag (built-in user bubbles also get the muted-builtin
treatment).

`builtinAvailableCommands()` (`:56`) returns the full set as
ACP `AvailableCommand[]`; merged with vault commands by
`refreshAvailableCommands`.

## Wire surface — `available_commands_update`

The advertisement runs once per `newSession` and once per
`loadSession`, via
`acp/engine/session-runtime.ts:refreshAvailableCommands`
(`:243`). Order: built-ins first (5 entries), then vault
commands + prompts merged. Hosts treat the list as a
black-box `AvailableCommand[]` — no kind discriminator on the
wire (the agent picks one source per name, with commands
winning).

## Built-in reply wire path — `acp/engine/builtin-dispatch.ts:tryHandleBuiltin`

Built-in dispatch is split across **two wire envelopes**: the
muted-bubble reply rides standard `agent_message_chunk`; the
optional client action rides `extNotification("_bodhi/builtin/action", …)`.
This is the only place the engine bypasses
`runtime.emit`/`runtime.sendRawNotification` — both calls go
direct on `conn` to avoid double-persistence (the `'builtin'`
store entry below is the single source of truth for replay).

### Reply chunk — `agent_message_chunk` with `_meta.bodhi.builtin`

```json
{
    "sessionId": "bodhi-…",
    "update": {
        "sessionUpdate": "agent_message_chunk",
        "content": { "type": "text", "text": "<replyText>" }
    },
    "_meta": {
        "bodhi": {
            "builtin": { "command": "<name>" }
        }
    }
}
```

The chunk carries the muted-bubble tag at
`_meta.bodhi.builtin.command`; `action` is **not** stamped on
the chunk anymore. Hosts read the meta via the host-side
`streamingReducer`'s `session/update` branch, which inspects
`update.update._meta?.bodhi?.builtin?.command` and stamps the
tag onto the message bubble for the muted-built-in render.

### Action notification — `_bodhi/builtin/action`

When `BuiltinResult.action` is set, `tryHandleBuiltin` emits
(`:84–94`):

```ts
conn.extNotification(
    BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD, // '_bodhi/builtin/action'
    {
        sessionId,
        command: match.cmd.name,
        action: result.action,
    } satisfies BodhiBuiltinActionNotificationParams,
);
```

Shape `BodhiBuiltinActionNotificationParams` (defined at
`wire/index.ts:200`):
`{ sessionId, command, action: AnyBodhiBuiltinAction }`. The
host's `extNotification` sink (registered when
`AcpClient.connect` builds `ClientSideConnection`) routes the
method to `dispatchBuiltinAction` —
[`../web-acp-client/acp.md`](../web-acp-client/acp.md).

## `'builtin'` `SessionEntry` kind

Persistence rides via
`acp/engine/builtin-dispatch.ts:tryHandleBuiltin` (`:97`)
calling `services.store.recordBuiltin(sessionId, payload)`.
`BuiltinPayload` shape:
`{ command, userText, replyText, action? }`. The action is
persisted alongside the reply so a `_bodhi/session/get`
rebuild can reconstruct the muted-builtin pair (and replay the
side-effect descriptor for any host that wants to render past
copy / mcp-add intents).

See [`sessions.md`](./sessions.md) for the full entry shape +
replay semantics.

## Cross-references

- Engine layer that drives expansion + built-in early return:
  [`acp.md`](./acp.md).
- Persistence (`'builtin'` entries, `_bodhi/session/get`
  rebuild): [`sessions.md`](./sessions.md).
- Host-side built-in action dispatch (`/copy`, `/mcp add`):
  [`../web-acp-client/acp.md`](../web-acp-client/acp.md) +
  [`../web-acp-client/commands.md`](../web-acp-client/commands.md).
- Volume registry that backs vault discovery:
  [`volumes.md`](./volumes.md).
