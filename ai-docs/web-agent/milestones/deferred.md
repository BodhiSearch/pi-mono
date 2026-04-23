# Deferred to post-v1

**Extension sandboxing / isolation.** Installed extensions are **fully
trusted**. Once a user drops a package into `<vault>/.pi/extensions/`
and enables it via the `ExtensionsPanel`, it executes as first-class
code inside the agent Worker — same capabilities as core, same global
`fetch`, same access to the `pi` API and every subsystem the Worker
owns. The current `Blob`-URL dynamic `import()` loader is the permanent
design.

What this closes:
- No iframe-per-extension sandbox.
- No Worker-per-extension bridge.
- No shared-Worker capability broker.
- No permission prompts, allowlists, or capability tokens.

What stays in place because it is still useful with a trusted model:
- Per-handler `try`/`catch` error isolation in `ExtensionRunner` (keeps
  one broken extension from taking down the whole agent loop).
- Per-extension toggle + global "Disable all" trip switch in
  `ExtensionsPanel` (the M8 gate).
- Load-time + runtime error surfacing on `ExtensionDescriptor` (so users
  see which extension broke).

Background: Phase 3 of M8 was originally going to pick an isolation
model. Once the trust model was fixed, that entire phase stopped being
relevant. See [`../extension-impl/phase-3-prompt.md`](../extension-impl/phase-3-prompt.md)
for the archived original scope.

---

**Full shell / bash execution.** Browser has no process model. A **restricted** `bash` shim did land under M9 — it only runs `node <path>.js` scripts rooted at `<vault>/.pi/skills/` inside an iframe + Web Worker sandbox (see [`m9-resources.md`](m9-resources.md) and [`ai-docs/specs/worker-agent/skills.md`](../specs/worker-agent/skills.md)). What remains deferred is a general-purpose shell. Post-v1 options for that:
- Extension that proxies to a user-run local helper (user opts in, runs a trusted binary locally).
- Broader in-browser JS/TS evaluator with a pipeline model on top of the existing sandbox.
- WebContainer-style in-browser Node runtime.

None of these block v1.

**Multi-tab collaboration.** v1 is single-tab. IndexedDB-based storage tolerates concurrent tabs from a correctness standpoint (no corruption), but no explicit cross-tab sync is built.

**RAG / embeddings.** Can ship as an extension. Not core.

**Voice / audio modalities.** Outside the coding-agent shape. Out of scope.
