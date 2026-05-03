# Commands — vault sources, prompt templates, built-ins

**Source of truth (agent package):** `packages/web-acp-agent/src/agent/commands/`.

## Purpose

The agent advertises a single merged list of slash commands
through ACP `available_commands_update` notifications. Three
sources, all with the same wire shape (`AvailableCommand` —
ACP has no kind discriminator):

1. **Built-ins** — agent-handled (`/help`, `/version`,
   `/info`, `/copy`, `/mcp`). M4 phase B. Source:
   `agent/commands/builtins/`.
2. **Vault commands** — `<mount>/.pi/commands/**/*.md`. M4
   phase A. Source: `agent/commands/loader.ts:loadCommandsFromVolumes`.
3. **Prompt templates** — `<mount>/.pi/prompts/**/*.md`. M4.2
   first slice. Source: `agent/commands/loader.ts:loadPromptsFromVolumes`.

Built-ins are intercepted in `prompt-driver.ts:run` *before*
LLM resolution (early-return path), so they never count
against the LLM history. Vault commands and prompt templates
are **template substitutions**: the literal `/<name> <args>`
in the prompt is replaced with the rendered template body
before the LLM sees the request.

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
2. Sort `files` lexicographically so output is stable.
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
     fallbackDescription(body)` (first non-empty body line,
     truncated to 120 chars).
   - `argumentHint` — `frontMatter['argument-hint']`.
   - `template` — body (front-matter stripped).
   - `source` — `{ mountName, relPath: '<dirRelpath>/<rel>' }`.

Cross-source dedup happens upstream in
`acp/engine/session-runtime.ts:refreshAvailableCommands`:
commands win on canonical-name collision; prompts losing get a
`[prompts]` warning logged.

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
- Comments are not supported (lines starting with `#` are
  treated as keys and rejected).

Failures throw `FrontMatterError` (also exported); the loader
catches and warns.

## Expansion — `agent/commands/expander.ts`

`expandCommand(text, commands)` (`:26`) is the substitution
engine. Pattern `^/(\S+)(?:[ \t]+([\s\S]*))?$` (`:24`) — the
slash command must occupy the entire text block. Matching is
exact-name only.

Argument tokenization via `tokenizeBash(input)` (`:47`) —
bash-style: single quotes verbatim, double quotes with `\\`
and `\"` escapes (everything else literal), backslash escapes
outside quotes, whitespace separates tokens. **Variable
interpolation (`$VAR`) is intentionally skipped** so a
template can reference `$HOME` literally without surprise.

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
| `version` | `version.ts` | Reports `buildVersion` + `acpSdkVersion` from `BuiltinHandlerCtx`. |
| `info` | `info.ts` | Reports current session: model, server URL, turn / message counts, connected MCP servers, mounted volumes. Renamed from `/session` in commit `ec152c1e` so it doesn't collide with the CLI host's session-management command. |
| `copy` | `copy.ts` | Returns `{ replyText: '…copied…', action: { kind: 'copy' } }`. The host dispatcher (`web-acp-client`'s `acp/builtin-dispatch.ts:dispatchBuiltinAction`) builds the markdown locally from `messages` state — the agent doesn't ship the payload across the wire. |
| `mcp` | `mcp.ts` | `mcp list` / `mcp add <url>` / `mcp remove <url>` — emits `{ action: { kind: 'mcp-add' \| 'mcp-remove', params: { url } } }` for `add` / `remove`; `list` emits no action. |

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
`acp/engine/builtin-dispatch.ts:tryHandleBuiltin` (line 40)
from runtime accessors. Fields: `sessionId`, `modelId`,
`serverUrl`, `sessionStats: { turnCount, messageCount }`,
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
`AnyBodhiBuiltinAction` (`packages/web-acp-agent/src/wire/index.ts:198`):

```ts
type AnyBodhiBuiltinAction =
    | BodhiBuiltinCopyAction          // { kind: 'copy' }
    | BodhiBuiltinMcpAddAction        // { kind: 'mcp-add', params: { url } }
    | BodhiBuiltinMcpRemoveAction     // { kind: 'mcp-remove', params: { url } }
```

The discriminated-union pattern `BodhiBuiltinAction<K, P>` is
defined at `wire/index.ts:181` — payload-conditional
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
`loadSession`, via `acp/engine/session-runtime.ts:refreshAvailableCommands`
(`:271`). Order: built-ins first (5 entries), then vault
commands + prompts merged. Hosts treat the list as a
black-box `AvailableCommand[]` — no kind discriminator on the
wire (added in M4.2 first slice; the agent picks one source
per name with commands winning).

## `_meta.bodhi.builtin` envelope

Built-in replies ride the standard `agent_message_chunk`
notification with a tag stamped on `_meta`:

```json
{
  "sessionId": "bodhi-…",
  "update": {
    "sessionUpdate": "agent_message_chunk",
    "content": { "type": "text", "text": "<replyText>" }
  },
  "_meta": {
    "bodhi": {
      "builtin": {
        "command": "<name>",
        "action": { "kind": "...", "params": {...} }
      }
    }
  }
}
```

Hosts read the meta via
`acp/wire-utils.ts:extractMcpMeta` siblings (and the host-side
streaming reducer carries the tag onto the message bubble for
the muted-built-in render). The action dispatch happens in
the host's `dispatchBuiltinAction` —
[`../web-acp-client/acp.md`](../web-acp-client/acp.md).

## `'builtin'` `SessionEntry` kind

Persistence rides via
`acp/engine/builtin-dispatch.ts:tryHandleBuiltin` (`:80`)
calling `services.store.recordBuiltin(sessionId, payload)`.
`BuiltinPayload` shape:
`{ command, userText, replyText, action? }`. Replay rebuilds
the muted-builtin pair via the agent's
`bodhi/getSession` interleaving so the host UI can render the
historical bubble correctly without re-walking the chunks.

See [`sessions.md`](./sessions.md) for the full entry shape +
replay semantics.

## Cross-references

- Engine layer that drives expansion + built-in early return:
  [`acp.md`](./acp.md).
- Persistence (`'builtin'` entries, `bodhi/getSession`
  rebuild): [`sessions.md`](./sessions.md).
- Host-side built-in action dispatch (`/copy`, `/mcp add`):
  [`../web-acp-client/acp.md`](../web-acp-client/acp.md) +
  [`../web-acp-client/commands.md`](../web-acp-client/commands.md).
- Volume registry that backs vault discovery:
  [`volumes.md`](./volumes.md).
