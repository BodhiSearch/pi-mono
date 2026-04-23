# web-acp — 003 — M2 Filesystem Tools + MCP

> **Purpose of this prompt.** Drive
> [`../milestones/m2-tools.md`](../milestones/m2-tools.md) to
> completion. The agent gains a real tool surface — read, write,
> edit, ls, glob, grep — with every vault touch riding ACP
> `fs/*` delegation, and MCP proxy tools re-enter alongside the
> built-ins.
>
> **This is a skeleton.** It exists so the M1 exit commit can
> point at the next milestone without forcing the executor to
> invent scope. Fill it out at the start of the M2 turn; do
> not treat it as the authoritative brief yet.

---

## What M2 delivers

The LLM can read/write files in a `/vault` directory the user
mounted via File System Access. The agent never touches
ZenFS directly; it issues ACP `fs/read_text_file` and
`fs/write_text_file` requests, and the main-thread client
answers them. Destructive tools gate on ACP `tool_call`
permission. MCP servers configured in settings surface their
tools through the same agent-side tool registry.

See [`../milestones/m2-tools.md`](../milestones/m2-tools.md)
for the three slices:

- **M2.1** — vault mount (FSA + ZenFS + dev seed).
- **M2.2** — `fs/*` delegation + six built-in tools +
  permission flow.
- **M2.3** — MCP proxy tools over ACP extension methods.

## What M1 leaves you (can rely on)

- Worker-owned session store at
  `packages/web-acp/src/agent/session-store.ts`. Every turn
  already persists `finalMessages` + `modelId`; tool-call
  turns add to that shape without reshaping it.
- ACP `session/load` + `bodhi/getSession` rehydrate the UI
  and `InlineAgent` on reload.
- `SessionPicker` in the main thread; switching sessions is
  boringly reliable.
- `isReplayingRef` pattern in `useAcp` — a template for
  silencing live listeners during deterministic replays. M2
  may need the same pattern if tool-call rounds replay in
  Phase C of M2.2.
- `.env.test` with two models (OpenAI + Anthropic); tool
  e2e can use either for determinism.

## Decisions already made (do not re-ask)

1. **`fs/read_text_file` + `fs/write_text_file` are the
   primitives.** `ls`, `glob`, `grep`, `edit` compose on
   top. If iteration cost is prohibitive, introduce an ACP
   extension (`bodhi/fsList`, `bodhi/fsGlob`, etc.) — but
   only after measurement.
2. **Permission flow uses ACP `tool_call`.** No bespoke
   "confirm dialog" RPC. Principle 2.
3. **MCP rides `bodhi/*` extension methods** (working names:
   `bodhi/setMcpTools`, `bodhi/toolCall`). If upstream ACP
   has a native MCP channel when M2.3 starts, prefer that.
4. **Vault handle persistence reuses the IDBFS pattern**
   from `packages/web-agent/`. Do not import from web-agent;
   re-derive.
5. **Text-only tools in M2.** Binary read/write is post-v1.
6. **No `terminal/*` delegation.** Browsers have no shell.

## Read before planning

1. [`../milestones/m2-tools.md`](../milestones/m2-tools.md) —
   scope and sub-milestones.
2. [`../steering/`](../steering/) — all four files.
3. [`../specs/web-acp/`](../specs/web-acp/) — current module
   specs; `agent.md` and `acp.md` will change most.
4. `packages/web-agent/src/vault/` and
   `packages/web-agent/e2e/tests/vault-*.spec.ts` — shape
   reference for the FSA mount + e2e harness.
5. `ai-docs/specs/worker-agent/vault-tools.md` — web-agent's
   six-tool definitions; the LLM surface we replicate.
6. `/Users/amir36/Documents/workspace/src/github.com/agentclientprotocol/agent-client-protocol/schema/schema.json`
   — `fs/*` + `tool_call` + permission types.
7. `packages/coding-agent/src/tools/` — operation pattern
   for the built-in tool set.
8. `@mariozechner/pi-agent-core` — tool schema wrapping;
   the adapter registers tools through this.

## Deliverable sketch (fill in at M2 turn)

- **Plan** at `ai-docs/web-acp/plans/m2-tools.md` — three
  slices × A/B/C/D cadence, each slice independently
  gate-able per the milestone doc.
- **M2.1 code+specs** — vault provider, FSA handle store,
  port-backed VFS channel (second `MessageChannel` inside
  the worker `init` payload), `InMemoryVaultSeed` +
  `installVault` test helper, new spec `vault.md` under
  `../specs/web-acp/`.
- **M2.2 code+specs** — `fs/*` client handlers, six-tool
  registration in `InlineAgent`, permission UX, tool-call
  persistence in `SessionStore` (tool rounds join the turn
  transcript naturally), new spec `tools.md`.
- **M2.3 code+specs** — MCP registry on the main thread,
  ext-method upcalls, error envelope shape, spec updates
  in `acp.md` + new `mcp.md`.

## Hard constraints (carried from 002)

- Do not edit `packages/web-acp/e2e/chat.spec.ts`.
- Do not edit `packages/web-acp/e2e/sessions-*.spec.ts`
  unless M2 changes the session wire shape (it shouldn't).
- Worker stays authoritative for session + turn state.
  Main thread owns vault + MCP connection lifecycle —
  these are client concerns per principle 1.
- Stable ACP schema only; unstable methods live behind a
  feature flag with a test-only bypass.
- Same-commit spec updates; house rules from root
  `AGENTS.md` + `CLAUDE.md` apply.

## Exit criteria (fill in)

- [ ] Plan at `ai-docs/web-acp/plans/m2-tools.md` approved.
- [ ] Each of M2.1 / M2.2 / M2.3 landed as a gated commit
      (or series of phase commits within a slice).
- [ ] `npm run check` green at every commit.
- [ ] e2e: vault mount spec + tool round-trip spec +
      permission-deny spec + MCP smoke spec all green.
- [ ] Milestone doc marked shipped with decision log.
- [ ] Next prompt `004-m3-session-tree.md` drafted.

## What M2 does **not** do

- Fork / branch / navigate (M3).
- Compaction (M4).
- Slash commands / skills / prompt templates (M5).
- Extensions (M6).
- Non-text file types. Binary is post-v1.
- Shell / terminal. No browser analogue in v1.

## What happens next (context)

`004-m3-session-tree.md` drives M3 — forking and branching
sessions. Relies on M1's session store and M2's tool-call
turns already living as first-class entries in the
transcript.
