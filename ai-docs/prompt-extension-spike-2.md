# Prompt — M8 Extensions, Spike 2 (Example-Driven, First-Principles)

**You are running the second M8 extensions spike.** Spike 1 is archived at [`ai-docs/extension-spike/`](extension-spike/); it is **reference material, not a forward plan**. Your job is to produce a fresh, evidence-based implementation plan by (a) reading the current production code, (b) doing real research on real extensions from real repositories, and (c) deriving an incremental, example-adoption-driven roadmap from that evidence — not from previous prescriptions.

---

## 1. Posture — how to think about this

1. **First principles only.** Do not inherit any mechanism, API shape, trust model, or storage choice from spike 1, from the M8 milestone doc, or from `packages/coding-agent`. Read them for context; accept none of them as given. If spike 1's choices are correct, your research will arrive at them independently. If they aren't, your research will say so.
2. **Example-adoption driven.** The quality of the final plan is measured in concrete extensions that work, not in abstraction breadth. Every API surface decision must be justifiable against a specific extension in the public corpus that needs it. If no listed extension needs a feature, that feature is not in v1.
3. **Iterative, capability-unlocking phases.** The plan's phases are named after the extensions / extension-genres they make work, not after internal refactors. "Phase 2: `/btw` works end-to-end" is the right shape. "Phase 2: refactor the supervisor" is not.
4. **Defer or reject freely.** If an extension genre does not fit the browser / Worker / RPC constraints, say so with a one-paragraph rationale and move on. Do not silently descope. A rejected extension is a valuable output — it narrows the spec.
5. **Bias audit.** When you finish a section, re-read it and ask: is this shaped by evidence from the research, or by habit from spike 1? Mark anything you cannot defend with a specific extension reference for deletion.

---

## 2. Context anchors — read these, in this order, before writing

