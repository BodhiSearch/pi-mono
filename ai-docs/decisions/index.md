# Decisions — index

Running log of locked architectural decisions for web-agent. Append-only.

**Structure.** This index carries the decision ledger + one-line-per-group hooks so a session can decide which detail file to actually load. Each decision group lives in its own file under `ai-docs/decisions/`. Groups are organised by the milestone or phase that motivated them.

**Process.** New decisions append to the appropriate group file (or create a new one if none fits) and add a row to the ledger below. Decisions are never overwritten — a superseded decision gets a new entry that references the old one by id.

## Decision ledger

| ID  | Decision                                                                 | Date       | Status      | File |
| --- | ------------------------------------------------------------------------ | ---------- | ----------- | ---- |
| D1  | Silence Vite dynamic-import warnings at the `packages/ai` source         | 2026-04-19 | active      | [m0-workspace.md](m0-workspace.md) |
| D2  | Web-agent consumes `packages/ai` + `packages/agent` as workspace `"*"`   | 2026-04-19 | active      | [m0-workspace.md](m0-workspace.md) |
| D3  | E2E uses a dev-mode-only InMemory ZenFS seam (`useDevSeedBoot`)          | 2026-04-19 | active      | [m0-workspace.md](m0-workspace.md) |
| D4  | Phase 1 RPC transport is `MessageChannel`; Worker swap deferred to M4     | 2026-04-19 | active      | [m0-workspace.md](m0-workspace.md) |
| D5  | Vault mount state owned by a single `<VaultProvider>`                    | 2026-04-20 | active      | [post-m3-stabilisation.md](post-m3-stabilisation.md) |
| D6  | Reference app uses 3-column layout with Milkdown markdown editor         | 2026-04-20 | active      | [post-m3-stabilisation.md](post-m3-stabilisation.md) |
| D7  | Single agent Worker hosts AgentSession + ZenFS; dual MessageChannels     | 2026-04-20 | active      | [m4-worker-transport.md](m4-worker-transport.md) |
| D8  | MCP tools upcall to main via agent RPC; vault tools execute Worker-side  | 2026-04-20 | active      | [m4-worker-transport.md](m4-worker-transport.md) |
| D9  | Envelope-tagged transport + structured error round-trip (cribbed Comlink)| 2026-04-20 | active      | [m4-worker-transport.md](m4-worker-transport.md) |
| D10 | SessionManager lives Worker-side; main drives it through RPC             | 2026-04-20 | active      | [m5-session-persistence.md](m5-session-persistence.md) |
| D11 | Port full `SessionEntry` union + `ReadonlySessionManager` in M5          | 2026-04-20 | active      | [m5-session-persistence.md](m5-session-persistence.md) |
| D12 | `/sessions` on IndexedDB with per-session append queue (not OPFS)        | 2026-04-20 | superseded by D14 | [m5-session-persistence.md](m5-session-persistence.md) |
| D13 | `SessionStore` interface makes session storage swappable                 | 2026-04-20 | active      | [m5-storage-swap.md](m5-storage-swap.md) |
| D14 | Dexie on IndexedDB for session storage — supersedes D12                  | 2026-04-20 | active      | [m5-storage-swap.md](m5-storage-swap.md) |
| D15 | Worker owns writes; main reads directly via Dexie `liveQuery`            | 2026-04-20 | active      | [m5-storage-swap.md](m5-storage-swap.md) |
| D16 | `vaultMount` + `sessionsDbName` are constructor options                  | 2026-04-20 | active      | [post-m5-cleanup.md](post-m5-cleanup.md) |
| D17 | Extension scaffolding de-exported; M8 reintroduces                       | 2026-04-20 | active      | [post-m5-cleanup.md](post-m5-cleanup.md) |
| D18 | Fork = full entry copy with `parentSession`; ids/timestamps preserved    | 2026-04-20 | active      | [m6-session-tree.md](m6-session-tree.md) |
| D19 | Ephemeral leaf navigation — `navigateToLeaf` mutates in-memory only       | 2026-04-20 | active      | [m6-session-tree.md](m6-session-tree.md) |
| D20 | Extensions load via Dexie bytes + Blob URL + per-extension nested Worker | 2026-04-20 | spike-only — not a forward commitment | [m8-extensions.md](m8-extensions.md) |
| D21 | Mid-stream extension toggles defer to the next `agent_end`               | 2026-04-20 | active      | [m8-extensions.md](m8-extensions.md) |
| m7-d20 | Compaction pipeline is Worker-local; RPC exposes only trigger + lifecycle events | 2026-04-20 | active      | [m7-compaction.md](m7-compaction.md) |
| m7-d21 | Cut on user-message turn boundaries only; turn-split summarisation deferred | 2026-04-20 | active      | [m7-compaction.md](m7-compaction.md) |
| m7-d22 | `CompactionSettings.contextWindow` override isolates M7 from the hardcoded 128000 | 2026-04-20 | active      | [m7-compaction.md](m7-compaction.md) |

