# M10 — Polish (HTML export, diagnostics, logging)

**Status:** planned. Test seam: vitest.

**Scope preview.**
- HTML export: render a session to self-contained HTML (inline CSS, embedded images). Reuse coding-agent's `export-html/` logic (already mostly node-fs-free, just emits HTML).
- Diagnostics collection: pluggable event subscribers record timings, tool call latencies, model response sizes. Available via RPC command `get_diagnostics`.
- Debug log level: `RpcClient.setLogLevel('debug')` dumps the full event stream to console for easier triage.

**Coding-agent references.** `packages/coding-agent/src/core/export-html/*`, `diagnostics.ts`, `timings.ts`, `event-bus.ts`.

**Gate.** vitest for export HTML generation (smoke-level). Manual verification for diagnostics / logging.
