# M11 — Library extraction

**Status:** planned. Test seam: existing tests stay green under consumer wiring.

**Scope preview.**
- Move `packages/web-agent/src/web-agent/` into its own npm-publishable package (working name `@bodhiapp/web-agent`).
- Reshape current `packages/web-agent/` into a reference app consuming the extracted package.
- Add architectural lint rule enforcing the "imports inward only" invariant (principle #3).
- Peer deps: `react`, `@mariozechner/pi-ai`, `@mariozechner/pi-agent-core`.
- Existing Playwright specs run against the consumer wiring without modification — validates the public API is sufficient.

**Gate.** `npm run build` produces the package; `npm publish --dry-run` clean; all tests pass against the extracted form.
