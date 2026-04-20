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
| M7  | Compaction: auto + manual, hook surface, result persistence                 | planned | —          | [m7-compaction.md](m7-compaction.md) |
| M8  | Extensions + skills: loader, sandbox, hook surface, skills-as-extensions    | planned | —          | [m8-extensions.md](m8-extensions.md) |
| M9  | Resources: slash commands, prompt templates, themes through extensions      | planned | —          | [m9-resources.md](m9-resources.md) |
| M10 | Polish: HTML export, diagnostics, logging, debug traces                     | planned | —          | [m10-polish.md](m10-polish.md) |
| M11 | Library extraction: `@bodhiapp/web-agent` publishable package               | planned | —          | [m11-library-extraction.md](m11-library-extraction.md) |

## Progressive-disclosure hooks

Load the file only if its hook matches what you're about to do.

### Done — outcome summaries (load when debugging regressions or mining lessons)

- **[m0-workspace.md](m0-workspace.md)** — TS/workspace deps aligned, Vite warnings silenced, `tsc -b` gotcha; load if workspace tooling misbehaves.
- **[m1-rpc-scaffold.md](m1-rpc-scaffold.md)** — `src/web-agent/` tree established; RPC types/server/client + 4 round-trip vitests; `DistributiveOmit` gotcha.
- **[m2-vault-mount.md](m2-vault-mount.md)** — ZenFS provider, `useDirectoryHandle`, `useDevSeedBoot`, VaultStatus UI, double-mount race.
- **[m3-filesystem-tools.md](m3-filesystem-tools.md)** — 6 vault tools (read/write/edit/ls/glob/grep) + file-mutation queue + BOM quirk; load if touching tool schemas.
- **[post-m3-stabilisation.md](post-m3-stabilisation.md)** — VaultProvider hoisted state, 3-column layout, Milkdown editor; load if vault UI state looks off.
- **[m4-worker-transport.md](m4-worker-transport.md)** — Agent Worker + dual MessageChannels (agent RPC + ZenFS Port); MCP upcall pattern; structured errors.
- **[m5-session-persistence.md](m5-session-persistence.md)** — SessionManager + `SessionStore` interface; Dexie swap from initial ZenFS path; `session_loaded` event.
- **[post-m5-cleanup.md](post-m5-cleanup.md)** — dead-code removal, `WebAgentOptions` added, extension scaffolding de-exported; pre-Phase-6 hygiene.
- **[m6-session-tree.md](m6-session-tree.md)** — `forkSession` (atomic copy preserving ids/timestamps), ephemeral `navigateToLeaf`, per-message Fork/Branch UI.

### Planned — previews (load when picking up that milestone)

- **[m7-compaction.md](m7-compaction.md)** — auto+manual compaction, threshold, persisted `CompactionEntry`, `session_before_compact` hook.
- **[m8-extensions.md](m8-extensions.md)** — biggest milestone; extension manifest/loader/Worker sandbox, full hook surface, skills-as-extensions.
- **[m9-resources.md](m9-resources.md)** — slash commands, prompt templates, themes via extension registration.
- **[m10-polish.md](m10-polish.md)** — HTML export, diagnostics, debug logging.
- **[m11-library-extraction.md](m11-library-extraction.md)** — lift `src/web-agent/` into `@bodhiapp/web-agent`; reference app consumes it.

### Cross-cutting

- **[gate.md](gate.md)** — the milestone gate every commit must satisfy; load before declaring anything done.
- **[deferred.md](deferred.md)** — explicit post-v1 non-goals (shell, multi-tab collab, RAG, voice).
- **[reference-index.md](reference-index.md)** — coding-agent ↔ web-agent source-mapping table; load when porting a new area.
