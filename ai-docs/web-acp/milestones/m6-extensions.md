# M6 — Extensions

## What this milestone delivers

A third party can drop a JavaScript module into
`/vault/.pi/extensions/<name>/` and, on next session, have it
extend the agent: register a new tool, hook into session lifecycle,
provide a custom model provider, or add new slash commands / prompt
templates / skills from code.

## ACP surface touched

**The starting question is "how does ACP extend?" — not "how did
web-agent load extensions?"** web-agent's Blob-URL loader is a sunk
cost of that package, not a requirement we inherit. See
principle 13.

Candidate shapes to evaluate during the plan:

- Extension tools as ordinary agent-side tools that the agent
  advertises through normal ACP capability negotiation. Client
  doesn't need to know they came from an extension; they look like
  first-party tools.
- Lifecycle hooks (`before_agent_start`, `tool_call` pre/post,
  `turn_start/end`, `session_loaded`) as ACP notifications the
  agent emits and re-entrypoints for extensions to handle. The
  client does not participate; extension runs agent-side.
- Custom providers — extension registers a model adapter with
  `pi-ai` at agent startup. No client-side surface.
- Extension-provided UI (web-agent's `pi.ui.*`) — most of what
  web-agent built bespoke maps onto ACP's `tool_call` permission
  flow. Any residual UI request becomes an ACP extension.

The plan identifies which of web-agent's extension hook points
have genuine ACP-shaped equivalents and which don't (and of those,
which we drop, extend ACP for, or justify as sub-protocols).

Trust model: **fully trusted**, unchanged from web-agent's Phase 3
decision. Installing an extension means the user put it in the
vault. Rationale at
`ai-docs/web-agent/milestones/deferred.md` § Extension sandboxing.

## Depends on

- **M1** — extensions run alongside sessions; session persistence
  must be stable.
- **M2** — extensions read their own files via `fs/*`.
- **M4** — extensions may want to hook into compaction; need the
  compaction surface to be stable.
- **M5** — extensions must be able to register resources, so the
  vault-sourced resource pipeline must exist.

## Out of scope

- Third-party marketplace / discovery / updater. Manual install
  only.
- Sandboxed execution / manifest permission system. Fully trusted,
  period.
- Backwards-compatible loading of web-agent extensions. Different
  runtime shape. Extension authors re-port; we do not maintain
  compatibility shims.
- Multi-extension dependency resolution beyond "load in lexicographic
  order, first-wins on name conflict".

## Why this ordering

Extensions are the **last feature milestone.** They multiply every
preceding surface — a bug in extension lifecycle can corrupt any
prior feature. Landing them late means the core is stable when they
enter, and their design can be driven by what we actually learnt
about ACP in M0–M5, not by what we think ACP will look like.

Flag: extensions are the most likely milestone to expose a real gap
in ACP's extensibility story. If the plan finds that ACP simply
cannot carry our extension model without a sibling protocol, that's
a product decision, not an engineering one — escalate.
