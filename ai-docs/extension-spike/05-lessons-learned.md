# 05 — Lessons Learned

**Purpose.** Retrospective on the spike itself — the planning, the execution, the framing. Not about the code. About how we arrived at the code.

---

## 1. What the research plan got right

- **Spike-first rule.** The decision to run experiments in `packages/web-agent/scratch/m8/` before writing any production code was correct. The experiments produced evidence quickly and cheaply. Keep this pattern.
- **Decision gate.** Forcing a user-driven `AskQuestion` at the end of the research phase was the right shape. It stopped the flow-of-work from silently committing us to an implementation.
- **Deterministic sample extensions.** Choosing `[EXT:ECHO]`, `MAGIC_RABBIT_42`, and an upper-case transform made the e2e assertions unambiguous. This discipline is worth codifying as a testing principle.
- **Per-milestone plan files.** Splitting exploration from implementation plan files kept scope changes visible.

---

## 2. What the research plan got wrong

### 2.1 The axes were not unbiased

The plan presented two "axes" to explore:

- **Axis A (loading mechanism).** Cross-origin URL / same-origin static / ZenFS / Dexie / build-time / hybrid.
- **Axis B (lifecycle).** Rebuild-required / page-reload / Worker-restart / true-hot-swap.

Both axes are narrowed to "ways we load user-provided code into a sandbox". The whole design space of *not* loading code at all — declarative extensions, built-in toggles, compile-time registries — was invisible on the axes. The research gate therefore could not pick them.

A plan frames the decision. If the plan only offers code-loading approaches, the decision will be a code-loading approach. In retrospect the right axes would have been:

- **Who authors extensions?** (first-party / user-paste / marketplace)
- **How much power does an extension need?** (declarative / handler / full runtime)
- **Where does extension code run?** (inline / shared worker / sandboxed worker / iframe)

With those axes, the research gate would likely have ended at "first-party, declarative + handler, inline" — roughly the proposal in [`03-unbiased-approach.md`](03-unbiased-approach.md).

### 2.2 The plan inherited `coding-agent`'s answer to a different problem

`coding-agent` is a terminal-TUI tool for one developer on one machine. Extensions there need a huge API (TUI widgets, shell exec, process spawn, filesystem walks, theme control). The plan copied that ambition even while trimming TUI bits.

What our product needs (a chat UI with a vault and tools) is much smaller. We imported `coding-agent`'s answer instead of re-deriving a smaller one. Next time, derive the API surface from *our* target genres, not from a sibling project's surface.

### 2.3 "Decision gate" didn't gate the hardest decision

The gate picked `A4 × B4` (Dexie + hot-swap). Those are implementation choices. The actually-hard decisions — intent, trust model, authoring UX — were never put in front of the user. They were assumed (intent = 3+4, trust = permissive, UX = paste ESM string).

When the user said at the end "we heavily influenced the direction decision, but having dexie/zenfs etc. in the milestone doc", they were identifying this exact failure mode. A decision gate should surface the *framing*, not just the choices inside a pre-chosen frame.

### 2.4 Scope preview baked in the implementation

The pre-spike milestone doc listed `ZenFS mount`, `Dexie`, `Web Worker`, `Blob URL dynamic import` as *scope preview*. That preview then acted as a lock: the spike experiments were scored against those approaches, and the "winning" one was one of those approaches. A scope preview should describe *what the feature does*, not *how it works*. The sanitized milestone doc corrects this retrospectively.

---

## 3. Execution surprises

### 3.1 The "factory in a string literal" authoring model is terrible

Sample extensions store their source as a template literal inside a TypeScript file. Writing one requires opening two windows in your head: "this TS file exists to carry a string that, interpreted as JavaScript, does X". There is no type-checking on the inner string. No autocomplete. No prettier. Real authoring inside this model would be miserable.

Takeaway: if user-authored code is a goal, invest in a real authoring surface (codemirror + types fed from a `.d.ts`) before inviting users to write anything.

### 3.2 Nested Workers under Vite dev are flaky

