# `rate-limit-watch`

Synthesized Phase 9 sample. Subscribes to
`after_provider_response` and pulls a remaining-requests counter
out of well-known rate-limit headers
(`x-ratelimit-remaining-requests`,
`x-ratelimit-remaining`, `anthropic-ratelimit-requests-remaining`),
appending it as a `rate-limit` extension entry.

## Origin

Synthesized — there is no coding-agent counterpart. The Phase 9
plan calls for a small "watcher"-style extension that proves the
response hook is observation-only and never mutates the LLM
round-trip even when an extension throws. This sample fills that
slot.

## What it demonstrates

- Reading provider headers from
  `AfterProviderResponseEvent.headers`.
- Best-effort parsing of provider-specific rate-limit headers
  without coupling to a single vendor.
- Same persistence path as `provider-payload`: every observation
  is written through `pi.session.appendEntry` so it survives
  reload.
