# M8 — Extensions + skills

**Status:** planned. Test seam: +1 Playwright spec, extension lifecycle vitest.

**Biggest milestone.** Intentionally grouped: extension hooks are the surface other milestones depend on (compaction hooks, custom tools, custom providers), so building them late means plumbing we didn't yet have when those landed.

**Scope preview.**
- `/extensions` ZenFS mount (IndexedDB backend).
- Extension manifest schema (TypeBox-based, matching how `pi-agent-core` tools already declare schemas).
- Loader: download manifest + bundle, persist to `/extensions/<name>/`, instantiate in a dedicated Web Worker, wire RPC-backed capability channel.
- Port the full extension event surface from `packages/coding-agent/src/core/extensions/types.ts`, trimmed to browser-safe pieces (drop terminal-UI concerns, drop `UserBashEvent`).
- Extension API: `on(event)`, `registerTool`, `registerCommand`, `registerProvider`, `sendMessage`, `sendUserMessage`.
- Manifest permissions: `fs:self`, `fs:vault` (requires user approval), `net:<origin>` allow-list.
- Skills-as-extensions: one reference skill shipped as an extension, validates surface expressiveness (matches goal K1–K4 in `../01-goals.md`).

**Coding-agent references.** `packages/coding-agent/src/core/extensions/{types,runner,loader,wrapper}.ts` — copy types, wrapper runtime; *replace* the jiti-based loader with browser ES-module dynamic import inside a Worker.

**Adaptations.** No jiti, no filesystem-as-module-resolver. Extensions ship pre-compiled ESM. Each extension in its own Worker (isolation + termination). Host intermediates all capabilities — extensions have no direct DOM, fetch, or global access.

**Gate.** Playwright: install an `uppercase-echo` extension, prompt the agent, confirm the extension's `after_tool_call` hook fires and mutates the tool output. vitest covering extension lifecycle (install / load / reload / uninstall / permission denial).
