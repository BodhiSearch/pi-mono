# Specs — web-acp

Living specs for the active web-acp initiative. Post-M4 phase B
the codebase splits into a **transport-agnostic agent package**
(`@bodhiapp/web-acp-agent`) and one or more **host runtimes** that
embed it. Specs are organised by package; each folder groups a
module's **functional** (what / why) and **technical** (how /
where) view in one file.

| Spec folder | Package | Role | Source of truth |
| --- | --- | --- | --- |
| [`./web-acp/`](./web-acp/index.md) | `packages/web-acp-agent/` (engine) + `packages/web-acp/` (browser host) | Agent runtime + the React/IndexedDB host that ships it as a Web Worker | `packages/web-acp-agent/src/` (agent) and `packages/web-acp/src/` (host) |
| [`./cli-acp-client/`](./cli-acp-client/index.md) | `packages/cli-acp-client/` | Node TTY host that embeds the same agent in-process over an in-memory duplex | `packages/cli-acp-client/src/` |

The split exists to validate the M8 library-extract assertion: the
agent runtime is genuinely host-neutral. Today's two hosts (browser
worker, Node CLI) speak the same ACP wire to the same agent code;
tomorrow's HTTP/SSE host slots in behind the same boundary.

## Relationship to sibling specs

- [`../../specs/worker-agent/`](../../specs/worker-agent/) and
  [`../../specs/worker-bodhi/`](../../specs/worker-bodhi/) document
  `packages/web-agent/` — the **reference spike**, not an ancestor.
  Patterns (`LlmProvider`, Bodhi catalog mapping, streaming
  primitives) are re-used in `web-acp-agent`; wire-protocol and
  runtime shape are intentionally different.

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
