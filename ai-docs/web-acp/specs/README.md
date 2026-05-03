# Specs — web-acp

Living specs for the active web-acp initiative. Post-M4 phase B
the codebase splits into a **transport-agnostic agent package**
(`@bodhiapp/web-acp-agent`) and one or more **host runtimes** that
embed it. Specs are organised by package; each folder groups a
module's **functional** (what / why) and **technical** (how /
where) view in one file.

| Spec folder | Package | Role | Source of truth |
| --- | --- | --- | --- |
| [`./web-acp-agent/`](./web-acp-agent/index.md) | `packages/web-acp-agent/` | Transport-agnostic ACP agent runtime — engine, providers, MCP, tools, commands, storage interfaces. Consumed by every host. | `packages/web-acp-agent/src/` |
| [`./web-acp-client/`](./web-acp-client/index.md) | `packages/web-acp/` | Browser host runtime — Vite + React + Web Worker + Dexie + FSA. Consumes the agent package. | `packages/web-acp/src/` |
| [`./cli-acp-client/`](./cli-acp-client/index.md) | `packages/cli-acp-client/` | Node TTY host that embeds the same agent in-process over an in-memory duplex | `packages/cli-acp-client/src/` |

The split exists to validate the M8 library-extract assertion: the
agent runtime is genuinely host-neutral. Today's two hosts (browser
worker, Node CLI) speak the same ACP wire to the same agent code;
tomorrow's HTTP/SSE host slots in behind the same boundary.

**Extraction status (which package is the library?):**
`@bodhiapp/web-acp-agent` is **already lib-shaped** — it ships
zero browser-only runtime deps, exposes a single
`startAcpAgent(transport, services, options)` entry point, and is
consumed by both host runtimes via a workspace dependency. The
M8 milestone publishes it to npm under its current name.
`packages/web-acp/` is the **extraction-pending** browser
reference app — host-runtime helpers under `runtime/` and
`acp/` are the candidates for a future `@bodhiapp/bodhi-web-acp`
host-runtime library; the `App.tsx` chat surface stays in the
reference repo.

**Historical paths.** Some files under
`ai-docs/web-acp/prompts/` and `ai-docs/plans/` reference the
old `specs/web-acp/` folder that was split into
`specs/web-acp-agent/` + `specs/web-acp-client/` post-M4 phase
B. Those plans / prompts are immutable historical artifacts —
when reading them, mentally re-route any `specs/web-acp/<topic>.md`
link to the matching topic file in either of the two new
folders (host topics → `web-acp-client/`, agent topics →
`web-acp-agent/`).

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
