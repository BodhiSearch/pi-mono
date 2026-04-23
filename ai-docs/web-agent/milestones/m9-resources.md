# M9 — Resources (commands, prompts, skills, themes)

**Status:** 🟡 partial. Vault-sourced slash commands, prompt templates, and skills are **done** (landed ahead of the extension runtime, vault-only by design). Extension-registered commands + skills landed with M8 Phase 1 / Phase 2b respectively — `SlashCommandInfo.source` now uses the `'extension'` and `'extension-skill'` tags in production. **Still pending:** themes, and multi-tier (user + CLI) discovery.

Test seam: vitest + Playwright e2e.

---

## Landed (vault-sourced subset)

- **Builtin slash commands.** `BUILTIN_SLASH_COMMANDS` table + `useAgent.intercept()` dispatcher handles `/help`, `/clear`, `/fork`, `/reload`, `/vault`, `/session`.
- **Prompt templates** loaded from `<vaultMount>/.pi/prompts/*.md`. Frontmatter (`description`, `argument-hint`), `$1`/`$ARGUMENTS` substitution, and collision diagnostics match coding-agent byte-for-byte. Invoked as `/<name> ...args`.
- **Skills** loaded from `<vaultMount>/.pi/skills/<name>/SKILL.md`. Validation (name regex, length caps, consecutive-hyphen rule), `disable-model-invocation` flag, and the `<skill name=… location=…>` expansion wrapper match coding-agent. Invoked as `/skill:<name> ...args`.
- **Sandboxed `bash` shim** for skill scripts — iframe (`sandbox="allow-scripts"`, null origin) + per-run Web Worker, parser only accepts `node <path>.js` / `./<path>.js` under `<vault>/.pi/skills/`. Capabilities: `console`, `fetch` (with credential-header stripping), `vault.readFile/writeFile/ls` scoped to `/vault/`, `process.argv/env/cwd`, `stdin`. Covered by `packages/web-agent/e2e/skills.spec.ts` + `sandbox/bash-skill.test.ts`. See [`ai-docs/specs/worker-agent/skills.md`](../specs/worker-agent/skills.md).
- **Command registry** (`worker-agent/core/commands/registry.ts`) with `list_commands` RPC returning `SlashCommandInfo[] { source: 'builtin' | 'prompt' | 'skill' }`.
- **System prompt ownership moved to the worker** — `core/system-prompt.ts` builds the prompt on every vault mount/unmount/reload so loaded skills appear in the model's context. `useAgent` no longer sets a blank system prompt on the main thread.
- **Autocomplete palette** — `CommandPalette.tsx` + `useSlashCommands` hook (with unit + e2e tests via `CommandPalettePage`).
- **`/reload`** re-runs prompt + skill discovery and emits a transient with the new counts.

Relevant source:
- `packages/web-agent/src/worker-agent/core/commands/{registry,skills,prompt-templates,slash-commands,frontmatter,types}.ts`
- `packages/web-agent/src/worker-agent/core/system-prompt.ts`
- `packages/web-agent/src/sandbox/{SandboxHost,bash-skill,capabilities,bootstrap,types}.ts`
- `packages/web-agent/src/hooks/{useSlashCommands,useSkillSandbox}.ts`
- `packages/web-agent/src/components/chat/CommandPalette.tsx`

Spec: [`ai-docs/specs/worker-agent/skills.md`](../specs/worker-agent/skills.md) (skills + sandbox + bash shim), plus references in `worker-host.md`, `agent-session.md`, `vault-tools.md`. Cross-harness mapping now in [`ai-docs/specs/coding-vs-web-agent/alignment.md § Slash commands, prompt templates, skills`](../specs/coding-vs-web-agent/alignment.md) and [`divergence.md § Skill execution`](../specs/coding-vs-web-agent/divergence.md).

---

## Still pending (blocks "done")

- ~~**Extension-registered commands.**~~ ✅ landed with M8 Phase 1 — `pi.registerCommand` + `CommandRegistry` `extension` source. Exercised end-to-end by the `fancy-prompt` fixture in `e2e/extensions.spec.ts`.
- ~~**Extension-registered skills.**~~ ✅ landed with M8 Phase 2b — `pi.registerSkill` + `ExtensionSkillController` + `extension-skill` source, with an inline-script resolver hook on `bash-skill.ts`. Exercised by the `skill-nudge` fixture in `e2e/extensions-ui-2b.spec.ts`.
- **Themes.** No theme registration yet; UI ships with built-ins. Deferred until a concrete user need appears. Candidate surface: `pi.registerTheme({ id, tokens })` + a CSS-vars bridge on the main thread. Not planned for this pass.
- **Multi-tier discovery.** coding-agent walks `~/.pi/agent/` and CLI-flagged paths; web-agent is vault-only. In-browser there is no `~` — the equivalent would be a per-origin IndexedDB-backed "user resources" tier layered below the vault tier (resolution order: builtin → user-IDB → vault). Needs a UX for users to import resources into that tier. Plan pending — see [`../plans/m9-finish.md`](../plans/m9-finish.md).
- **Prompt images / multimodal input.** Orthogonal to M9 but often requested alongside prompts — tracked separately under `feature-gaps.md`.

---

## Coding-agent references

`packages/coding-agent/src/core/{slash-commands,resource-loader,prompt-templates,skills,skill,system-prompt}.ts`.

---

## Gate (to close M9 fully)

- **[done]** vitest covering builtin `/help` dispatch, prompt-template frontmatter + argument substitution, skill loading + `/skill:<name>` expansion, sandboxed script execution, `list_commands` enumeration.
- **[done]** e2e (`packages/web-agent/e2e/slash-commands.spec.ts`, `skills.spec.ts`) covering palette, prompt-template substitution into the user message, skill run via sandboxed `bash`, vault-write round-trip, `/reload` transient.
- **[done]** extension-registered `/fancy-prompt` round-trips through `list_commands` and dispatch (`e2e/extensions.spec.ts`).
- **[done]** extension-registered `/skill:nudge` round-trips via `ExtensionSkillController` (`e2e/extensions-ui-2b.spec.ts`).
- **[pending]** theme registration + switch (scope TBD; optional — deferred until a concrete user need appears).
- **[pending]** multi-tier discovery (user tier via per-origin IndexedDB) — plan file to be authored under `ai-docs/plans/m9-finish.md`.
