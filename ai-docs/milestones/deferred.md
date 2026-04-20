# Deferred to post-v1

**Shell / bash execution.** Browser has no process model. Post-v1 options:
- Extension that proxies to a user-run local helper (user opts in, runs a trusted binary locally).
- Web Worker-based JS evaluator bounded to `/vault` as a shell-adjacent tool.
- WebContainer-style in-browser Node runtime.

None of these block v1. An extension can add shell support when a user needs it.

**Multi-tab collaboration.** v1 is single-tab. IndexedDB-based storage tolerates concurrent tabs from a correctness standpoint (no corruption), but no explicit cross-tab sync is built.

**RAG / embeddings.** Can ship as an extension. Not core.

**Voice / audio modalities.** Outside the coding-agent shape. Out of scope.
