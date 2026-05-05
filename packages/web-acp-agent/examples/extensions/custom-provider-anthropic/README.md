# custom-provider-anthropic

Phase 11 example. Registers a custom provider that surfaces two
Claude models (Opus 4.5 and Sonnet 4.5) through the built-in
`anthropic-messages` API.

The example wires the apiKey path (`CUSTOM_ANTHROPIC_API_KEY` env
var resolved by the host) and ships an OAuth stub via
`pi.registerProvider({ oauth })`. The OAuth surface is type-fixed
in M6 but not yet host-bridged: M6 stores the definition so a
follow-up RFD (`_bodhi/auth/*`) can probe it.

The e2e suite asserts that:

- `_bodhi/extensions/list` reports a `providers: ['custom-anthropic']`
  capability for this extension.
- The two Claude models appear in the session model picker via
  `NewSessionResponse.models.availableModels`.

The example does not perform a live LLM round-trip; the apiKey
literal `CUSTOM_ANTHROPIC_API_KEY` is a placeholder that would be
swapped for a real secret in a deployment.