Not new information in the ecosystem, but a surprise in the context of our app. The spike treated "it works in dev" as equivalent to "it works". When we ran the full flow interactively, the "needs reload" symptom appeared immediately. Unit tests don't catch this because they use an in-process fake Worker.

Takeaway: any feature that relies on browser dev-only behaviours needs at least one e2e run under `npm run build` + preview before being called done. The current gate doesn't enforce that.

### 3.3 "E2E tests pass" ≠ "the feature works"

`extensions.spec.ts` runs reliably. The spike is nevertheless broken in practice (see [`04-gap-analysis.md`](04-gap-analysis.md) §1.1). Why? Because the e2e test is a cold page load + immediate interaction — the exact pattern that makes nested Worker spawn succeed. Real users toggle, prompt, toggle, prompt in rapid succession, which hits the path that fails.

Takeaway: e2e tests must include a "settle then interact" variant, not only "cold-boot-one-shot" variants. The discipline belongs in the testing-principles doc.

### 3.4 TypeScript worker lib configuration is a papercut

`DedicatedWorkerGlobalScope` is not in the default `DOM` lib set. The spike worked around this by defining a minimal `WorkerScope` interface ad-hoc. Fine for the spike; not fine for a codebase at our size. A single `tsconfig.worker.json` with `lib: ["WebWorker"]` included would be cleaner.

Takeaway: lifting the worker tsconfig out is small unrelated work that pays back in every future Worker we write.

### 3.5 `refreshTools` timing matters more than it looked

`AgentSession.setTools` can be called mid-stream safely, but the effective tool list for a turn is the one captured when the agent builds its request. Extensions that register tools after that capture simply aren't visible to that turn. This was not called out in the plan and bit us in two places (§1.3 of gap analysis).

Takeaway: any "tools change mid-turn" feature needs to document the capture semantics. Extensions, MCP servers, and compaction all share this hazard.

---

## 4. Scope and size — what we'd do differently

The implementation plan predicted roughly 9 phases, ~1 week. It took ~1 week in calendar time but produced ~2 400 LOC plus ~1 600 LOC in the research scratch folder (kept). The finished feature is barely usable (bug §1.1). That's a bad ratio.

A more honest process:

1. Spend one day only on **framing** — who authors, how much power, where it runs. Force the user to answer before writing any experimental code.
2. Spend one to two days on the **lightest-weight** implementation that satisfies the framed intent. For our current intents that's the unbiased v1 (~800 LOC).
3. Spend one day on **observability** — at install time, at enable time, at load time, every failure should surface to the UI with an error message the user can act on. The spike has zero of this; the next iteration must have it by default.
4. Spend time on **testing**, specifically including build + preview e2e, before declaring anything green.

---

## 5. What to codify in `ai-docs/04-principles.md` after this

Candidate new principles to float past the user before adding (they are principles, not a plan item I should quietly add):

- **Frame the design space before picking a point.** When a plan offers axes to explore, at least one axis must include "don't do this at all" as a cell.
- **E2E must include a warm-state path.** Every user-facing flow must have one test that interacts after the app has been running a while, not only one that interacts on cold boot.
- **Prefer declarative over imperative at the boundary.** When extending the system, the default answer is "can this be a JSON record + a fixed transform?". Code execution is an escape hatch.

These want user assent before they become principles — they constrain future plans.

---

## 6. Carry-forward list

Things this spike produced that are genuinely useful to the next iteration, independent of whether the runtime approach changes:

- The three deterministic sample extensions as test fixtures (rewritten as real modules).
- The `data-testid` convention on `ExtensionsPopover`.
- The `pendingExtensionChanges` flush-at-`agent_end` pattern.
- The observation that `before_agent_start` and `tool_result` are the minimum-viable event surface (§5 in `03-unbiased-approach.md`).
- The clean separation of `userSystemPrompt` from the mutated one — a small but correct bit of lifecycle management.
- D21 (deferred mid-stream toggles) as a lifecycle rule — applies no matter where extensions run.

Everything else is pedagogically useful but not load-bearing for the next iteration.
