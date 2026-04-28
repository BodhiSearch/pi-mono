# /mcp built-in command — plan

## Context

Today `packages/web-acp/src/components/Header.tsx` hardcodes two
`builder.addMcpServer(...)` calls in the login click handler
(Everything via `VITE_MCP_EVERYTHING_URL` / `window.__mcpEverythingUrl`,
DeepWiki via `https://mcp.deepwiki.com/mcp`). The OAuth scope request
that hits BodhiApp is built from these calls; the JWT comes back with
those (and only those) scopes; `bodhiClient.mcps.list()` returns the
approved subset. Adding or removing an MCP today means editing
`Header.tsx`.

The redesign moves the requested-MCPs list onto the user's browser as
a main-thread IDB store (mirror of `vault/fsa-handle-store.ts`). Users
mutate the list via a new `/mcp` built-in slash command, riding the
M4 phase B `_meta.bodhi.builtin = { command, action? }` envelope.
After mutation, `auth.login(builderFromIDB)` is re-issued — Bodhi's
SSO short-circuits to an approval screen (no password re-entry), the
page redirects back, and the existing token-rotation effect in
`useAcp.ts` (lines 460–539) re-issues `session/load` with the
freshly-composed `mcpServers`. The active session survives the
round-trip via M1 persistence.

`/mcp` is **authenticated-only** — pre-login the user clicks Login
which now sends an empty (or IDB-list) scope set. After login, `/mcp
add <url>` and `/mcp remove <url>` mutate the list and re-trigger
login. Bare `/mcp` lists Connected (Bodhi-approved instances, matched
back to user URLs via a slug-derivation heuristic) and Pending or
denied (URLs in the IDB list with no matching Bodhi instance).

## Working decisions resolved with the user

- **Display**: URLs (not slugs) for both Connected and Pending sections.
- **Matching**: slug-derivation heuristic — derive a candidate slug
  from each requested URL, match against `instance.slug` and
  `instance.name`. Unmatched Connected instances (e.g. MCPs Bodhi has
  from prior cycles) fall back to the Bodhi proxy URL.
- **/mcp gating**: authenticated-only. Login button (which triggers
  `auth.login`) becomes the only path for an unauthenticated user
  with an empty IDB list.

## Wire shape

Two minimal extensions to existing M4 phase B / M3 surfaces. **No new
`_bodhi/*` extension methods.**

### 1. Action payload (extended `BodhiBuiltinAction`)

`packages/web-acp/src/acp/index.ts` and
`packages/web-acp/src/agent/commands/builtins/types.ts`:

```ts
export interface BodhiBuiltinAction {
  kind: string;        // 'copy' | 'mcp-add' | 'mcp-remove' | …
  url?: string;        // present for 'mcp-add' and 'mcp-remove'
}
```

`extractBuiltinMeta` in `packages/web-acp/src/lib/builtin-format.ts`
extends to copy `url` (string-typed only) into the tag.
`BuiltinPayload.action` in `packages/web-acp/src/agent/session-store.ts`
extends to `{ kind: string; url?: string }`. Persistence already
serialises arbitrary action shapes; no Dexie migration needed (payload
is polymorphic JSON).

### 2. `_meta.bodhi.requestedMcpUrls` on `session/new` + `session/load`

The worker needs to know "what URLs the user has requested" so
`/mcp` (list) can compute Pending and `/mcp add` / `/mcp remove`
can give correct idempotency feedback. Pass via standard ACP
`_meta` extensibility on the two session entry points:

```jsonc
// newSession / loadSession params
{
  "_meta": { "bodhi": { "requestedMcpUrls": ["https://mcp.deepwiki.com/mcp", …] } }
}
```