## Progressive-disclosure hooks

Load the file only if its hook matches what you're about to do.

- **[m0-workspace.md](m0-workspace.md)** (D1–D4) — Vite warning fix at `packages/ai` source, workspace `"*"` specifier, dev-seed test seam, MessageChannel transport; load when touching workspace wiring or the RPC transport choice.
- **[post-m3-stabilisation.md](post-m3-stabilisation.md)** (D5–D6) — single `VaultProvider` owns mount state; 3-column reference-app layout with Milkdown; load when touching vault mount lifecycle or the reference app shell.
- **[m4-worker-transport.md](m4-worker-transport.md)** (D7–D9) — dual MessageChannel worker boot, MCP upcall pattern, envelope-tagged transport + structured errors; load when touching the Worker boundary, MCP plumbing, or RPC error shapes.
- **[m5-session-persistence.md](m5-session-persistence.md)** (D10–D12) — Worker-owned SessionManager, full `SessionEntry` union port, initial `/sessions` ZenFS mount (D12 superseded by D14); load when reasoning about the session runtime shape.
- **[m5-storage-swap.md](m5-storage-swap.md)** (D13–D15) — `SessionStore` seam, Dexie replaces ZenFS, Worker-writes + main-reads via `liveQuery`; load when touching session storage.
- **[post-m5-cleanup.md](post-m5-cleanup.md)** (D16–D17) — `WebAgentOptions` constructor surface, extension-stub de-export; load when adjusting library configuration or the public API barrel.
- **[m6-session-tree.md](m6-session-tree.md)** (D18–D19) — atomic fork copy with preserved ids, ephemeral `navigateToLeaf`; load when touching fork semantics or branch navigation.
- **[m7-compaction.md](m7-compaction.md)** (m7-d20–m7-d22) — Worker-local compaction pipeline (auto + manual share one code path), turn-boundary-only cuts with `force: true` fallback, `CompactionSettings.contextWindow` override as interim stopgap for the hardcoded 128000. Load when touching compaction, threshold logic, or the `shouldCompact` call site.
- **[m8-extensions.md](m8-extensions.md)** (D20–D21) — D20 captures the spike's loader shape (Dexie + Blob URL + nested Worker) and is **not a forward commitment** — see [`../extension-spike/`](../extension-spike/) for the unbiased recommendation. D21 (defer mid-stream toggles to `agent_end`) is a general lifecycle rule worth keeping. Load this file when touching the spike code or drafting the next extension plan.

## Conventions

- **Append-only:** never overwrite past decisions. Supersede with a new entry that references the old one (update the ledger `Status` column to `superseded by Dxx`).
- **Date format:** ISO `YYYY-MM-DD`.
- **Scope:** architectural choices that shape future implementation. Routine code style lives in lint configs, not here.
- **Cross-refs:** prefer repo-relative paths (e.g. `packages/ai/src/env-api-keys.ts`) over commit SHAs so entries remain readable as the code evolves.
- **IDs:** new decisions use the milestone-prefixed form `m<milestone>-d<serial>` (e.g. `m7-d20`, `m8-d3`). The serial is scoped to the milestone — start fresh at the lowest unused number for that milestone. The legacy unprefixed `Dxx` entries (D1–D21) stay as historical records and are referenced by their original id. The prefix scheme was adopted to stop concurrent milestones colliding on the global serial; see the note at the top of [m7-compaction.md](m7-compaction.md).