**A. The product and its constraints (what we're embedding into).**

- `ai-docs/00-vision.md` — what web-agent is, who it's for, what "done" looks like.
- `ai-docs/01-goals.md` — goal hierarchy including the extension-surface goals K1–K4.
- `ai-docs/02-architecture.md` — runtime shape: main thread, agent Worker, MCP upcalls, ZenFS vault, RPC boundary.
- `ai-docs/04-principles.md` — non-negotiables. Especially principles 1 (no `coding-agent` imports), 2 (IDB not OPFS), 3 (inward-only imports), 4–6 (test discipline), 7 (plans disposable, decisions append-only), 8–9 (no scope creep, no silent gate bypass).

**B. The current production snapshot (the surface we're extending).**

The repo is currently on `main`. Spike 1's implementation is **not** on `main` — it was preserved on the `spike-extension` branch and deliberately omitted from `main` so this spike starts from a clean runtime.

Read on `main`:

- `packages/web-agent/src/web-agent/core/agent-session.ts`
- `packages/web-agent/src/web-agent/worker/worker-host.ts` and `worker/agent-worker.ts`
- `packages/web-agent/src/web-agent/rpc/rpc-types.ts`, `rpc-server.ts`, `rpc-client.ts`
- `packages/web-agent/src/web-agent/core/session/**`
- `packages/web-agent/src/web-agent/core/tools/**` and `fs/zenfs-*`
- `packages/web-agent/src/hooks/useAgent.ts` and any hooks the UI consumes

Read **on the `spike-extension` branch** (via `git show spike-extension:<path>` or `git worktree add ../pi-mono-spike spike-extension`; **do not** merge it into `main`):

- `packages/web-agent/src/web-agent/core/extensions/**` and `src/web-agent-extensions/**` — the spike's integration points. Study to understand which seams in the main-branch code were touched; do not inherit the design.
- `packages/web-agent/docs/extensions.md` — the spike's author guide; tells you what shape the spike 1 authors were expected to publish against.

**C. The upstream contract we're mirroring or diverging from.**

- `packages/coding-agent/src/core/extensions/types.ts` — the full TUI-era API surface. Study for vocabulary, not to copy.
- `packages/coding-agent/src/core/extensions/{runner,loader,wrapper}.ts` — how they dispatch events, register tools, wrap into agent tools. The node-only bits must be replaced; the shapes of `emit*` dispatch loops inform ours.

**D. Spike 1 archive — read as prior art, not as direction.**

- [`ai-docs/extension-spike/README.md`](extension-spike/README.md) through to `06-open-questions.md`. You are allowed to agree with any conclusion there, but only after arriving at it yourself.

**E. Related milestone context.**

- `ai-docs/milestones/m8-extensions.md` — feature goal only; intentionally non-prescriptive after sanitisation. Do not re-inject implementation specifics into it.
- `ai-docs/milestones/m9-resources.md` and `m10-polish.md` — adjacent milestones you must not accidentally consume.
- `ai-docs/decisions/m8-extensions.md` — D20 (spike-only, **not** a forward commitment) and D21 (mid-stream toggle deferral, likely keepable). Every inherited decision needs explicit re-affirmation.

Read these before anything else. When you start writing the plan, you should be able to cite specific file paths and line ranges from (B) and (C) for every claim about the runtime.

---

## 3. Research corpus — ingest these fully

You must directly read the sources you cite. Do not rely on spike 1's summaries, this prompt's excerpts, or README skim-reads. The corpus is much larger than it was at spike 1 time, and it's growing — **the registry is primary, individual curated repos are secondary**.

### 3.1 The pi package registry (primary source)

Pi packages are discoverable via two surfaces:

- **[pi.dev/packages](https://pi.dev/packages)** — human-readable index, filterable by `extension` / `skill` / `theme` / `prompt`, sortable by downloads / recency / name. As of 2026-04-21 it indexes **1446 packages total** (730 extensions, 64 skills, 36 themes, 13 prompts). Use this for browsing and for reading individual READMEs.
- **[`registry.npmjs.org/-/v1/search?text=keywords:pi-package`](https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250)** — the authoritative JSON API that pi.dev itself consumes. Fetch directly with `curl`/`fetch` when you want data at scale. Paginate via `&from=` in multiples of 250.

**Keyword conventions** (how a package declares what it is, in its `package.json`):

- All pi-installable packages carry the keyword `pi-package`.
- Type sub-keywords: `extension` / `pi-extension` / `extensions`, `skill` / `pi-skill` / `skills`, `theme` / `pi-theme` / `themes`, `prompt` / `pi-prompt` / `prompts`. (A package may declare more than one.)
- Per-package manifest detail lives at `https://registry.npmjs.org/<name>/latest` (the pi.dev page fetches this lazily for each card).

**Use the registry to answer all of these** (do not hand-curate):

1. What are the top *N* extensions by weekly downloads? (popularity proxy for "worth porting first")
2. Which extensions touch which APIs? (read `package.json`, grep `pi.extensions[]`, read the source)
3. Which skills are in use? What is their author's expected tool-call shape?
4. Which extensions are *duplicates* of each other under different names? (pick one canonical form; defer the rest.)
5. Which extensions cluster around a single author / monorepo? (treat the author's whole package set as one unit — e.g. `@the-forge-flow/*`, `@juicesharp/rpiv-*`, `@feniix/pi-*`, `@0xkobold/pi-*`, `@davidorex/pi-*`.)

**Top-50 extensions by weekly downloads — seed list** (as of 2026-04-21; use the registry for fresh numbers and for the long tail). These are the packages where the ecosystem has actually converged — start here when deciding what phase 1–3 must unlock.

| Rank | Weekly | Package | Theme |
|---:|---:|---|---|
| 1 | 8358 | `pi-mcp-adapter` | MCP (Model Context Protocol) adapter for pi |
| 2 | 5888 | `@ollama/pi-web-search` | Web search + fetch via Ollama's API |
| 3 | 4841 | `pi-web-access` | Web search, URL fetch, repo clone, PDF extract, YouTube |
| 4 | 4033 | `whatsapp-pi` | WhatsApp integration |
| 5 | 2301 | `pi-btw` | `/btw` — parallel side conversations |
| 6 | 2064 | `pi-lens` | LSP / linters / formatters / type-check feedback in TUI |
| 7 | 2041 | `pi-docparser` | PDF / Office / spreadsheet parsing tool + skill |
| 8 | 1918 | `@aliou/pi-processes` | Process management |
| 9 | 1887 | `pi-agent-browser-native` | `agent-browser` as a native pi tool |
| 10 | 1830 | `pi-powerline-footer` | Powerline-style status bar |
| 11 | 1770 | `@samfp/pi-memory` | Persistent memory with correction learning |
| 12 | 1705 | `@juicesharp/rpiv-pi` | Skill-based dev workflow meta-pack |
| 13 | 1633 | `@axnic/pi-extension-settings` | Centralised settings panel for pi extensions |
| 14 | 1575 | `@lnilluv/pi-ralph-loop` | Autonomous coding-iteration loop with mid-turn supervision |
| 15 | 1476 | `pi-mermaid` | Renders Mermaid diagrams as ASCII in the TUI |
| 16 | 1355 | `@juicesharp/rpiv-ask-user-question` | Structured-options ask-user |
| 17 | 1351 | `pi-oracle` | ChatGPT web-oracle with isolated browser auth + async jobs |
| 18 | 1324 | `pi-schedule-prompt` | Cron-like prompt scheduling |
| 19 | 1310 | `@juicesharp/rpiv-advisor` | Advisor-strategy — escalate to a stronger reviewer model |
| 20 | 1285 | `@lincoln504/pi-research` | Web research tools + research agent system |
| 21 | 1279 | `@walterra/pi-charts` | Vega-Lite chart rendering as inline images |
| 22 | 1277 | `@axnic/pi-extension-settings-sdk` | Type-safe SDK for the settings panel |
| 23 | 1227 | `@juicesharp/rpiv-web-tools` | Brave Search web_search + web_fetch |
| 24 | 1226 | `@juicesharp/rpiv-todo` | Claude-Code-parity todo tool + overlay widget |
| 25 | 1083 | `pi-interactive-shell` | Run AI coding agents in pi TUI overlays |
| 26 | 1049 | `pi-agent-memory` | Persistent cross-session memory, claude-mem backed |
| 27 | 1038 | `@juicesharp/rpiv-btw` | `/btw` side-question slash command |
| 28 | 1006 | `@aliou/pi-guardrails` | Guardrails |
| 29 | 972 | `pi-ask-user` | Interactive ask-user with searchable split-pane |
| 30 | 918 | `@lpirito/pi-diffloop` | Pair-programming with awareness of every change |
| 31 | 906 | `@kmiyh/pi-skills-menu` | Skills moved into a dedicated `/skills` menu |
| 32 | 892 | `@aliou/pi-synthetic` | Synthetic |
| 33 | 892 | `@the-forge-flow/hippo-memory-pi` | Biologically-inspired long-term memory |
| 34 | 872 | `pi-observational-memory` | Cache-friendly tiered compaction with observations |
| 35 | 818 | `@tintinweb/pi-subagents` | Claude-Code-style autonomous sub-agents |
| 36 | 784 | `@m64/pi-screenshot-tools` | Screenshot skill + inline screenshot extension |
| 37 | 783 | `@0xkobold/pi-kobold` | Meta-pack bundling pi-orchestration/gateway/ollama/persona |
| 38 | 766 | `@the-forge-flow/sub-agents-pi` | Sub-agents with live TUI spying |
| 39 | 711 | `@alexanderfortin/pi-freestyle-sandbox` | Sandboxed subagents in Freestyle cloud VMs |
| 40 | 703 | `@ramarivera/pi-ts-aperture-provider` | Config-driven aperture provider extraction |
| 41 | 679 | `pi-copy-response` | Copy latest assistant response with code-block picker |
| 42 | 672 | `@feniix/pi-exa` | Exa MCP extension — web search + advanced search |
| 43 | 672 | `@the-forge-flow/gitnexus-pi` | Native GitNexus code-intelligence integration |
| 44 | 664 | `@the-forge-flow/gh-pi` | Native GitHub CLI (`gh`) integration |
| 45 | 663 | `@feniix/pi-specdocs` | PRDs / ADRs / implementation plans with cross-refs |
| 46 | 655 | `pi-quests` | Quest-log for the agent |
| 47 | 655 | `pi-claude-style-tools` | Claude-Code-style tool rows (bash/read/grep/find/…) |
| 48 | 637 | `@the-forge-flow/visual-explainer-pi` | HTML visualisations of diagrams + architecture |
| 49 | 636 | `@feniix/pi-notion` | Notion API — pages, databases, content |
| 50 | — | (registry for #50+ — fetch fresh) | |

**Top skills by weekly downloads — seed list** (same date, same caveat):

| Rank | Weekly | Package | Theme |
|---:|---:|---|---|
| 1 | 2041 | `pi-docparser` | PDF / Office / spreadsheet parsing |
| 2 | 1990 | `@heart-of-gold/toolkit` | Cross-platform skill installer (also works with Codex/OpenCode) |
| 3 | 1705 | `@juicesharp/rpiv-pi` | Discover → research → design → plan skills |
| 4 | 1049 | `pi-agent-memory` | Cross-session memory |
| 5 | 906 | `@kmiyh/pi-skills-menu` | `/skills` menu |
| 6 | 784 | `@m64/pi-screenshot-tools` | Screenshot skill |
| 7 | 473 | `pi-memory-md` | Letta-like memory via structured markdown in a GitHub repo |
| 8 | 469 | `pi-claude-plugins` | Surface Claude marketplace plugin skills from `~/.claude/plugins` |
| 9 | 293 | `@weiping/pi-superpowers` | Superpowers skills: TDD, debugging, collab workflows |
| 10 | 245 | `pi-context` | Agentic context management |
| 11 | 204 | `@alexgorbatchev/pi-skill-library` | Exposes skills-library roots through `/library:<skill-name>` |
| 12 | 185 | `pi-amplike` | Amp-Code-like workflows (handoff, permissions) |
| 13 | 180 | `mitsupi` | Armin's pack — commands, skills, extensions, themes |
| 14 | 149 | `sutras` | Skill-development toolkit with `/sutras` commands |
| 15 | 90 | `@ogulcancelik/pi-web-browse` | Web search + content extraction |
| 16 | 77 | `pi-shit` | Personal pack: extensions + skills + Rose Pine themes |
| 17 | 43 | `shitty-extensions` | Hjanuschka's custom extensions + skills |
| — | — | (registry for long tail) | |

### 3.2 Known cluster repos (secondary — well-curated starting points)

These pre-date the registry boom and are worth reading because they're hand-organised and their authors explain the rationale in monorepo READMEs. Some of their extensions also appear in §3.1 as npm packages.

- **[mitsuhiko/agent-stuff](https://github.com/mitsuhiko/agent-stuff)** — published as `mitsupi` (#13 in skills). Categories: `extensions/` (`answer`, `btw`, `context`, `control`, `files`, `split-fork`, `go-to-bed`, `loop`, `multi-edit`, `notify`, `prompt-editor`, `review`, `session-breakdown`, `todos`, `uv`, `whimsical`), `skills/` (20+), `themes/`, `distributions/` (`mitsupi-common`, `mitsupi-loaded`).
- **[tomsej/pi-ext](https://github.com/tomsej/pi-ext)** — richer UI extensions (leader-key palette, custom footer, tool pills, code review, pi-sem semantic tooling, Pi-Telescope TUI fuzzy finder, session snap/query, handoff, permissions modes, cmux integration, ask-user structured-question tool). Notable: permission modes (`yolo` / `safe` / `read-only`) and UI-heavy components.
- **[hjanuschka/shitty-extensions](https://github.com/hjanuschka/shitty-extensions)** — published as `shitty-extensions` (#17 in skills). `branch-sessions`, `clipboard`, `oracle`, `memory-mode`, `plan-mode`, `handoff`, `usage-bar`, `ultrathink`, `status-widget`, `cost-tracker`, `speedreading`, `loop`, `flicker-corp`, `resistance`. Plus skills.
- **[aliou/pi-harness](https://github.com/aliou/pi-harness)** — `qq`, `defaults`, `providers`; personal harness with selective extension loading through `settings.json`. Author publishes `@aliou/pi-processes`, `@aliou/pi-guardrails`, `@aliou/pi-synthetic`, `@aliou/pi-linkup`, `@aliou/pi-neuralwatt`, `@aliou/pi-ts-aperture`, `@aliou/pi-toolchain`, `@aliou/pi-dev-kit`, `@aliou/pi-extension-dev`.
- **[kcosr/pi-extensions](https://github.com/kcosr/pi-extensions)** — `codemap`, `apply-patch-tool`, `assistant`, `skill-picker`, `toolwatch` (audit + approval + SQLite logging), `agent-voice-adapter-reminder`, `session-followup-rules`.
- **[badlogic/pi-skills](https://github.com/badlogic/pi-skills)** — `brave-search`, `browser-tools` (CDP), `gccli`/`gdcli`/`gmcli` (Google Calendar/Drive/Gmail), `transcribe` (Groq Whisper), `vscode`, `youtube-transcript`. Skills are `SKILL.md` + helper scripts, with `{baseDir}` placeholder substitution. Compatible with Claude Code / Codex CLI / Amp / Droid.

**Explicitly excluded (duplicate content):** `jayshah5696/pi-agent-extensions` is a fork of `mitsuhiko/agent-stuff` with small additions (`sessions`, `ask_user`, `handoff`, `cwd_history`, `nvidia-nim`, `powerline-footer`, `session-breakdown`). Crawl only for the *novel* bits not in the upstream.

### 3.3 Adjacent protocols you must also study (UI + elicitation conventions)

- **MCP (Model Context Protocol)** — the spec, specifically:
  - Tool-result structured content.
  - **Elicitation** — server-initiated user-input request pattern; already has a shape we can mirror for extensions asking the user something (cf. `pi-ask-user`, `pi-oracle`, `@juicesharp/rpiv-ask-user-question`).
  - **Resources / Prompts / Roots** — vocabulary for skills + prompt templates.
- **mcp-ui** (search: `"mcp-ui" protocol UI` — `idosal/mcp-ui` and similar) — community effort to ship UI snippets over MCP (iframed widgets, interactive forms). Read their current README and at least one example. Judge whether we can adopt/fork their envelope, or whether we need a different shape for the web-agent's React+Vite UI.
- **Chrome Extensions MV3 manifest + permissions prompt UX** — study for how permissions are surfaced at install time. We will likely copy this UX even if the runtime differs.
- **VSCode Extension Host protocol** — read how they split API host ↔ extension host and how contributions get declared. Match what we need; ignore the marketplace stuff.

For each registry query, each package you read, and each protocol you study, keep notes in a research-notes file (see §7 for the exact output file list).

---

## 4. Web-agent constraints you must respect

These are binding. If your plan violates any of them, it's wrong.

**Runtime.**

1. **Browser + Web Worker only.** No node `fs`, no `child_process`, no process spawning, no native dialogs, no terminal. Extensions written assuming a TTY, `ui.custom`, `setWidget`, `ghostty split`, `tmux send-keys`, keyboard raw mode, or OSC escape codes **cannot run here**. Either they're rejected, or we invent a React-shaped substitute.
2. **No repo-clone storage.** There is no `~/.pi/agent/extensions/` directory, no `git clone` step, no filesystem-walk loader. Any packaging model that assumes "copy this folder into a directory" must be translated to a browser-native distribution model.
3. **RPC boundary is structured-clone-safe.** Main thread ↔ agent Worker communication goes through typed commands (`RpcCommand`) and typed events. Functions, class instances, live React elements cannot cross the boundary. This matters a lot for extensions that want to render UI — they contribute *data* for the main thread to render, not rendered DOM.
4. **`src/web-agent/` imports inward only** (principle 3). Extensions cannot import from `@/` (app code) or from `packages/coding-agent`. If an extension needs `AGENTS.md`-style files, those come through a vault API, not through cross-package imports.
5. **Storage is IDB** (principle 2). Anything persistent an extension wants lives in IndexedDB or under `/vault` (user-picked local folder).
6. **MCP is already present.** The web-agent already upcalls to MCP tools via RPC. Extensions that want network-hosted capabilities may be satisfied by an MCP server rather than needing a local runtime.

**UI.**

7. **React + Vite + Tailwind.** UI contributions are React components or structured data that main-thread React renders. No TUI widget primitives translate directly.
8. **E2E is Playwright-first, black-box** (principle 4). Extensions that ship UI must expose `data-testid` / `data-test-state` so their UI is assertable without reaching into internals.
9. **`test.step` per concern** (principle 5). Extension specs are one spec per genre, many steps each — not one spec per handler.

**Scope.**

10. **No new `any`, `@ts-ignore`, or skipped tests** (principle 9).
11. **Ask before widening scope** (principle 8). If an extension needs a new vault permission, a new LLM-provider surface, or a new compaction hook, flag it — do not silently enable it.

---

## 5. Opportunities (the upside to lean into)

The browser/RPC constraints are mostly restrictions, but three of them are *opportunities* we should exploit:

- **Rich UI.** Unlike a TUI we can render real forms, dialogs, menus, progress bars, diffs, tables, charts. Extensions that were painful in pi's `ui.custom` (`ask_user`, `oracle` model picker, `files` browser, `leader-key` palette, `handoff` editor, `review` flow, `codemap`) can be *better* here.
- **MCP-native.** Any extension that's really "call a service" (`brave-search`, `gccli`, `gdcli`, `gmcli`, `transcribe`, `youtube-transcript`) is an MCP server, not an extension. We already have the upcall path.
- **Vault as first-class.** `/vault` is a real directory on the user's machine. Extensions that want to read/write user files (`AGENTS.md` via `memory-mode`, `.pi/todos/` via `todos`, `.pi/archive` via `session-snap`) get a ZenFS interface with no filesystem-walking — clean boundaries, no process spawning.

Lean into these. The plan should produce extensions that would be *awkward* in the TUI world but *natural* here.

---

## 6. Method — the phases of your work

Execute in this order. Do not skip. Mark your own progress via `TodoWrite`.

### Phase A — Intent framing (≤1 day of work for the agent, before any extension analysis)

Answer, with evidence from §2 and §3:

1. Who authors extensions in our product? (first-party / power-user / third-party, or a mix)
2. Is DOM-rendering an extension genre we want in v1?
3. What trust model applies to each author class?
4. What distribution path fits our browser runtime? (bundled-at-build / uploaded / URL-fetched / paste / MCP-served)
5. Is the extension primarily *code* or can it be *declarative* (JSON + fixed transforms)?
6. What is the smallest event surface that makes ≥5 of the corpus extensions work? ≥10? ≥20?

Write this as a short section at the top of the deliverable. **Every subsequent decision must be traceable to one of these answers.** If you find yourself making a choice that isn't, add the question to this section and answer it.

### Phase B — Extension inventory (thorough)

Produce a table with **every** extension you read in §3, one row each. Columns:

| Column | What it records |
|---|---|
| `source_repo` | Where it lives |
| `name` | Extension name (e.g. `btw`) |
| `summary` | One line |
| `genre` | Prompt mutation / tool registration / tool-call gate / tool-result mutation / slash command / UI widget / session-lifecycle / model-selection / storage-backed / multi-session RPC / skill |
| `coding_agent_apis_used` | Which `ExtensionAPI` / `UI` / `exec` surfaces it touches |
| `browser_viable` | `yes` / `partial` / `no` — can the intent be delivered in our runtime? |
| `rewrite_required` | What would have to change (e.g. "TUI widget → React form", "shell exec → vault write", "ghostty split → new browser tab or React pane") |
| `why_interesting` | Why a user would enable it in web-agent (or "not interesting, reject") |
| `complexity` | `trivial` / `small` / `medium` / `large` / `defer` / `reject`, with rubric defined in your output |
| `unlocks_capability` | What API surface on our side must exist first |
| `phase_target` | Which phase of the plan first makes this possible (Phase 1 / Phase 2 / ... / deferred / rejected) |

Expect ~60–100 rows across the six repos. Do not cherry-pick; go through all of them. Sort the final table by `complexity` ascending, grouped by `genre`.

### Phase C — Skills inventory (parallel track)

Same table shape but over `badlogic/pi-skills` (and the skill folders in `mitsuhiko/agent-stuff`, `tomsej/pi-ext`, etc.). Skills are *usually* easier than extensions (they are markdown + helper scripts), but many helper scripts are shell/node specific — mark accordingly. Identify the 5 skills that are most valuable for web-agent users (think: web dev, docs search, structured note-taking) and sketch the integration shape.

### Phase D — API-surface derivation

From Phase B + C, derive the minimal API surface. For each API element you propose, cite ≥2 specific extensions that need it. If you can't find 2, either drop the element or flag it as "speculative — add when a third extension requires it".

Cover at minimum:

- Event hooks (which events, what signature, what mutation semantics).
- Tool registration (schema format, result shape, blocking vs chain).
- Slash-command registration (name collision policy, argument parsing responsibility).
- UI contribution (React-component-shaped? render-data-shaped? structured-dialog-shaped? iframe-sandboxed? mcp-ui-style envelope?).
- Elicitation (extension asks the user something) — lean on MCP's elicitation pattern as a prior.
- Storage access (vault / extension-scoped IDB / ephemeral).
- Model access (read-only, read-write, restricted?).
- Session introspection (read transcript, read entries, read metadata — at what granularity?).
- Permission declaration + enforcement model.
- Error + notification surface (how does an extension tell the user something went wrong or happened?).

For each: show the **smallest** shape that covers the named extensions. Resist generalising beyond them.

### Phase E — Phase-wise implementation roadmap

Each phase is named by the user-observable capability it unlocks, and ends with a working named extension from the corpus. Phases are additive — nothing from a later phase is silently consumed by an earlier one.

A reasonable shape, not mandatory:

- **Phase 1 — trivial prompt mutations.** Lands: 1 harness extension like `whimsical` (thinking-message substitute). Only `before_agent_start` or `system_prompt_prefix` event. No user code execution at all if a declarative path suffices.
- **Phase 2 — tool-result transforms.** Lands: 1 extension like `shout-results` / `path-guard` over tool outputs. Only `tool_result` event. Still declarative if possible.
- **Phase 3 — new tools (pure-function).** Lands: 1 extension like `magic-word` or `notify` (notifications → `toast()` API). `registerTool` surface defined.
- **Phase 4 — vault-backed tools.** Lands: 1 extension like `todos` (vault read/write), or `memory-mode` (`AGENTS.md` updates). Introduces vault permission model.
- **Phase 5 — structured elicitation.** Lands: `ask_user` and `oracle`-style prompts. Introduces elicitation API mirroring MCP's.
- **Phase 6 — slash commands + overlays.** Lands: `/btw` (side-chat without history), `/handoff`, `/sessions`. Introduces slash-command registry + session-introspection API.
- **Phase 7 — skills integration.** Lands: first 3 skills from `badlogic/pi-skills` usable in web-agent. Introduces `SKILL.md` loader, `{baseDir}` substitution analog, and skill picker UI.
- **Phase 8 — UI contribution (if needed).** Lands: an extension that renders a custom widget (`status-widget`, `usage-bar`, `session-breakdown`, `codemap`). Requires deciding iframe / mcp-ui / React contribution shape. This is the first phase that may reasonably be **deferred** if phases 1–7 deliver the K1–K4 goals.
- **Phase 9 — code-executing extensions (if needed).** Lands: a user-authored extension loaded at runtime. Requires the sandbox decision from Phase A. May be **deferred** to a separate milestone.

Each phase definition must include:

- **Lands** — one named corpus extension (or skill) fully working in web-agent, with e2e.
- **API added** — the delta to `ExtensionAPI` / RPC / manifest.
- **What gates** — the gate check that makes this phase done.
- **Risk** — one paragraph on what's uncertain and how you'd discover it quickly.
- **Defer condition** — the specific observation that would make you skip this phase.

### Phase F — Extension specification (publishing contract)

For the API surface defined in Phase D, specify the shape a third-party author would publish against. This is not a feature we ship in v1; it is a **design constraint** that prevents v1 from painting us into a corner for publishing later. Capture at minimum:

- Manifest schema (JSON Schema or TypeBox).
- Packaging format (single ESM file? folder with `manifest.json` + `index.js` + `SKILL.md`? npm package with a `pi-web-agent` field?).
- Permission declaration grammar.
- Compatibility / versioning (`engines` field? semver of the extension API?).
- A worked example: take one corpus extension and write what its `manifest.json` + entry file would look like in our format.

### Phase G — Anti-patterns, traps, open questions

Reserve the last section for:

- Things you saw in the corpus you are deliberately *not* porting, with a one-line reason.
- Open questions that block implementation (to be answered with the user before code starts).
- Spike-1 decisions you re-affirm, and spike-1 decisions you overturn (each with a fresh D-entry draft).

---

## 7. Deliverables — exact files to produce

Place all new files in `ai-docs/extension-spike-2/` (create the folder). File structure:

```
ai-docs/extension-spike-2/
├── README.md                    # Navigation: what's here, reading order, status
├── 00-intent-framing.md         # Phase A output
├── 01-research-notes.md         # Phase B + C raw notes per repo
├── 02-extension-inventory.md    # Full Phase B table
├── 03-skills-inventory.md       # Phase C table
├── 04-api-surface.md            # Phase D — minimal API derivation
├── 05-protocol-notes.md         # MCP elicitation, mcp-ui, Chrome MV3, VSCode host — condensed
├── 06-roadmap.md                # Phase E — phase-by-phase plan
├── 07-extension-spec.md         # Phase F — third-party publishing contract
├── 08-rejected-and-deferred.md  # Every extension you said no to, with reasons
└── 09-open-questions.md         # Decision gates before implementation starts
```

Every file starts with a one-paragraph abstract and a "How this was produced" note identifying which corpus inputs it consumed.

**Do not produce a companion implementation plan file under `ai-docs/plans/` in this pass.** The implementation plan comes only after the user reviews the above and answers the open questions in `09-open-questions.md`.

**Do not edit** `ai-docs/milestones/m8-extensions.md`, `ai-docs/decisions/m8-extensions.md`, or the `ai-docs/extension-spike/` archive. Those are sealed. If you want to overturn a spike-1 decision, do it by drafting the superseding entry inside `09-open-questions.md`, and let the user merge it later.

---

## 8. Research protocol (don't skip these moves)

- **Read sources you cite.** If you mention an extension, you must have read its source — not just its README. Link to the file path in the repo or to the tarball/unpkg URL.
- **Pull directly from the registry.** Do not hand-list extensions from memory or from spike 1. Use the npm search API (`https://registry.npmjs.org/-/v1/search?text=keywords:pi-package&size=250&from=<N>`) to enumerate, and `https://registry.npmjs.org/<name>/latest` to read a specific package's manifest. For source: `npm view <name> dist.tarball` → download → inspect; or browse on [unpkg.com/<name>](https://unpkg.com/) / [jsdelivr.net](https://www.jsdelivr.com/package/npm/) without cloning.
- **Use the browser tool for pi.dev.** The pi.dev/packages page renders cards with READMEs inline when you click — this is often faster than downloading the tarball. Use `browser_navigate` + `browser_snapshot` (or `browser_take_screenshot`) to scan listings and READMEs. Note that pi.dev itself hydrates from the same npm search API, so the data you see there is available to fetch directly.
- **Quote, don't paraphrase, for API shapes.** When saying "extension `files` uses `api.ui.custom(...)` to render its browser", paste the actual call. Hand-summarising API usage is how misreadings become plans.
- **Cluster by author.** When an author publishes a coherent set (`@the-forge-flow/*`, `@juicesharp/rpiv-*`, `@feniix/pi-*`, `@0xkobold/pi-*`, `@aliou/pi-*`, `@axnic/pi-extension-*`, `mitsupi*`), read one representative member in depth and skim the rest — patterns repeat.
- **Search for extensions we don't know about.** Before closing Phase B, do at least 3 supplementary searches: the registry for packages with fewer than 50 weekly downloads but recent publish dates (novel experiments), web searches for "pi extension" / "pi coding agent" / "pi skill" in the last 30 days, and the pi Discord archives if available. The registry grew 3–4× between spike 1 and spike 2; assume it will keep moving.
- **Dedup aggressively.** Several extensions have near-identical goals (`pi-btw` vs `@juicesharp/rpiv-btw`, `pi-ask-user` vs `@juicesharp/rpiv-ask-user-question` vs `tomsej/pi-ext` ask-user). Pick one canonical form to design against, list the others as duplicates in `02-extension-inventory.md`.
- **Test your understanding of our runtime.** If you claim "nested Workers are flaky in Vite dev", prove it by pointing to a Vite GitHub issue. If you claim "blob URL dynamic import works in Worker", cite the spec or a browser compatibility table.
- **Investigate MCP elicitation directly.** The MCP spec has a specific shape for it; don't reinvent from first principles if the shape already exists. Cross-check against `pi-mcp-adapter` — the registry's #1 package — to see how the ecosystem has already reconciled MCP with pi.
- **Investigate mcp-ui directly.** It is evolving; read current state, not spike-1's second-hand notes.

---

## 9. What "good" looks like

After your pass, a reviewer should be able to:

1. Open `02-extension-inventory.md` and see a sortable table they can scan in 5 minutes.
2. Ask "why didn't you include `oracle`?" and find a specific row with a specific verdict and rationale.
3. Ask "what does Phase 3 actually deliver?" and find one specific corpus extension that will work end-to-end after it.
4. Open `04-api-surface.md` and find each event, tool-registration call, and permission mapped to ≥2 corpus extensions that justify it.
5. Open `07-extension-spec.md` and see a worked example manifest — so they can feel how a third-party author would ship.
6. Open `09-open-questions.md` and know exactly which decisions they need to make before implementation starts.

---

## 10. What "bad" looks like (refuse these temptations)

- Copy-pasting spike 1's architecture diagram with minor label changes.
- Proposing a per-extension Worker because spike 1 did, without finding ≥2 corpus extensions that *need* that isolation.
- Copying `packages/coding-agent`'s 22-event union wholesale.
- Writing phases named "Phase N: add event X" instead of "Phase N: `<extension-name>` works".
- Proposing Dexie, ZenFS-for-extensions, Blob URL loaders, or nested Workers before Phase D has evidence-based API derivation done.
- Punting hard design questions into "the implementation plan will decide" — the implementation plan doesn't exist yet, and this document is what produces it.
- Listing a corpus extension as "supported" without specifying what changes in web-agent to make it actually work.
- Silently enabling features outside principle 8 (scope creep).

---

## 11. Starting moves

1. Invoke `TodoWrite` with one todo per phase A–G plus "create deliverable folder" and "run bias audit". Mark A in_progress.
2. Read the `ai-docs/` anchors in §2 in order.
3. Read the current integration surface on `main`: `packages/web-agent/src/web-agent/core/extensions/**` and `src/web-agent-extensions/**` *do not exist on main* — that was intentional. Use `git show spike-extension:<path>` (or add a worktree for `spike-extension`) to read spike-1's files without polluting `main`.
4. **Enumerate the registry before reading any curated repo.** Run the search API for all 1446 pi packages, filter to extensions + skills, and save the raw JSON into your scratch notes. Without this, your inventory is a remix of spike 1's summary, which is not allowed.
5. Pick 10 representative packages from the top-50 table in §3.1 spanning genres (prompt mutation, tool registration, elicitation, UI, skills, MCP adapter). Download each via `unpkg.com` or `npm pack`, read the `package.json` → `pi.extensions[]` / `pi.skills[]` manifest field, then read the source. Take notes.
6. Then fetch READMEs + one representative extension source from each of the curated repos in §3.2. Take notes.
7. Only then write Phase A's output file. Do not start Phase B until Phase A is complete.

When Phase A is done, stop and present it to the user for sign-off **before** Phase B — Phase A's answers determine the inventory scope. This is the one mandatory checkpoint in the spike; the rest you drive to completion without asking.

---

## 12. Out of scope for this spike

- Writing any TypeScript under `packages/web-agent/src/**`. This spike is analysis-only, same rule as spike 1.
- Touching `packages/coding-agent`. Observe only.
- Deleting spike-1 code. Leave `src/web-agent/core/extensions/**` and `src/web-agent-extensions/**` alone; the eventual implementation plan can decide what to delete.
- Starting the actual extension framework. The answer to "when do we start coding?" is "after the user reviews this spike's deliverables and answers `09-open-questions.md`".

---

**Gate.** You have produced a good spike 2 if you can hand this folder to the user, they can read it in under an hour, and at the end they know (a) which 5 extensions to implement first, (b) the minimal API surface that makes those 5 work, (c) the minimal API surface that does not paint us into a corner for the next 5, and (d) exactly what publishing-contract shape we'll ship when v2 needs it.
