# Milestone gate

A milestone is only "done" when all of these are true:

1. `npm run check` at repo root is green (biome, tsgo, `check:browser-smoke`, `web-ui check`, `web-agent check`).
2. `cd packages/web-agent && npm test` green.
3. `cd packages/web-agent && npm run test:e2e` green (pre-existing `chat.spec.ts` plus any new spec the milestone adds).
4. `cd packages/web-agent && npm run build` green.
5. No new `any`, no new `// @ts-ignore`, no new `// @ts-nocheck`, no `TODO: revisit`-without-tracking-note.
6. A paragraph in the per-milestone file describes what landed.

Skipping any item breaks the milestone contract. If a gate item cannot be met for a real reason, document it as a decision in `../decisions/` — don't silently bypass. See principle #9 in `../04-principles.md`.
