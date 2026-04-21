# Deferred to post-v1

**Full shell / bash execution.** Browser has no process model. A **restricted** `bash` shim did land under M9 — it only runs `node <path>.js` scripts rooted at `<vault>/.pi/skills/` inside an iframe + Web Worker sandbox (see [`m9-resources.md`](m9-resources.md) and [`ai-docs/specs/worker-agent/skills.md`](../specs/worker-agent/skills.md)). What remains deferred is a general-purpose shell. Post-v1 options for that:
- Extension that proxies to a user-run local helper (user opts in, runs a trusted binary locally).
- Broader in-browser JS/TS evaluator with a pipeline model on top of the existing sandbox.
- WebContainer-style in-browser Node runtime.

None of these block v1.

**Multi-tab collaboration.** v1 is single-tab. IndexedDB-based storage tolerates concurrent tabs from a correctness standpoint (no corruption), but no explicit cross-tab sync is built.

**RAG / embeddings.** Can ship as an extension. Not core.

**Voice / audio modalities.** Outside the coding-agent shape. Out of scope.
