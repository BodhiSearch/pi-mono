# Specs

Living specs for extractable modules under `packages/web-agent/src/`. Each folder groups one module's functional and technical documentation. Each module has its own `index.md` as the entry point.

| Module | Source of truth | Spec folder |
| --- | --- | --- |
| `worker-agent` — browser-runtime coding-agent harness, future `@bodhiapp/bodhi-web-agent` | `packages/web-agent/src/worker-agent/` | [`./worker-agent/`](./worker-agent/index.md) |
| `worker-bodhi` — concrete Bodhi `LlmProvider` | `packages/web-agent/src/worker-bodhi/` | [`./worker-bodhi/`](./worker-bodhi/index.md) |

## Cross-cutting

- [`coding-agent-vs-web-agent.md`](./coding-agent-vs-web-agent.md) — architectural comparison between `packages/coding-agent/` (Node CLI) and `packages/web-agent/` (browser + Worker): aligned patterns, intentional divergences, features missing on either side.

## Conventions

- Each module folder has an `index.md` with a summary, navigation, and change procedure.
- Topic files combine the **functional** (what / why) and **technical** (how / where) views; splitting them leads to duplication and drift.
- Technical content references files by **repo-relative paths** and symbols by **method / field name**, never line numbers.
- Specs are living documents. Any plan that edits the underlying source MUST update the matching spec (see each `index.md`'s change procedure).

## Change procedure

See `CLAUDE.md § Functional specs` for the hard rule: plans touching a watched folder must update the matching spec as part of the same change.
