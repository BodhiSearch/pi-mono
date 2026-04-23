# web-agent — frozen reference archive

`packages/web-agent/` was the first iteration of our browser-native
agent harness. It shipped M0–M8 (M9 partial) and is now **frozen**:
no new features land, no new specs are written. The active initiative
is **web-acp** at `packages/web-acp/`; steering lives at
`ai-docs/web-acp/steering/`.

## What shipped

- **M0–M3** — workspace integration, RPC scaffold, ZenFS `/vault`
  mount via Chrome File System Access, six filesystem tools.
- **M4** — `AgentSession` behind a Web Worker boundary; bespoke
  JSON-ish RPC over `MessageChannel`; ZenFS tunneled via a second
  `MessageChannel`.
- **M5** — Dexie/IndexedDB session persistence; explicit
  `SessionStore` interface.
- **M6** — session tree: `forkSession`, branch navigation.
- **M7** — automatic + manual compaction; summary bubble with
  `data-test-state` hooks.
- **M8** — extensions runtime (Phases 1 + 2a + 2b): vault-scoped
  `.pi/extensions/<name>/index.js`, Blob-URL dynamic `import()` inside
  the Worker, every context/lifecycle hook, the full `pi.*`
  registration surface, modal `pi.ui.*` channel, readonly session
  forwarder. **Phase 3 isolation deferred by product decision** —
  extensions are fully trusted.
- **M9** — partial: vault-sourced slash commands, prompt templates,
  skills (sandboxed `bash` shim). Extension-provided commands and
  themes remain open.

## Why we pivoted

web-agent works, but client vs agent responsibilities blurred across
several surfaces (bespoke RPC shaped for UI, vault handle split across
threads, extension UI as a parallel protocol, slash commands
straddling main/worker). The web-acp rewrite adopts the **Agent
Client Protocol (ACP)** as the wire protocol, which makes the
client/agent split structural from day one. See
`ai-docs/web-acp/steering/00-vision.md` for the full rationale.

## How to use this archive

- **Consult for spec patterns.** `ai-docs/specs/worker-agent/` (still
  at its original path) is the authoritative technical spec for the
  worker-agent library and remains a useful crib sheet for web-acp
  (session shape, tool-operations pattern, extension hook surface).
- **Consult for e2e patterns.** `packages/web-agent/e2e/` is the
  template web-acp's tests will follow in spirit (page objects,
  `installVault`, `.env.test` convention).
- **Do not extend.** No new plans, no new milestones, no new features
  under `packages/web-agent/`. Bug fixes only, and only if the bug
  blocks web-acp's progress.
- **Do not import from it.** `packages/web-acp/` must not import from
  `packages/web-agent/` or `packages/coding-agent/`. Reference, do
  not depend.

## Layout of this archive

- `00-vision.md`, `01-goals.md`, `02-architecture.md`,
  `04-principles.md` — the original web-agent steering docs, moved
  here verbatim.
- `milestones/` — status board (`index.md`), per-milestone outcome
  summaries, `gate.md`, `deferred.md`, `reference-index.md`.

Other web-agent-era material still lives at its original paths:

- `ai-docs/specs/` — technical specs; kept in place because tests,
  code, and internal tooling reference these paths.
- `ai-docs/decisions/`, `ai-docs/plans/`, `ai-docs/extension-guide/`,
  `ai-docs/extension-impl/`, `ai-docs/extension-spike/` — append-only
  or work-in-flight material, not moved.
- `ai-docs/PENDING.md`, `compact.md`, `resume.md`,
  `prompt-extension*.md` — loose status/prompt files, not moved.

If any of these interferes with web-acp work, file a follow-up; do
not shuffle them quietly.
