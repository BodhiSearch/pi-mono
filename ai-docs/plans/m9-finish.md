# M9 finish — plan

Scope: close the two remaining items on [`../milestones/m9-resources.md`](../milestones/m9-resources.md) so M9 can flip from 🟡 partial to ✅ done. Everything else on M9 has shipped (vault-sourced commands / prompts / skills, extension-registered commands via M8 Phase 1, extension-registered skills via M8 Phase 2b).

**Remaining items:**
1. Multi-tier discovery (user tier).
2. Themes (optional; see *Decision points* below).

---

## 1 — Multi-tier discovery

### What coding-agent does
`packages/coding-agent/src/core/resource-loader.ts` walks three tiers in order, later tiers *override* earlier ones by id:
- Builtin (compiled into the binary).
- `~/.pi/agent/` (user home).
- One or more CLI-flagged directories.

Each tier can contribute commands, prompt templates, and skills.

### Why web-agent doesn't have it yet
- No filesystem home on the web. The vault (`/vault`) is the only user-accessible FS today, and it is intentionally single-scoped.
- No CLI to pass flags.
- ZenFS gives us per-origin IndexedDB mounts, which is the obvious analogue for a persistent "user tier" that is *not* the vault.

### Target shape

Three tiers, resolved in this order (later overrides earlier):
1. **builtin** — compiled in (same as today: `BUILTIN_SLASH_COMMANDS`).
2. **user** — per-origin IndexedDB mount at `/user-resources`, holding `.pi/prompts/**.md`, `.pi/skills/**/SKILL.md`, `.pi/extensions/**/index.js`.
3. **vault** — whatever is mounted at `/vault` (existing behaviour).

Extensions keep their precedence rules within each tier. Name-collision across tiers uses the "last tier wins" rule (vault overrides user overrides builtin), consistent with coding-agent.

### Implementation plan

**Worker-side:**
- Add `packages/web-agent/src/worker-agent/fs/user-resources-provider.ts` — a ZenFS IndexedDB provider mounted at `/user-resources`, initialised on worker startup behind `WebAgentOptions.userResourcesMount = true` (default off initially; flip on when the UI ships).
- Extract the existing vault resource loader in `core/commands/` behind a `ResourceRoot` abstraction that takes `{ tier: 'user' | 'vault', rootPath }` and wire it to walk both `/user-resources/.pi` and `/vault/.pi`.
- Adjust `CommandRegistry` precedence: when two non-builtin registrations share an id, the one registered *later* wins iff its tier is higher. Today it is "first-registered wins" globally; tighten to "first-registered wins within a tier, later tier overrides earlier".
- Extend `session_loaded` / `reload` to re-scan both tiers.
- Extend the extension loader to include `/user-resources/.pi/extensions/` alongside `/vault/.pi/extensions/`.

**Main-thread UI:**
- New `UserResourcesPanel` (sibling to `ExtensionsPanel`) with:
  - File picker to import a `.pi/prompts/*.md` / `.pi/skills/<name>/` / `.pi/extensions/<name>/` bundle.
  - List view showing what is currently in the user tier + a "Remove" affordance.
- No file-browsing UI beyond import/remove; power users can open DevTools → Application → IndexedDB if they want raw access.

**Tests:**
- `core/commands/registry.test.ts` — add cases for the cross-tier override rule.
- New `e2e/user-resources.spec.ts`:
  - Import a prompt, observe it in `/<name>` palette + dispatch.
  - Import a skill, observe it in `/skill:<name>` palette.
  - Import an extension, observe it in `ExtensionsPanel`.
  - Add a vault-tier resource with the same id as a user-tier one; assert vault wins.
  - Remove a user-tier resource; assert it disappears from the palette after `/reload`.

**Docs:**
- Update `ai-docs/specs/worker-agent/resources.md` (or create it — no single canonical spec today; pieces live in `skills.md`, `slash-commands` references, etc.) with the three-tier model.
- Update `m9-resources.md` to flip multi-tier from pending to done when the gate closes.

---

## 2 — Themes

### Decision points (ask user)

Before spending effort here, confirm:
- Do we want this at all for v1, or is it post-v1?
- What is the minimum viable theme? A dark/light toggle (already ships via Tailwind + shadcn) is not what "themes" means in the coding-agent sense. coding-agent themes are CSS-var bundles that any extension can register.

If we do want it:
- **Surface:** `pi.registerTheme({ id, displayName, tokens: Record<string, string> })`.
- **Host:** `ThemeRegistry` in the worker, main-thread `useExtensionThemes` hook + a theme-switcher combobox in the topbar.
- **Tokens:** start with the shadcn CSS variable names (`--background`, `--foreground`, `--primary`, …). Extensions supply a partial map; missing tokens fall through to the active base theme.
- **Persistence:** selected theme id in `localStorage`; survives reloads.

**Tests:**
- vitest on `ThemeRegistry` (registration, churn, missing-token fallback).
- `e2e/themes.spec.ts` asserting the CSS variable actually changes on the `<html>` element after switch + round-trips across reload.

If user defers themes, M9 closes on the multi-tier item alone and themes move to [`deferred.md`](../milestones/deferred.md).

---

## Sequencing

Suggested order when picked up:

1. Decide themes in/out (5 min — just the question).
2. Land the `ResourceRoot` abstraction + extend to both tiers without exposing the UI yet. Gate on new registry tests.
3. Add the ZenFS user-resources provider behind an option flag. Gate on an e2e that seeds `/user-resources` directly (no UI).
4. Add `UserResourcesPanel` and flip the option flag on by default.
5. (Optional) Themes.
6. Flip M9 to ✅ done in [`../milestones/index.md`](../milestones/index.md).

---

## Gate

- Full monorepo `npm run check` green.
- `packages/web-agent` vitest suite green.
- `packages/web-agent` e2e twice back-to-back green (matches the standing M-gate pattern; allow for the pre-existing `compaction.spec.ts` flake tracked in [`../extension-impl/phase-2b-report.md`](../extension-impl/phase-2b-report.md) gap #9).
- No new `any`, no new `@ts-ignore`, no new skipped tests.
- README / spec updates landed in the same commit range.

---

## Out of scope

- Filesystem access beyond IndexedDB (no OPFS migration, no File System Access API for the user tier — keeps the origin-scoped assumption).
- A full resource marketplace / discovery UI.
- Syncing the user tier across devices.
- Changing vault semantics.
