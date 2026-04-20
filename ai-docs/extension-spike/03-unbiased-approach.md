# 03 — Unbiased From-Scratch Approach

**Purpose.** If we were designing the extension system today, with no prior code on the branch, no `coding-agent` precedent to honour, and no decisions already made, what would we build? This report answers that without defending or referencing the spike. Read it as a standalone proposal.

---

## 1. Start with the intent, not the mechanism

The single biggest lever is *who authors extensions*. Every other design decision collapses once this is fixed.

The web-agent's positioning is "local-first, runs-in-your-browser, you own the data". The user is technical enough to read code but is not a platform author. The agent is a single-user tool. Our realistic intents, in priority order:

1. **Us adding optional behaviour we can't justify as a core feature.** Example: "uppercase every tool result" — cute, low-priority, should not ship to every user.
2. **Us shipping a *library* of optional behaviours users toggle.** Example: "compaction prompt overrides", "path-guard for vault writes", "add `fetch_url` tool".
3. **Power users pasting a snippet they found on the internet.** Example: "here's a script that adds a Mermaid-rendered weekly report".

Intent 4 (third-party marketplace) is explicitly out of scope for the foreseeable future. The user is local-first; there is no web of trust to piggy-back on.

The right mechanism for (1) + (2) is **completely different** from the right mechanism for (3). A good design serves (1) + (2) natively and treats (3) as a power-user escape hatch behind a "danger" flag.

---

## 2. Recommended v1: built-in registry + declarative extras

**Shape.**

- Extensions live in `packages/web-agent/src/extensions/<id>/index.ts`, committed to the repo.
- Each exports a module with a default `ExtensionDefinition`: `{ manifest, handlers, tools? }`.
- A build-time `import.meta.glob('../extensions/*/index.ts', { eager: true })` produces a registry.
- The app ships with the registry baked in. Toggling an extension is "write `enabled[id] = true` to IndexedDB". No loader, no blob URL, no nested Worker, no RPC, no permissions plumbing.
- Extensions run **in the agent Worker**, sharing its lifetime. A faulty extension crashes the Worker; the worker reboots; state rehydrates from IndexedDB. The existing session-persistence already handles this.
- UI is a checklist in settings. Flipping a checkbox takes effect immediately for the next turn (existing "defer until `agent_end`" pattern handles mid-stream toggles with one `Map`).

**Why this.**

- Hits every current M8 genre (`before_agent_start`, `tool_result`, `registerTool`) without introducing a single new moving part beyond "a settings flag and a switch statement".
- About 1–2 days of work, 500–800 LOC total, no new security surface. No Worker spawning, no CSP tension, no Vite dev-server edge cases.
- Upgrade path to (3) is deferred, not closed: the same `ExtensionDefinition` shape can later be loaded from a string via `new Function` (for pure data transforms) or a nested Worker (for code sandboxes). Nothing here commits us.

**What we trade away.** No runtime install of code we didn't ship. For intents (1) and (2) this is a feature, not a cost: the "marketplace" is our PR queue, so the "reviewed and merged" bit is free.

---

## 3. Recommended v2 (deferred): declarative extras for non-code genres

Many extension genres don't need an executor at all. They're data.

**Declarative slots:**

- **Prompt overrides.** `{ kind: 'prompt_prefix', text: '[EXT:ECHO] ' }` → wrapped around the system prompt when the extension is enabled. Zero code execution.
- **Tool aliases.** `{ kind: 'tool_alias', from: 'read_file', to: 'cat' }` → adds a second name for a tool.
- **Path guards.** `{ kind: 'path_guard', writeBlocks: ['/vault/*.secret'] }` → evaluated inside the tool dispatcher; no extension code runs.
- **Simple mutations.** `{ kind: 'tool_result_transform', tool: 'read_file', transform: 'uppercase' }` → a fixed whitelist of pure transforms (`uppercase`, `lowercase`, `strip_ansi`, `head:N`, `grep:<regex>`).
- **Template tools.** `{ kind: 'template_tool', name: 'magic_word', output: 'MAGIC_RABBIT_42' }` → registers a tool whose execute is a constant.

This covers half of what "extensions" usually means in practice with **zero sandboxing, zero permission model, zero loader**. Extensions become JSON; the harness knows what each `kind` means.

Author UX improves too: the settings UI renders a form for each `kind`, the user fills it in, the extension "exists". No IDE, no blob URL, no module loader.

Estimated cost: 3–4 days on top of v1, depending on how many `kind`s we ship. The registry of `kind`s is append-only, so it ages well.

---

## 4. Recommended v3 (deferred, if and when we need it): code escape hatch

Only if power users are actually asking, *and* intent (3) becomes a priority, do we add a code path.

**Shape for v3.**

- `ExtensionDefinition.code?: string` — ESM source text. User-pasted or uploaded.
- Runs in **one shared "user extension" Worker** (not per-extension — one Worker total). Cheaper than per-extension and still off the agent Worker.
- Loaded via blob URL + dynamic import, guarded by a permission manifest.
- **Explicit "I understand" dialog on first install**, modelled on Chrome's extension install prompt. Lists declared permissions and bundle size.
- Disabled by default under a `experimental.unsafeUserCode` flag in settings. Users opt in knowingly.

