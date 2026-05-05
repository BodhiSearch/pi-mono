# `event-bus-pong`

Demonstrates `pi.events.on` + `pi.events.emit` as the pong side of
a two-extension handshake. Listens for `ping` events on the
inter-extension bus, persists the receipt, and emits `pong` back.

See `event-bus-ping` for the other half of the round-trip and the
shared rationale (split, why no `ctx.ui.notify`, etc.).

## Origin

Synthesized as a sibling to the ported `event-bus-ping`. The
upstream coding-agent example
(`packages/coding-agent/examples/extensions/event-bus.ts`) is a
single extension that emits + receives on the same bus; we split
into a ping / pong pair so the e2e exercises cross-extension
delivery rather than self-ping.
