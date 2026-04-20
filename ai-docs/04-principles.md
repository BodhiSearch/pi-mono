# Principles — how we work on web-agent

## Why this document exists

These are the rules that survive across plans. When a plan contradicts a principle, the plan is wrong. When a principle feels in the way, revisit it — don't quietly bypass.

Each principle has a **why** (so edge cases can be judged) and a **how** (so you can tell when you are violating it).

---

## 1. Web-agent does not depend on `packages/coding-agent`

**Why.** The Phase 6 extraction to `@bodhiapp/web-agent` requires a self-contained tree. `coding-agent` pulls node `fs`, `child_process`, jiti, `pi-tui` — all bundle-breaking in a browser target. Once an `import … from "@mariozechner/pi-coding-agent"` lands anywhere in `src/web-agent/`, extraction becomes a rewrite.

**How to apply.** Copy the pattern. Types, schemas, hook shapes, RPC dialects — copy the source, trim node-only bits, live with the short-term duplication. `grep -r "pi-coding-agent" packages/web-agent/src/web-agent/` must always return zero. An architectural lint rule in Phase 6 will enforce this; until then, reviewers enforce it by eye.

## 2. Storage is IndexedDB — not OPFS

**Why.** OPFS does not coordinate across browser tabs. Two tabs of the same origin writing the same file produce torn bytes with no error surface. We will not ship a library that corrupts user state when the user opens a second tab. IndexedDB transactions serialise naturally and abort atomically.

**How to apply.** All app-owned storage (`/extensions`, `/sessions`, any future app-owned mount) uses the `@zenfs/core` IndexedDB backend. `/vault` is the exception — it's the user's real disk via Chrome File System Access API, and concurrent-tab writes there are the user's problem, not ours. If a proposal reaches for OPFS, the answer is no unless a new entry in `decisions/` explains what changed about the concurrency story.

## 3. `src/web-agent/` imports inward only

**Why.** Same reason as principle 1 — extraction. If `src/web-agent/…` imports from `@/lib/bodhi-models` (app code), the agent package can't ship without dragging the app along. The agent must take its dependencies as constructor arguments, not as side-imports.

**How to apply.**

- Inside `src/web-agent/**`, no import may start with `@/` or cross into `packages/web-agent/src/` (app code), `packages/coding-agent`, or `packages/tui`.
- Allowed imports: `react`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`, `@zenfs/*`, `@sinclair/typebox`, `idb-keyval`, standard DOM.
- Anything else the agent needs: expose as a constructor argument on `AgentSession` / `RpcServer` / factory function, let the app inject it.

## 4. Test-driven, black-box, Playwright-first

**Why.** The library will be embedded in consumer apps. Tests that reach into internals via `page.evaluate`, `exposeFunction`, or `window.*` singletons prove nothing about the consumer-visible behaviour. Tests must exercise the product through the same surface the consumer uses — the UI and the public API.

**How to apply.**

- Playwright specs only interact via locators, clicks, typed input, visible assertions. No `page.evaluate` that reaches into ZenFS or RpcClient internals.
- Pre-render state priming via `page.addInitScript` + the `import.meta.env.DEV`-gated seam (`useDevSeedBoot`) **is allowed**: it feeds inputs in before the app runs, it doesn't sidestep the app's own paths.
- Unit tests (vitest) are allowed to reach deeper — they test pieces, not products. Use them for pure functions, RPC envelope correctness, tool operation adapters, extension lifecycle.
- When in doubt: if deleting your test would not cause the e2e to silently start passing when the product is broken, keep it.

## 5. Few high-value e2e tests, `test.step` per concern

**Why.** E2E tests are expensive — slow to run, slow to debug, brittle under UI change. A flood of thin e2e specs is worse than a handful of rich ones because each failure involves spinning up Bodhi, Chrome, and waiting on real LLM traffic.

**How to apply.**

- One spec per phase is the default, not the floor.
- Inside each spec, use `test.step("does X", async () => { … })` liberally. Each step carries its own assertions. Each step shows up in the Playwright report as a line item.
- Prefer asserting *observable consequences* (a file exists with content Y; the chat panel shows text Z) over intermediate state (a ref-counter, a spy call).
- If a feature needs 10 assertions, the answer is usually one spec with 10 `test.step`s, not 10 specs.

## 6. Unit tests earn their keep

**Why.** Trivial glue tests rot fast — every small refactor breaks them, and they provide no safety. Meanwhile, the RPC envelope's correctness, tool operations over ZenFS, and extension lifecycle are all subtle enough to warrant unit coverage.

**How to apply.**

- Write unit tests for: RPC round-trips, tool operation adapters (behaviour against a ZenFS InMemory instance), extension sandbox lifecycle (Phase 5), anything involving discriminated unions and serialisation.
- Don't write unit tests for: React component rendering beyond smoke-level, pass-through hooks with no logic, trivial getters.

## 7. Plans are disposable, steering is durable, decisions are append-only

**Why.** Plans change every session — they reflect in-flight intent. If steering and decisions live in the same folder as plans, they get churned or lost. Separating these by *lifecycle* prevents accidental deletion of rationale and prevents plans from rotting the vision.

**How to apply.**

- Per-deliverable plans live at `ai-docs/plans/*.md`. Disposable. Name them by deliverable, not by phase number (phases get re-planned; filenames shouldn't collide).
- Steering docs live at `ai-docs/*.md` — vision, goals, architecture, milestones, principles. Durable. Update in place; do not version with date suffixes.
- Decisions log at `ai-docs/decisions/` (index + per-group files). **Append-only.** A decision that turns out to be wrong gets a *new* decision entry that supersedes it by reference — the old entry stays as historical record, and the ledger row in `decisions/index.md` is updated to `superseded by Dxx`.

## 8. Ask before widening scope

**Why.** Silent scope creep breaks the phased contract. A Phase 2 plan that quietly also touches Phase 5 concerns makes the diff unreviewable, the gate unclear, and the rollback impossible.

**How to apply.**

- The plan file for a deliverable lists what is in-scope and what is out. If you notice something that needs doing outside the in-scope list, either add it to the plan (and get approval) or file it as an explicit follow-up — don't quietly do it.
- When unsure if something is in-scope: use `AskUserQuestion` with the two branches and let the user pick.
- "It'll only take a minute" is exactly the wrong reason to widen scope. If it's that small, it's also cheap to do in a follow-up where it gets its own review.

## 9. Don't silently bypass the phase gate

**Why.** The gate in `milestones/gate.md` is what guarantees each commit is shippable. If a gate step fails and gets worked around with `// @ts-ignore` or a skipped test, the milestone contract breaks — and the next milestone starts from a broken foundation.

**How to apply.**

- Every gate item listed in `milestones/gate.md` must pass before a milestone is declared done.
- If a real reason makes a gate item impossible, write it into `decisions/` with the tradeoff explained. Then the gate is updated, not bypassed.
- New `any`, new `// @ts-ignore`, new skipped tests require the same decision record.

## 10. When the evidence surprises you, write it down

**Why.** Non-obvious discoveries rot the moment the session ends. "Oh yeah, `tsc --noEmit` was secretly doing nothing" is the kind of thing that costs the next session an hour to rediscover.

**How to apply.**

- If something turned out to be different from your (or the docs') expectation, leave a trace. Short comment in code for micro-surprises, memory entry for cross-session ones, decision entry for permanent-behaviour ones.
- Specifically: if a build step has side-effects beyond what its name suggests (looking at you, `packages/ai`'s `build` regenerating `models.generated.ts` from live APIs), that's memory-worthy — every future session will trip on it otherwise.