Estimated cost: ~1 week on top of v1 + v2. We'd do this only after observing real demand — not in anticipation of it.

---

## 5. Event surface — start minimal, grow deliberately

The `coding-agent` event union has 22 types because `coding-agent` is a full TUI. We don't need most of them. Start with exactly:

| Event | Use case |
|---|---|
| `before_agent_start` | System-prompt mutation, one-time injection |
| `tool_result` | Mutate tool output |
| (implicit `registerTool` at load time) | Add tools |

Everything else is deferred until a specific extension asks for it. Resist "coding-agent has this event, so we need it". Each event has ongoing maintenance cost (type, dispatch, test, document). The burden of proof is on adding, not on omitting.

Explicitly **out** of v1:

- `tool_call` (pre-execution mutation / block) — looks useful, but makes the agent loop non-deterministic in ways debuggers struggle with. Revisit when a concrete need shows up.
- `registerProvider` — a large surface. Model plumbing changes shape every milestone. Adding extension access to it freezes internal APIs we don't want to freeze yet.
- `registerMessageRenderer` — needs iframe sandboxing to be safe. Much bigger project.
- `session_before_compact` — deferred from M7; no extension currently needs it.

---

## 6. Storage

If v1 is all we do, storage is trivial: `{ enabledExtensions: Record<string, boolean> }` in IndexedDB via existing Dexie. One table, one row.

If v2/v3 land, the shape extends to include per-extension declarative config and (for v3 only) bundle bytes. Still one Dexie table; no file-system abstraction.

ZenFS for extensions is over-engineered at every tier. Ruled out (not re-opened).

---

## 7. Lifecycle / UX

- Enable / disable takes effect at the next `agent_end`. Exactly the compaction-deferral pattern. If the user toggles mid-stream, show "will apply after this message" in the UI.
- Settings UI is a single scrollable list. Each row: name, one-line description, link to source (for v1 built-ins), a toggle. No popover, no badge count, no drawer. The popover in the spike is a nice touch but duplicates settings.
- On first toggle of an experimental extension (v3), a confirmation dialog with the permission list. Once dismissed, never again for that extension.
- No "install" / "uninstall" distinction for v1 extensions — they're always present, just toggled. Install/uninstall language returns only when v3 lands.

---

## 8. Testing strategy

- **vitest for every extension handler.** Built-in extensions are plain modules; unit tests are 10 lines each. No Worker mocking needed.
- **One e2e spec per extension genre.** Covers "toggle on → observe effect → toggle off → observe absence of effect". Uses the same `data-testid` discipline as the rest of the app.
- **No e2e for loader internals.** The loader for v1 *is* `import.meta.glob`; nothing to test beyond "the built-ins list is not empty at boot". That's a vitest, not an e2e.

---

## 9. Naming the thing

"Extension" is the wrong word for v1. We are not extending the *platform*; we are toggling *optional behaviours*. Candidate replacements:

- **Behaviours.** "Enable the uppercase-results behaviour." Matches how the toggles feel.
- **Add-ons.** Familiar; slightly corporate.
- **Tweaks.** Matches the spirit (small, optional, playful).
- **Packs.** Nice when we later bundle a few together.

"Extension" is reserved for v3 (user-authored code). Labelling v1 as extensions pre-commits us to the heavier mental model.

---

## 10. Migration path from the spike

If we decide the unbiased approach is what we want, migration from the spike branch is straightforward:

1. **Keep** `src/web-agent-extensions/*` sample bundles. They're already `ExtensionDefinition`-shaped; dropping the `bundleText` string and going back to a real TypeScript module is a find/replace.
2. **Drop** `core/extensions/host/**`, `core/extensions/supervisor.ts`, the per-extension Worker, the `spawnExtensionHostWorker` factory, and the entire `extension_*` RPC command + event union.
3. **Replace** `ExtensionStore` with one IndexedDB row keyed by extension id, storing only `{enabled}`.
4. **Keep** the `pendingExtensionChanges` pattern; it's the same no matter where the extension runs.
5. **Keep** `ExtensionsPopover` as a v1 settings surface, trim to a flat list of built-ins with a toggle.

Net LOC removed ≈ 1 600. Net LOC added ≈ 400 (registry + toggle). Net complexity removed is bigger than the delta suggests because the Worker / RPC / blob-URL plumbing carries a lot of conceptual weight.

---

## 11. Why this is the right starting point

- It serves the actual intents the web-agent has today.
- It's cheap and revisitable. We can always add more later; we can't easily undo a Worker + RPC + permission-model commitment.
- It doesn't freeze internal APIs for a hypothetical extension author.
- It doesn't ship a permissive code executor to users.
- It's boring. Boring is good for infrastructure that sits under every other feature.

Anything more ambitious should have to defeat this baseline on specific, named user needs — not on abstract extensibility arguments.
