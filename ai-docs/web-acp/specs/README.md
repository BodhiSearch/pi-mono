# Specs — web-acp

Living specs for the `packages/web-acp/` module families as they
exist **today** (post-M0). Each folder groups one module's
**functional** (what / why) and **technical** (how / where) view;
splitting them leads to duplication and drift.

| Module subtree | Source of truth | Spec folder |
| --- | --- | --- |
| `web-acp` — browser-runtime ACP client + agent worker (future `@bodhiapp/bodhi-web-acp`) | `packages/web-acp/src/` | [`./web-acp/`](./web-acp/index.md) |

## Relationship to sibling specs

- [`../../specs/worker-agent/`](../../specs/worker-agent/) and
  [`../../specs/worker-bodhi/`](../../specs/worker-bodhi/) document
  `packages/web-agent/` — the **reference spike**, not an ancestor.
  Patterns (`LlmProvider`, Bodhi catalog mapping, streaming
  primitives) are re-used in `web-acp`; wire-protocol and runtime
  shape are intentionally different.

## Conventions

- Each module folder has an `index.md` with a summary, navigation,
  and change procedure.
- Topic files combine the **functional** and **technical** views.
- Technical content references files by **repo-relative paths** and
  symbols by **method / field name**, never line numbers.
- Specs are living documents. Any plan that edits the underlying
  source MUST update the matching spec (see each `index.md`'s
  change procedure).

## Change procedure

Follows `ai-docs/specs/README.md` and `CLAUDE.md § Functional
specs`: plans touching a watched folder must update the matching
spec as part of the same change.

## Roadmap link

Specs cover what has **shipped**. For what comes next, see
[`../milestones/index.md`](../milestones/index.md) and the
steering docs under [`../steering/`](../steering/).
