# M0 — Workspace integration + Vite-warning fix

**Status:** ✅ done (`06d02b81`).

What landed:

- `packages/web-agent` aligned with monorepo (typescript `^5.9.2`, `@types/node ^22.10.5`, `@mariozechner/{pi-ai,pi-agent-core}` as `"*"` for workspace symlinks).
- Vite no longer emits warnings about `packages/ai`'s node-only lazy imports — `/* @vite-ignore */` hints added in the `pi-ai` source.
- Biome scoped out of `packages/web-agent`; root `tsgo --noEmit` skips it; root `build` and `check` invoke web-agent's own tooling.
- `ai-docs/` directory established at repo root with `decisions.md` (now split into `ai-docs/decisions/`) capturing D1–D4 in [`decisions/m0-workspace.md`](../decisions/m0-workspace.md).
- Package `typecheck` script fixed from the dead `tsc --noEmit` (empty `files` array in project-references tsconfig) to `tsc -b`.
