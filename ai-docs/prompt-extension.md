# Prompt — implement extensions in web-agent

We are continuing the port of `packages/coding-agent` → `packages/web-agent`. Previously landed: commands, prompt templates, skills (with a sandboxed `bash` shim). Next: **extensions** (M8).

The hard constraint that makes this non-trivial: **extensions live on the frontend (main thread, vault-loaded) but the agent runs in a Web Worker**. Functions, class instances, and live objects cannot cross `postMessage`. Every hook coding-agent's extension runner calls in-process has to be re-expressed as a cross-thread round-trip — same problem we solved for MCP tools (`set_mcp_tools` descriptors + `tool_call_request` / `tool_call_response` upcalls) and for skill capabilities (structured-clone request/response across iframe → host).

## Goal

Deliver a browser-native extension runtime that is **sound, clean, extensible, and resilient** — meaning: a well-defined cross-thread protocol, explicit error surfaces (an extension that throws does not take down the agent), predictable lifecycle on mount/unmount/reload, and room to grow into the full M8 genre list without reshaping the wire.

**Scope you decide.** M8 names four genres (prompt shaping, tool-output shaping, tool registration, skills-as-extensions). Pick an honest phase cut during exploration — start narrower if that keeps the architecture cleaner. Call out what's deferred and why.

**Loader you decide.** Main-thread ESM `import()` vs. the skill-style iframe+Worker sandbox is an open trade-off (trust, DOM access, complexity, HMR). Research the browser options, weigh against the existing `src/sandbox/` infrastructure, and justify the pick in the plan.

## References — read first, then decide

**coding-agent reference implementation** (read, do not import — `CLAUDE.md` hard rule):
- `packages/coding-agent/src/core/extensions/{types,runner,wrapper,loader}.ts` — runtime, hook dispatch, jiti loader.
- `packages/coding-agent/src/core/agent-session.ts` — where extension hooks are invoked in the turn lifecycle.

**web-agent prior art** (the existing cross-thread playbook):
- `packages/web-agent/src/worker-agent/core/extensions/types.ts` — scaffolding types already ported for forward-compat.
- `packages/web-agent/src/worker-agent/rpc/` — `rpc-types.ts`, `rpc-server.ts`, `rpc-client.ts`, especially the MCP upcall pair (`set_mcp_tools`, `tool_call_request`, `tool_call_response`). That pattern is the closest analogue for extension hooks and is the one to extend, not reinvent.
- `packages/web-agent/src/worker-agent/worker/worker-host.ts` — where mounts/unmounts/reloads live; extensions will plug into the same lifecycle.
- `packages/web-agent/src/worker-agent/core/commands/registry.ts` — extensions can contribute slash commands (`source: 'extension'` slot already reserved in `SlashCommandInfo`).
- `packages/web-agent/src/worker-agent/core/system-prompt.ts` — the prompt-shaping hook point.
- `packages/web-agent/src/sandbox/` — consider reusing for untrusted extension code; understand the trade-offs before copying.
- `packages/web-agent/src/hooks/useSkillSandbox.ts` + `ChatDemo.tsx` — the main-thread glue precedent for wiring a new capability into `useAgent`.

**Design context:**
- `ai-docs/milestones/m8-extensions.md` — scope, non-goals, gate.
- `ai-docs/extension-spike/` — prior research: feasibility, unbiased-from-scratch, open questions. **Read `README.md` and `06-open-questions.md` first.** Treat as input, not prescription — the spike is archived, not forward commitment.
- `ai-docs/specs/coding-vs-web-agent/` — `alignment.md` / `divergence.md` / `feature-gaps.md` / `guidance.md` to see how prior ports handled the worker boundary and where extensions currently sit in the gap list.
- `ai-docs/specs/worker-agent/skills.md` — the most recent port's spec; use its shape as the template for a new `extensions.md`.

## Test-data — pi.dev/packages

Pick **1–2 real extensions** from `pi.dev/packages` (browse the marketplace, open a couple of extensions that exercise different hooks — at minimum one that shapes the prompt, one that registers a tool or command). Copy them into `packages/web-agent/e2e/data/sample-with-extensions/.pi/extensions/<name>/`, adapting them to whatever web-compatible subset you define (document the adaptation in each fixture's README).

## Deliverables

1. **Plan file** at `ai-docs/plans/extensions_<hash>.plan.md` with the phase cut, loader choice + justification, RPC additions, and gate. Get the shape right before writing code.
2. **Implementation** under `packages/web-agent/src/worker-agent/core/extensions/` and whatever main-thread glue is needed (`src/extensions/` or similar; mirror the `src/sandbox/` split if useful). Follow the existing patterns — 2-space indent, structured-clone-safe RPC, worker as source of truth for state, main thread as host.
3. **e2e tests** at `packages/web-agent/e2e/extensions.spec.ts` — use `skills.spec.ts` as the template for fixture install + palette assertions + round-trip assertions.
4. **Unit tests** co-located with each new module (vitest), using the existing `*.test.ts` patterns.
5. **Spec** at `ai-docs/specs/worker-agent/extensions.md`, following the shape of `skills.md`. Cross-link into `worker-agent/index.md`, `coding-vs-web-agent/{alignment,divergence,feature-gaps,guidance}.md`, and update `ai-docs/milestones/m8-extensions.md` + `index.md`.
6. **`npm run check`** green at the end; **`npx vitest run`** green in `packages/web-agent/`; **`e2e`** covers the happy path for each implemented hook genre + one error-path assertion per hook (malformed extension, throwing hook).

## Guardrails

- No `packages/coding-agent` imports from `packages/web-agent` (enforced by convention; `grep` at review).
- No functions across `postMessage` — descriptors + ids only.
- Every extension failure is visible (surface as a transient or diagnostic), never silent.
- Mount/unmount/reload leave no leaked iframes, workers, or RPC listeners.
- Keep the wire forward-compatible with the M8 genres you defer.

Stay exploratory. If a question materially changes the architecture (trust model, cross-origin isolation requirements, bundled vs. CDN extensions, how HMR interacts with the sandbox), raise it before committing to code.
