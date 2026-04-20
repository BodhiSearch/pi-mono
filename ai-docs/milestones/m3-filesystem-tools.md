# M3 — Filesystem tools

**Status:** ✅ done (`2c437c0f` + follow-ups). Test seam: +1 Playwright spec (`vault-fs.spec.ts` M3), 45 tool vitests.

**Scope preview (historical).**
- Port tool schemas from `packages/coding-agent/src/core/tools/{read,write,edit,ls,glob,grep}.ts`. Keep the "operations" dependency-injection pattern.
- Swap node-fs operations for ZenFS `fs.promises` operations. Both produce the same `AgentToolResult`.
- Register the six tools on `AgentSession` by default; host app passes the session's tools to `session.setTools(...)` on mount.
- Honor the coding-agent file-mutation-queue pattern from `packages/coding-agent/src/core/tools/file-mutation-queue.ts` to prevent write-races across concurrent tool calls.

**Coding-agent references.** `packages/coding-agent/src/core/tools/{read,write,edit,ls,glob,grep,file-mutation-queue}.ts`.

**Gate.** Playwright spec seeds vault with `hello.txt`, prompts the agent to read and transform, asserts the derived file's content. Tool-level vitest for each operation adapter against an InMemory ZenFS.

## Outcome

What landed:

- `src/web-agent/fs/zenfs-operations.ts` — per-tool operations adapters and a `createZenfsVaultOperations()` factory.
- `src/web-agent/core/tools/file-mutation-queue.ts` — per-path serialisation (pattern copied from coding-agent; `realpathSync` step dropped because ZenFS backends don't expose symlinks).
- `src/web-agent/core/tools/truncation.ts` — dual (lines + bytes) truncation helper.
- `src/web-agent/core/tools/{read,write,edit,ls,glob,grep}.ts` — schemas + `create*Tool({ operations, cwd })` factories. Schemas ported verbatim where possible; `grep` and `glob` re-implemented in pure JS (no ripgrep / fd subprocess available in browser) via minimatch + tree walk.
- `src/web-agent/core/tools/index.ts` — `createVaultTools(ops)` one-call factory returning `AgentTool[]`.
- `src/hooks/useVaultTools.ts` — returns the six tools when the vault is mounted, empty array otherwise.
- `src/components/chat/ChatDemo.tsx` — merges vault tools with MCP tools before passing to `useAgent`.
- `src/components/chat/ToolCallMessage.tsx` — added `data-testid="tool-call"` + `data-tool` + `data-teststate` for black-box assertions.
- `e2e/vault-fs.spec.ts` M3 describe block — full agent round-trip: seeded vault → prompt → agent calls `read` and `write` tools → derived file verified via the InMemory fs.
- Added `minimatch ^10.0.1` dependency for glob/grep pattern matching.

Surprises worth remembering:

- `TextDecoder` strips the BOM by default in UTF-8 mode, which broke `edit`'s BOM-preservation invariant. Pass `{ ignoreBOM: true }` to keep it in the decoded string.
- `AgentTool<Concrete>` is not a subtype of `AgentTool<TSchema>` in TS because `params: Static<TParams>` is a contravariant position that collapses under the broader `TSchema`. `createVaultTools` uses `as unknown as AgentTool[]` at the factory boundary; runtime safety is preserved because the agent loop validates arguments against `parameters` before dispatch.
- ESLint's `react-hooks/set-state-in-effect` rule flags synchronous `setState` inside effect bodies even for trivial cases. `useVaultMount` wraps all state transitions in awaited promise chains; don't short-circuit with a sync setState even when the rest of the effect is sync.