The worker stores `requestedMcpUrls` per session alongside its
existing per-session state. Re-passed automatically on every
`session/load` re-issue (token rotation already does this — we
fold the IDB read into `composeCurrentMcpServers`'s siblings).

Source of truth is the main-thread IDB list. The worker treats it
as read-only state.

## Main-thread changes

### New file: `packages/web-acp/src/mcp/requested-mcps-store.ts`

Mirror `vault/fsa-handle-store.ts`. Key: `'web-acp:mcp-requested'`.
Value: `string[]` (canonical URLs).

```ts
export const REQUESTED_MCPS_IDB_KEY = 'web-acp:mcp-requested';

export async function loadRequestedMcps(): Promise<string[]>;
export async function saveRequestedMcps(urls: string[]): Promise<void>;
export async function clearRequestedMcps(): Promise<void>;

// Idempotent ops shared with the action dispatcher.
export async function addRequestedMcp(url: string): Promise<{ list: string[]; added: boolean }>;
export async function removeRequestedMcp(url: string): Promise<{ list: string[]; removed: boolean }>;
```

Same swallow-errors-on-write pattern as `fsa-handle-store.ts` (return
`[]` on missing/parse-fail).

### New file: `packages/web-acp/src/mcp/url-canonical.ts`

```ts
// Single canonicalisation rule applied at IDB-write AND at
// match-against-approved-list time.
export function canonicalizeMcpUrl(input: string): string | null {
  try {
    const u = new URL(input.trim());
    return u.toString();   // normalises port, lowercases host, preserves path/query/hash
  } catch {
    return null;
  }
}

// Slug-derivation heuristic for the matching display.
// Strategy: hostname's first non-generic label (strip leading 'mcp.', 'api.'),
// fall back to the last meaningful path segment. Lowercase. Used for
// best-effort match against `instance.slug` and `instance.name`.
export function deriveSlugFromUrl(url: string): string;
```

### Modify: `packages/web-acp/src/components/Header.tsx`

Replace the two `addMcpServer(...)` calls with a read of the IDB
store. Same builder pattern; the URL list is now data-driven.

```ts
const requestedUrls = await loadRequestedMcps();
const builder = new LoginOptionsBuilder()
  .setFlowType('redirect')
  .setRole('scope_user_user');
for (const url of requestedUrls) builder.addMcpServer(url);
const authState = await login(builder.build());
```

The `VITE_MCP_EVERYTHING_URL` / `window.__mcpEverythingUrl` test seam
**moves**: instead of injecting URLs into the login click handler,
the e2e harness now seeds the IDB requested list before page load
(see e2e section below). Header.tsx no longer reads either.

### Modify: `packages/web-acp/src/hooks/useAcp.ts`

Three changes:

1. **`composeCurrentMcpServers` siblings**: introduce
   `loadCurrentRequestedMcps()` (reads IDB, canonicalises, dedups)
   and pass the result via `_meta.bodhi.requestedMcpUrls` on every
   `newSession`, `loadSession` (including the rotation re-issue at
   lines 509–521 and the auto-`ensureSession` path).

2. **`dispatchBuiltinAction`** (lines 234–251) extends to two new
   kinds:

   ```ts
   case 'mcp-add': {
     if (!action.url) return;
     const { list, added } = await addRequestedMcp(action.url);
     if (!added) {
       toast.info('Already requested — no change.');
       return;
     }
     await triggerLoginWithList(list); // builds LoginOptions, calls auth.login
     return;
   }
   case 'mcp-remove': {
     if (!action.url) return;
     const { list, removed } = await removeRequestedMcp(action.url);
     if (!removed) {
       toast.info('Not in requested list — no change.');
       return;
     }
     await triggerLoginWithList(list);
     return;
   }
   ```

   Errors from `auth.login` mirror Header.tsx's existing pattern
   (`if (authState?.status === 'error') toast.error(...)`).

3. **DEV-seed boot** parallel to `useDevSeedBoot` for volumes — at
   first render, if `window.__mcpRequestedSeed` is set, seed the IDB
   store before the app reads it. Production builds dead-code via
   `import.meta.env.DEV`.

## Worker changes

### Modify: `packages/web-acp/src/acp/agent-adapter.ts`

1. **Per-session `requestedMcpUrls` storage**: read from
   `params._meta.bodhi.requestedMcpUrls` on `newSession` and
   `loadSession`, store on the per-session record alongside
   `mcpServers`.

2. **`BuiltinHandlerCtx` extension** in
   `packages/web-acp/src/agent/commands/builtins/types.ts`:

   ```ts
   export interface BuiltinHandlerCtx {
     // …existing fields…
     requestedMcpUrls: string[];          // canonical URLs from IDB
     mcpInstancesConnected: McpInstanceLite[]; // {slug, name, path} for matching
   }
   ```

   Populated in `#tryHandleBuiltin` from the per-session record.
   `mcpInstancesConnected` is derived from the existing
   `mcpServersConnected` lifecycle ledger (already tracked) joined
   with the per-session McpInstanceView snapshot. Add
   `_meta.bodhi.mcpInstances` alongside `requestedMcpUrls` if the
   ledger doesn't already carry name/slug.

### New file: `packages/web-acp/src/agent/commands/builtins/mcp.ts`

Single registry entry (`name: 'mcp'`). The handler parses `args`
itself — `findBuiltin` already does the right thing (matches name up
to first whitespace; passes the rest as `args` trimmed).

```ts
export const mcpCommand: BuiltinCommand = {
  name: 'mcp',
  description: 'Manage requested MCP servers (add/remove/list).',
  inputHint: 'add <url> | remove <url> | (no args to list)',
  handler: async (args, ctx) => {
    const sub = args.split(/\s+/)[0] ?? '';
    if (!args)         return mcpList(ctx);
    if (sub === 'add')    return mcpAdd(args.slice(3).trim(), ctx);
    if (sub === 'remove') return mcpRemove(args.slice(6).trim(), ctx);
    return { replyText: `Unknown subcommand. Usage: /mcp [add <url> | remove <url>]` };
  },
};
```

Subcommand handlers:

- **list**: render two markdown sections — Connected (matching
  approved Bodhi instances back to original URLs via the slug
  heuristic; fall back to the Bodhi proxy URL when unmatched) and
  Pending or denied (requested URLs with no matching instance).
  Empty IDB list → "No MCP servers requested yet. Use `/mcp add
  <url>`." (discoverability).

- **add `<url>`**:
  - Canonicalise. Fail → reply with parse error, no action.
  - Already in `ctx.requestedMcpUrls` → reply
    `\`<url>\` is already requested — no re-auth needed.`, no action.
  - New → reply
    `Re-authenticating to add \`<url>\`. You'll return here after Bodhi approval.`,
    action `{ kind: 'mcp-add', url }`.

- **remove `<url>`**:
  - Canonicalise. Fail → reply with parse error, no action.
  - Not in `ctx.requestedMcpUrls` → reply
    `\`<url>\` is not in your requested list. Current list: …`, no action.
  - Present → reply
    `Removing \`<url>\` and re-authenticating with the reduced list.`,
    action `{ kind: 'mcp-remove', url }`.

### Register in `packages/web-acp/src/agent/commands/builtins/index.ts`

Append `mcpCommand` to `BUILTIN_COMMANDS`. `findBuiltin`'s
whitespace-boundary matcher already works for `/mcp`, `/mcp add …`,
`/mcp remove …`. `available_commands_update` now advertises `/mcp`
automatically; the help built-in surfaces it without extra work.

## UI — render distinction

`/mcp` rides M4 phase B's existing builtin styling
(`data-teststate="builtin"`, muted bubble). No new components or
data-test-state values. The empty-list reply is plain markdown text
so the `/mcp add <url>` cue is discoverable from the bare command
output.

## E2E test seam

### New helper: `packages/web-acp/e2e/helpers/install-requested-mcps.ts`

```ts
export async function installRequestedMcps(page: Page, urls: string[]): Promise<void> {
  await page.addInitScript(seed => {
    (window as unknown as { __mcpRequestedSeed?: string[] }).__mcpRequestedSeed = seed;
  }, urls);
}
```

The DEV-only boot hook in `useAcp.ts` (or wherever vault's existing
`useDevSeedBoot` parallel lands) writes the seed list to IDB before
any app code reads it.

### Migration of existing e2e

`packages/web-acp/e2e/helpers/install-mcp.ts` (the
`window.__mcpEverythingUrl` injector) is **deleted** as part of this
slice — its only consumer (Header.tsx) no longer reads from window.
Existing specs that called `installMcpEverythingUrl(page, url)`
switch to `installRequestedMcps(page, [url, …])` so login uses the
seeded IDB list.

## Tests

- **vitest** (per-file):
  - `mcp/url-canonical.test.ts` — round-trip cases, port
    normalisation, parse-failure handling.
  - `mcp/requested-mcps-store.test.ts` — load/save/clear, dedup,
    canonicalisation at write time.
  - `agent/commands/builtins/mcp.test.ts` — each subcommand handler,
    the slug-derivation heuristic, the URL-display matching.
- **Adapter test** (extend
  `packages/web-acp/src/acp/agent-adapter.test.ts`): /mcp ride-through
  (no LLM call), action emission with `mcp-add`/`mcp-remove` kinds
  including `url`, persisted `'builtin'` entry shape with action.url
  preserved, `_meta.bodhi.requestedMcpUrls` plumbed from session/new
  through to the BuiltinHandlerCtx.
- **Playwright e2e** (extend `e2e/builtins.spec.ts` or new
  `e2e/mcp.spec.ts`):
  - Pre-seed empty IDB; log in; verify `/mcp` shows empty Pending +
    Connected sections (or the empty-state hint).
  - Pre-seed an everything-server URL; log in; verify `/mcp` shows it
    Connected. Run `/mcp remove <url>`; verify redirect happens; after
    return, verify URL is dropped and instance is gone from
    `useMcpInstances`.
  - Run `/mcp add <known test MCP>`; verify redirect; after return,
    verify URL is in IDB list and instance appears in
    `useMcpInstances`. Active session survives — chat history intact.
  - `/mcp add` of an already-requested URL: no redirect; transcript
    explains.

## Spec doc updates

- `ai-docs/web-acp/specs/web-acp/commands.md`:
  - New section "/mcp" under built-ins. Document the subcommand
    structure, the action.kind values (`mcp-add`, `mcp-remove`), the
    URL field on the action payload, and the SSO-no-password-re-entry
    surprise (Principle § 16).
  - Update the "open-ended action discriminator" passage to note that
    actions may carry payload fields beyond `kind` (URL is the first
    such field).
- `ai-docs/web-acp/specs/web-acp/mcp.md`:
  - New section "Requested-MCPs IDB store" — document the
    `web-acp:mcp-requested` key, the canonicalisation rule, and the
    `_meta.bodhi.requestedMcpUrls` plumbing through `session/new` /
    `session/load`.
  - Update the login-flow section to point at
    `loadRequestedMcps()` instead of the hardcoded URLs in
    Header.tsx.

## Critical files

**Modified**:

- `packages/web-acp/src/components/Header.tsx` — drop hardcoded URLs,
  read IDB.
- `packages/web-acp/src/hooks/useAcp.ts` — add
  `loadCurrentRequestedMcps`, plumb `_meta.bodhi.requestedMcpUrls`,
  extend `dispatchBuiltinAction` for `mcp-add` / `mcp-remove`,
  optional `useDevSeedBoot`-style hook.
- `packages/web-acp/src/lib/builtin-format.ts` — extend
  `extractBuiltinMeta` to copy `action.url`.
- `packages/web-acp/src/acp/index.ts` — `BodhiBuiltinAction.url`.
- `packages/web-acp/src/agent/commands/builtins/types.ts` — extend
  `BuiltinActionKind` (or accept `string`), `BuiltinHandlerCtx` adds
  `requestedMcpUrls` + matched-instance snapshot.
- `packages/web-acp/src/agent/commands/builtins/index.ts` — register
  `mcpCommand`.
- `packages/web-acp/src/agent/session-store.ts` —
  `BuiltinPayload.action.url`.
- `packages/web-acp/src/acp/agent-adapter.ts` — store
  `requestedMcpUrls` per-session; populate ctx in
  `#tryHandleBuiltin`.

**New**:

- `packages/web-acp/src/mcp/requested-mcps-store.ts`
- `packages/web-acp/src/mcp/url-canonical.ts`
- `packages/web-acp/src/agent/commands/builtins/mcp.ts`
- `packages/web-acp/e2e/helpers/install-requested-mcps.ts`

**Deleted**:

- `packages/web-acp/e2e/helpers/install-mcp.ts` (no remaining
  consumers).

## Verification

End-to-end checklist (run from inside `packages/web-acp/`):

```bash
npm run check            # biome + tsgo
npm test                 # vitest unit
npm run test:e2e         # Playwright (requires .env.test + running Bodhi)
```

From repo root:

```bash
npm run check            # cross-package check
```

Manual smoke:

1. Fresh install (clear IDB at `web-acp:mcp-requested`). Click Login;
   confirm zero MCPs requested in the Bodhi access-request screen.
2. Run `/mcp add https://mcp.deepwiki.com/mcp`; observe the
   "Re-authenticating…" transcript line; observe Bodhi approval
   screen with deepwiki only; approve; return to chat with the
   transcript line still present and the active session intact.
3. Run `/mcp` — confirm Connected shows deepwiki (URL form, not
   slug); Pending or denied is empty.
4. Run `/mcp add https://mcp.deepwiki.com/mcp` again — confirm
   transcript explains "already requested", no redirect.
5. Run `/mcp remove https://mcp.deepwiki.com/mcp` — observe redirect,
   approval (now empty scope), return; `/mcp` confirms list is empty.
6. Open second session; `/mcp` works there too (the IDB list is
   per-user, not per-session).
7. Reload mid-flight (during the redirect window) — confirm session
   still loads with the persisted transcript.

## Out of scope

- `/mcp toggle <slug>` for per-session enable/disable —
  `_bodhi/mcp/toggles/set` (M3 phase B) already handles this via the
  picker UI.
- `/mcp auth <slug>` for per-server OAuth — Bodhi mediates auth
  today.
- `/mcp restart <slug>` — pool fingerprint-driven reconnect already
  exists.
- Distinguishing "Bodhi denied" vs "Bodhi never saw this URL" —
  Pending or denied is a single bucket. Requires server-side concept
  we don't have.
- MCP catalog browser / extension marketplace — M5+.
- Per-URL provenance ("you added this on 2026-04-27") — IDB stores
  URLs only; no metadata. Easy to extend later if needed.
