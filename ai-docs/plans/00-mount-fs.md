# M2 + M3 — vault mount + filesystem tools

## Context

M2 and M3 are bundled into one deliverable because M3 (filesystem tools) has no meaningful test seam without M2 (vault mount + dev-seed). Executing them separately would leave M2 with only a trivial "folder picker shows a button" test and force rewriting the e2e harness mid-milestone. Bundled, both land with one round of e2e infrastructure and one coherent PR scope.

**M2 outcome.** A user-picked local folder is mounted at `/vault` via Chrome File System Access API and ZenFS, persists across reloads, and can be seeded deterministically in Playwright via a dev-only test seam.

**M3 outcome.** The agent has six filesystem tools (`read`, `write`, `edit`, `ls`, `glob`, `grep`) operating over `/vault`, with per-file write serialisation, ported schemas from `packages/coding-agent`, and a Playwright round-trip proving the agent can read a seeded file and write a derived one.

Reference exploration (already completed, summarised in session):
- Coding-agent tools: schemas, operations pattern, file-mutation-queue → `packages/coding-agent/src/core/tools/{read,write,edit,ls,grep,find,file-mutation-queue}.ts`
- Zenfs-browser patterns: `mountVault` with WebAccess backend, `useDirectoryHandle` with idb-keyval + `requestPermission` re-grant, `useDevSeedBoot` gated by `import.meta.env.DEV`, `installVault` Playwright helper walking `e2e/data/<name>/` and injecting `window.__zenfsSeed` via `addInitScript`
- Web-agent test infra: Playwright config, `data-testid` + `data-teststate` conventions, `ChatPage`/`LoginPage` page-object pattern, existing `chat.spec.ts` must stay green

