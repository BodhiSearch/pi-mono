# M8 Extension Spike — Archive

**Status.** Spike complete. Code lives on the extension-spike branch for reference only. No commitment to ship any of it as-is. The next extension iteration (another spike or the production build) starts from these reports, not from the spike code.

**Why this folder exists.** The M8 research plan was framed around two axes (loading mechanism × lifecycle model) that pre-selected the solution space. The research found a working combination, but the framing itself was not unbiased — it inherited assumptions from `packages/coding-agent` (factory-based extensions, `ExtensionAPI` shape, event union) and from the earlier `ai-docs/` drafts (Dexie, ZenFS, Worker-first). This archive captures what we learned in a form that the next attempt can consume without those assumptions baked in.

**How to read.**

1. [`01-feasibility.md`](01-feasibility.md) — the unbiased feasibility landscape. What options exist for browser-based extensions, their trade-offs, and which are viable for our constraints. Read this first if you forget what the design space looks like.
2. [`02-spike-implementation.md`](02-spike-implementation.md) — what we actually built. Architecture, code map, runtime flow, RPC surface, what works, what doesn't. Read this to understand the current branch.
3. [`03-unbiased-approach.md`](03-unbiased-approach.md) — a clean-slate recommendation. If we were starting today with no prior code and no inherited assumptions, how would we design this? Written to stand alone; it does not defend the spike.
4. [`04-gap-analysis.md`](04-gap-analysis.md) — honest list of known defects, missing features, and over-engineering in the spike. The "needs page reload to see a new extension" bug lives here, as do the things we silently descoped.
5. [`05-lessons-learned.md`](05-lessons-learned.md) — retrospective. What the plan got right, what the plan got wrong, what surprised us during execution, and what to carry forward.
6. [`06-open-questions.md`](06-open-questions.md) — decision gates the next iteration must close before implementation starts. Written so a reviewer can step through them top-to-bottom with the user.

**Companion docs that still apply.**

- [`ai-docs/milestones/m8-extensions.md`](../milestones/m8-extensions.md) — milestone scope (feature-facing, technology-agnostic). Sanitised at the end of this spike.
- [`ai-docs/decisions/m8-extensions.md`](../decisions/m8-extensions.md) — D20 / D21 decision log entries from the spike. Treat as historical record, **not** as forward-looking commitments. If the next iteration overturns them, add a superseding D-entry per principle 7.
- [`ai-docs/plans/m8-extensions-exploration.md`](../plans/m8-extensions-exploration.md) and [`ai-docs/plans/m8-extensions-implementation-plan.md`](../plans/m8-extensions-implementation-plan.md) — the research and implementation plans that drove this spike. Disposable, but kept for context.
- [`packages/web-agent/docs/extensions.md`](../../packages/web-agent/docs/extensions.md) — user-facing extension author guide written against the spike. Will need rewriting when the runtime changes.
- [`packages/web-agent/scratch/m8/`](../../packages/web-agent/scratch/m8/) — the original research harness. Source for most feasibility findings.

**Next action.** When we pick this up again, the author of the next plan should:

1. Read this README and reports 01–06 in order.
2. Walk [`06-open-questions.md`](06-open-questions.md) with the user and record answers inline (as an addendum, not by editing the original questions — this folder is append-only).
3. Only then draft the next plan or spike.
