# Milestones — index

Consolidated roadmap for porting `packages/coding-agent`'s feature set into `packages/web-agent/` under our browser/RPC/ZenFS constraints. Living document.

**Structure.** This index carries the canonical status board + one-line-per-milestone hooks so a session can decide which detail file to actually load. Each milestone has its own file under `ai-docs/milestones/`. The [gate](gate.md) lists checks every commit must pass.

**Process.** One milestone at a time: draft the per-milestone plan at `ai-docs/plans/<milestone>.md` → implement → gate-check → commit → move to next.

## Status board

| #   | Milestone                                                                   | Status  | Commit     | File |
| --- | --------------------------------------------------------------------------- | ------- | ---------- | ---- |
| M0  | Workspace integration + Vite-warning fix                                    | ✅ done  | `06d02b81` | [m0-workspace.md](m0-workspace.md) |
| M1  | RPC-shaped agent scaffold + `useAgent` rewire                               | ✅ done  | `06d02b81` | [m1-rpc-scaffold.md](m1-rpc-scaffold.md) |
| M2  | Vault mount: `/vault` via ZenFS + Chrome FSA picker + dev-seed testing seam | ✅ done  | `2c437c0f` | [m2-vault-mount.md](m2-vault-mount.md) |
| M3  | Filesystem tools (read, write, edit, ls, glob, grep) wired to the agent     | ✅ done  | `2c437c0f` | [m3-filesystem-tools.md](m3-filesystem-tools.md) |
| —   | Post-M3 stabilisation + reference-app polish                                | ✅ done  | `dcd75a1c`→`4c3401d3` | [post-m3-stabilisation.md](post-m3-stabilisation.md) |
| M4  | Worker transport: `AgentSession` + ZenFS run in a Web Worker                | ✅ done  | `8fa325a6` | [m4-worker-transport.md](m4-worker-transport.md) |
| M5  | Session persistence: `/sessions` IndexedDB mount, save / load / list        | ✅ done  | `3ddd01b2` | [m5-session-persistence.md](m5-session-persistence.md) |
| —   | Post-M5 cleanup (pre-extraction hygiene)                                    | ✅ done  | `af2b7086` | [post-m5-cleanup.md](post-m5-cleanup.md) |
| M6  | Session tree: fork from entry, switch sessions, branch navigation           | ✅ done  | latest     | [m6-session-tree.md](m6-session-tree.md) |
| M7  | Compaction: auto + manual, result persistence, UI observability             | ✅ done  | latest     | [m7-compaction.md](m7-compaction.md) |
| M8  | Extensions: dynamic, toggleable behaviour layer over the agent              | ✅ Phases 1 + 2a + 2b | latest | [m8-extensions.md](m8-extensions.md) |
| M9  | Resources: slash commands, prompt templates, skills, themes                 | 🟡 partial — vault-sourced commands/prompts/skills landed; extension-provided + themes still pending | latest | [m9-resources.md](m9-resources.md) |
| M10 | Polish: HTML export, diagnostics, logging, debug traces                     | planned | —          | [m10-polish.md](m10-polish.md) |
| M11 | Library extraction: `@bodhiapp/bodhi-web-agent` publishable package               | planned | —          | [m11-library-extraction.md](m11-library-extraction.md) |

## Progressive-disclosure hooks

Load the file only if its hook matches what you're about to do.

### Done — outcome summaries (load when debugging regressions or mining lessons)

- **[m0-workspace.md](m0-workspace.md)** — TS/workspace deps aligned, Vite warnings silenced, `tsc -b` gotcha; load if workspace tooling misbehaves.
- **[m1-rpc-scaffold.md](m1-rpc-scaffold.md)** — `src/worker-agent/` tree established; RPC types/server/client + 4 round-trip vitests; `DistributiveOmit` gotcha.
- **[m2-vault-mount.md](m2-vault-mount.md)** — ZenFS provider, `useDirectoryHandle`, `useDevSeedBoot`, VaultStatus UI, double-mount race.
- **[m3-filesystem-tools.md](m3-filesystem-tools.md)** — 6 vault tools (read/write/edit/ls/glob/grep) + file-mutation queue + BOM quirk; load if touching tool schemas.
- **[post-m3-stabilisation.md](post-m3-stabilisation.md)** — VaultProvider hoisted state, 3-column layout, Milkdown editor; load if vault UI state looks off.
- **[m4-worker-transport.md](m4-worker-transport.md)** — Agent Worker + dual MessageChannels (agent RPC + ZenFS Port); MCP upcall pattern; structured errors.
- **[m5-session-persistence.md](m5-session-persistence.md)** — SessionManager + `SessionStore` interface; Dexie swap from initial ZenFS path; `session_loaded` event.
- **[post-m5-cleanup.md](post-m5-cleanup.md)** — dead-code removal, `WebAgentOptions` added, extension scaffolding de-exported; pre-Phase-6 hygiene.
- **[m6-session-tree.md](m6-session-tree.md)** — `forkSession` (atomic copy preserving ids/timestamps), ephemeral `navigateToLeaf`, per-message Fork/Branch UI.
- **[m7-compaction.md](m7-compaction.md)** — auto+manual compaction, `UiMessageMeta` pipeline, compaction summary bubble with data-test attributes, forced compaction for e2e.
- **[m8-extensions.md](m8-extensions.md)** — Phases 1 + 2a + 2b landed: vault-scoped `.pi/extensions/<name>/index.js`, Blob-URL dynamic import inside the Worker, every context/lifecycle hook (`before_agent_start`, `tool_result`, `context`, `tool_call`, `turn_start`, `message_end`, `session_loaded` with the six-value reason discriminator, `before_compact`, `after_compact`), the full `pi.*` registration surface (`registerTool`, `registerCommand`, `registerProvider`, `registerSkill`), the full modal + surface `pi.ui.*` channel (`notify`, `setStatus`, `setTitle`, `setWidget`, `editor`, `setEditorText`, `select`, `confirm`, `input`), a `ReadonlySessionManager` forwarder on `ctx.session` with `InvalidSessionError`, per-extension toggle + global disable-all trip switch. Full technical reference in [`../specs/worker-agent/extensions.md`](../specs/worker-agent/extensions.md); handoff notes in [`../extension-impl/`](../extension-impl/) (Phase 2a + 2b reports, Phase 3 prompt).

### Planned — previews (load when picking up that milestone)
- **[m9-resources.md](m9-resources.md)** — **partially landed**: vault-sourced slash commands, prompt templates, and skills (with sandboxed `bash` shim for skill scripts) are shipped; the remaining work is extension-registered commands/themes and multi-tier (user + CLI) loading.
- **[m10-polish.md](m10-polish.md)** — HTML export, diagnostics, debug logging.
- **[m11-library-extraction.md](m11-library-extraction.md)** — lift `src/worker-agent/` into `@bodhiapp/bodhi-web-agent`; reference app consumes it.

### Cross-cutting

- **[gate.md](gate.md)** — the milestone gate every commit must satisfy; load before declaring anything done.
- **[deferred.md](deferred.md)** — explicit post-v1 non-goals (shell, multi-tab collab, RAG, voice).
- **[reference-index.md](reference-index.md)** — coding-agent ↔ web-agent source-mapping table; load when porting a new area.
