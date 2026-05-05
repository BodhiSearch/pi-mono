# `provider-payload`

Demonstrates the Phase 9 provider hooks
(`before_provider_request`, `after_provider_response`). Each hook
appends a custom session entry through `pi.session.appendEntry` so
the e2e suite can assert that:

1. `before_provider_request` fires before the LLM HTTP request and
   sees the wire payload object.
2. `after_provider_response` fires after the response headers are
   received and surfaces `status` + `headers`.

Both entries land in the persisted session log alongside the
assistant turn, so replay (Phase 8 plumbing) shows the same trail
on `session/load`.

## Origin

Ported from `packages/coding-agent/examples/extensions/provider-payload.ts`.
The coding-agent version writes to a node-side log file via
`fs.appendFileSync`; the web-acp port routes the same observations
through `pi.session.appendEntry` because the agent runs in a Web
Worker with no node `fs`.

## Diff vs upstream

- `appendFileSync` log writes → `pi.session.appendEntry` calls.
- No payload mutation in the e2e default; the file's comment shows
  the supported "return a replacement" pattern, which the
  registry's `dispatchBeforeProviderRequest` honours.