Constraints (from `ai-docs/` steering):
- No imports from `packages/coding-agent` (core value #1)
- `src/web-agent/` imports only inward (core value #4)
- No OPFS (core value #2)
- Black-box e2e, rich `test.step` per test (core value #4, principle #5)

---

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | grep/glob implemented in pure JS (no ripgrep/fd) | Browser has no subprocess. Vault is user-scale, not codebase-scale — JS walk + regex is fine. |
| 2 | File-mutation-queue keys on raw path, no `realpathSync` | ZenFS WebAccess and IndexedDB backends don't expose symlinks. Path normalisation via `path.posix.normalize` is sufficient. |
| 3 | Single `cwd = "/vault"` convention; absolute paths must start `/vault/` | Matches coding-agent semantics but bound to the vault. Tools reject paths escaping the vault. |
| 4 | Tools injected into `AgentSession` host-side via `setTools(createVaultTools(fsOps))` | Tool closures can't cross RPC. Phase 4 (Worker transport) will handle tool-proxy — out of scope here. |
| 5 | Dev-seed seam for e2e, InMemory ZenFS | Mirrors zenfs-browser pattern exactly. `showDirectoryPicker` is user-gesture-gated; dev-seed is the only viable headless approach. |
| 6 | Minimal vault UI: "Pick folder" button + status indicator, no file tree yet | File tree belongs to a later milestone (M5/M6 session UI). Keep M2 scope minimal. |
| 7 | Tests split: vitest for each tool against InMemory ZenFS, one new Playwright spec exercising the agent round-trip | Matches principle #5 "few high-value e2e tests, rich `test.step`". |

---

## Files to add

### Under `packages/web-agent/src/web-agent/`

```
fs/
  zenfs-provider.ts           # mountVault(handle) / unmountVault() / isVaultMounted()
  zenfs-operations.ts         # build ReadOps/WriteOps/EditOps/LsOps/GrepOps/GlobOps from ZenFS fs.promises
  path-utils.ts               # resolveVaultPath(path, cwd) — rejects escapes, normalizes

core/tools/
  file-mutation-queue.ts      # withFileMutationQueue<T>(filePath, fn) — per-path serialization
  read.ts                     # schema + createReadTool(ops) + algorithm (line-capped, offset/limit)
  write.ts                    # schema + createWriteTool(ops) — mkdir -p + atomic-ish write
  edit.ts                     # schema + createEditTool(ops) — multi-edit, unified-diff in details
  ls.ts                       # schema + createLsTool(ops) — sorted, "/" suffix for dirs
  glob.ts                     # schema + createGlobTool(ops) — JS walker + minimatch
  grep.ts                     # schema + createGrepTool(ops) — JS walk, per-line regex
  index.ts                    # barrel + createVaultTools(fsOps) factory returning AgentTool[]
  truncation.ts               # shared truncateHead(lines, maxLines, maxBytes) helper
```

Update `src/web-agent/index.ts` to re-export `createVaultTools` + mount helpers.

### Under `packages/web-agent/src/` (app layer)

```
hooks/
  useDirectoryHandle.ts       # FSA picker + idb-keyval persist + requestPermission re-grant
  useDevSeedBoot.ts           # dev-only, reads window.__zenfsSeed, lazy-imports in-memory-vault adapter
  useVaultMount.ts            # orchestrates: seed first, else directory handle; returns { status, handle }

components/vault/
  VaultStatus.tsx             # shows "no vault" / "pick folder" button / "mounted: <name>" / "access denied, re-grant"

fs/
  in-memory-vault.ts          # dev-only: createInMemoryVaultAdapter(seed) + createInMemoryDirectoryHandle(name)
```

Update `src/App.tsx` to mount `<VaultStatus>` in the header area and call `useVaultMount()` + `useDevSeedBoot()` at the root. Wire `useAgent` so it gains vault tools once mount is ready.

Update `src/hooks/useAgent.ts`: when vault becomes ready, call `session.setTools([...mcpTools, ...createVaultTools(fsOps)])`. Keep existing MCP-tool wiring.

### Under `packages/web-agent/e2e/`

```
data/
  sample/                     # M2/M3 fixture: 3 files
    README.md
    src/hello.ts
    docs/note.txt

helpers/
  install-vault.ts            # walks e2e/data/<name>/, injects window.__zenfsSeed via page.addInitScript

tests/pages/
  VaultPage.ts                # page-object: locators for vault status, file-ops assertions

vault-fs.spec.ts              # one new spec covering both M2 (mount) and M3 (agent round-trip)
```

---

## Dependencies to add

To `packages/web-agent/package.json` `dependencies`:
- `@zenfs/core` (current stable, align with zenfs-browser)
- `@zenfs/dom` (WebAccess backend)
- `idb-keyval` (for handle persistence)

No new devDependencies needed; Playwright + vitest already present.

---

## Code patterns to copy

All copied, not imported. Pattern provenance tracked in code comments.

### From `packages/coding-agent/src/core/tools/`

| File | What we take |
|---|---|
| `read.ts` | schema shape, `offset`/`limit`/line-cap algorithm, truncation helper |
| `write.ts` | schema + `withFileMutationQueue` wrap |
| `edit.ts` | multi-edit schema, BOM/line-ending preservation, unified-diff emission |
| `ls.ts` | schema + "/" suffix + sort-case-insensitive |
| `grep.ts` | schema + match format `path:lineno: text`; **replace** ripgrep spawn with JS walker |
| `find.ts` | schema (rename to `glob.ts`); **replace** fd spawn with JS walker |
| `file-mutation-queue.ts` | full pattern; **drop** `realpathSync.native` — use normalized path as key |

### From `bodhiapps/zenfs-browser`

| File | What we take |
|---|---|
| `src/adapters/browser/zenfs-provider.ts` | `mountVault(handle)` / `unmountVault()` verbatim, adapted to our `VAULT_MOUNT = "/vault"` |
| `src/hooks/useDirectoryHandle.ts` | three-state (`empty`/`prompt`/`ready`) hook with idb-keyval key `"dirHandle"`, `requestPermission` re-grant, cancellation token |
| `src/App.tsx` `useDevSeedBoot` | dev-only seam gated by `import.meta.env.DEV`, dynamic-import `in-memory-vault`, pre-mount before React effects |
| `e2e/helpers/install-vault.ts` | walk `e2e/data/<name>/`, build `Record<"/vault/…", utf8>`, `page.addInitScript` |

---

## Test strategy

**Principle reminder.** Few high-value e2e tests, rich `test.step` inside each. Unit tests earn their keep by covering tool operations deterministically against an InMemory ZenFS.

### Existing tests — extension plan

**`e2e/chat.spec.ts`** — must stay green. It runs without a vault (no `installVault` call). The `useVaultMount` hook returns `status: "empty"` when no handle and no seed, and `useAgent` builds its tool list without vault tools in that case. No changes required.

**`src/web-agent/rpc/rpc.test.ts`** — must stay green. The RPC envelope doesn't know about tools. No changes.

### New vitest suites

| File | Covers |
|---|---|
| `src/web-agent/fs/zenfs-operations.test.ts` | Each operations adapter (readFile, access, mkdir, writeFile, readdir, stat, glob walk, grep walk) against InMemory ZenFS — happy path + not-found + permission-style errors |
| `src/web-agent/core/tools/file-mutation-queue.test.ts` | Serial writes to same path (no races), concurrent writes to different paths (parallel), queue cleanup after completion |
| `src/web-agent/core/tools/read.test.ts` | offset/limit, line-cap truncation, binary-file rejection (optional), missing file |
| `src/web-agent/core/tools/write.test.ts` | creates parents, overwrites, wraps in mutation queue |
| `src/web-agent/core/tools/edit.test.ts` | single-edit, multi-edit, no-match failure, preserves BOM/line-endings, emits unified diff |
| `src/web-agent/core/tools/ls.test.ts` | sorted, "/" suffix, limit, missing path |
| `src/web-agent/core/tools/glob.test.ts` | `**/*.ts` matching, limit, path escape rejection |
| `src/web-agent/core/tools/grep.test.ts` | regex + literal modes, `ignoreCase`, `context`, `glob` filter, limit, line-truncation |
| `src/web-agent/core/tools/path-utils.test.ts` | `resolveVaultPath` — accepts `./foo`, `/vault/foo`, rejects `../etc`, `/etc`, `/vault/../foo` |

### New Playwright spec — `e2e/vault-fs.spec.ts`

One spec, two `test.describe` blocks, multiple `test.step`s per test. Seeds `e2e/data/sample/`:

```
sample/
  README.md        → "# Sample vault"
  src/hello.ts     → "export const greeting = 'hello';"
  docs/note.txt    → "todo: port the fs tools"
```

**`test.describe("Vault mount — M2")`**

```ts
test("seeded vault mounts and status indicator reflects state", async ({ page }) => {
  await test.step("install seeded vault", async () => {
    await installVault(page, "sample");
  });
  await test.step("load app", async () => {
    await page.goto("/");
  });
  await test.step("vault status shows mounted with seeded name", async () => {
    await expect(vault.statusBadge).toHaveAttribute("data-teststate", "mounted");
    await expect(vault.statusName).toHaveText("sample");
  });
});
```

**`test.describe("FS tools round-trip — M3")`**

```ts
test("agent reads a file and writes a derived file", async ({ page }) => {
  await test.step("install seeded vault + login + select model", async () => {
    await installVault(page, "sample");
    await chat.login({ username, password });
    await chat.loadModels();
    await chat.selectModel(FULL_MODEL_ID);
  });
  await test.step("ask the agent to read README.md and write a summary", async () => {
    await chat.send(
      "Use the read tool to read /vault/README.md, then use the write tool " +
      "to create /vault/summary.txt containing exactly the word 'ok'."
    );
    await chat.waitForAssistantTurn(0);
  });
  await test.step("verify the agent's tool calls", async () => {
    // assert tool-call bubbles rendered for read and write
    await expect(chat.toolCall("read")).toBeVisible();
    await expect(chat.toolCall("write")).toBeVisible();
  });
  await test.step("verify the file was actually written", async () => {
    // read the seeded mount back through the app's own fs API, not page.evaluate on ZenFS internals
    const content = await vault.readFile("/vault/summary.txt");
    expect(content.trim()).toBe("ok");
  });
});
```

`vault.readFile(path)` is a page-object method that reads the file through the app's own state — for the dev-seed case, it reads the InMemory mount. Implementation: a small debug endpoint in the app (`window.__webAgentReadVaultFile` gated by `import.meta.env.DEV`) or a visible UI "view file" control. **Preferred**: render a "recent writes" list in the vault status panel during dev mode, click + assert text content — stays black-box.

### Page-object additions

`e2e/tests/pages/VaultPage.ts`:

```ts
export class VaultPage {
  readonly statusBadge = this.page.locator('[data-testid="vault-status"]');
  readonly statusName = this.page.locator('[data-testid="vault-name"]');
  readonly pickButton = this.page.locator('[data-testid="vault-pick"]');

  constructor(private readonly page: Page) {}

  async readFile(path: string): Promise<string> {
    // click on the dev-only file-content viewer for `path`
    // (not via page.evaluate — via the UI surface)
    // …
  }
}
```

`ChatPage` extension: add `toolCall(name: string)` helper that finds `[data-testid="tool-call"][data-tool="<name>"]` — this surfaces when tool-call bubbles render (which `ChatDemo.tsx`'s existing `ToolCallMessage.tsx` already does; we add the data-testid there).

---

## Gate checks

Run between M2 and M3 and at the end of M3. Sequential, not parallel — failures stop the chain.

1. `cd packages/web-agent && npm run lint:fix` — auto-format (Prettier via ESLint), commit formatting noise eagerly.
2. `cd packages/web-agent && npm run check` — lint with zero warnings + `tsc -b`.
3. `cd packages/web-agent && npm test` — vitest, all new unit suites pass, existing `rpc.test.ts` + `App.test.tsx` stay green.
4. `cd packages/web-agent && npm run build` — production bundle succeeds, no dynamic-import warnings.
5. `cd packages/web-agent && npm run test:e2e` — Playwright, both `chat.spec.ts` (pre-existing) and `vault-fs.spec.ts` (new) green.
6. `npm run check` at repo root — biome + tsgo + browser-smoke + web-ui check + web-agent check.

Each check must produce exit code 0. No warnings accepted.

---

## Execution order

```
M2.1  dependencies + fs/zenfs-provider.ts + fs/path-utils.ts
M2.2  hooks/useDirectoryHandle.ts + hooks/useDevSeedBoot.ts + fs/in-memory-vault.ts
M2.3  hooks/useVaultMount.ts + components/vault/VaultStatus.tsx
M2.4  wire into App.tsx
M2.5  e2e/helpers/install-vault.ts + e2e/data/sample/ + VaultPage
M2.6  e2e/vault-fs.spec.ts — M2 describe block only
M2.7  gate checks → iteration until green
M3.1  fs/zenfs-operations.ts
M3.2  core/tools/file-mutation-queue.ts + tests
M3.3  core/tools/truncation.ts + read.ts + tests
M3.4  core/tools/write.ts + tests
M3.5  core/tools/edit.ts + tests
M3.6  core/tools/ls.ts + tests
M3.7  core/tools/glob.ts + tests
M3.8  core/tools/grep.ts + tests
M3.9  core/tools/index.ts barrel + createVaultTools factory
M3.10 wire createVaultTools into useAgent / AgentSession
M3.11 e2e/vault-fs.spec.ts — add M3 describe block
M3.12 full gate checks → iteration until green
```

After all gates green: single commit covering M2 + M3. Commit message summarises both milestones, the milestone-gate outcome, and updates `ai-docs/milestones.md` with outcome summaries for M2 and M3.

---

## Critical files — reference

**Copy-pattern-from (read-only during this milestone):**
- `packages/coding-agent/src/core/tools/{read,write,edit,ls,grep,find,file-mutation-queue,index}.ts`
- `bodhiapps/zenfs-browser/src/adapters/browser/zenfs-provider.ts`
- `bodhiapps/zenfs-browser/src/hooks/useDirectoryHandle.ts`
- `bodhiapps/zenfs-browser/src/App.tsx` (for `useDevSeedBoot` + `in-memory-vault` pattern)
- `bodhiapps/zenfs-browser/e2e/helpers/install-vault.ts`

**Modify:**
- `packages/web-agent/package.json` — add 3 deps
- `packages/web-agent/src/App.tsx` — mount VaultStatus + wire useVaultMount
- `packages/web-agent/src/hooks/useAgent.ts` — inject vault tools when mount is ready
- `packages/web-agent/src/components/chat/ToolCallMessage.tsx` — add `data-testid="tool-call"` + `data-tool={toolName}` (if not already present)
- `packages/web-agent/src/web-agent/index.ts` — re-export `createVaultTools` + `mountVault`/`unmountVault`
- `ai-docs/milestones.md` — update status board M2, M3 → `✅ done`, add outcome summaries

**Create:** all files listed under "Files to add" above.

---

## Verification

End of M2:
- Dev server: `cd packages/web-agent && npm run dev` — open `localhost:5173`, click "Pick folder", permission granted, status badge shows mounted. Reload — status badge shows "access denied, re-grant"; click re-grant; status returns to mounted.
- Playwright: `npm run test:e2e` — both specs pass.
- Dev-seed: `installVault(page, "sample")` followed by `page.goto("/")` shows vault mounted with name "sample" without any picker click.

End of M3:
- All vitest suites pass.
- Playwright agent-round-trip test passes: seeded README read and `summary.txt` written.
- Type check clean: no `any`, no `@ts-ignore`.
- Bundle size delta logged (expect +~80-120KB for @zenfs/core + @zenfs/dom + idb-keyval pre-gzip).

Commit gate — all six items in the "Gate checks" section pass. Then single commit.

---

## Out of scope — explicit

- File tree UI (deferred to session UI milestone M5/M6).
- Binary file rendering in `read` (images/PDFs) — coding-agent does this via mime detection; defer.
- Worker-side tool execution — that's M4.
- Extension-provided custom tools — that's M8.
- Session persistence of tool-call history beyond what the chat transcript already carries — M5.
