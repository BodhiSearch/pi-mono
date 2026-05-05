# `event-bus-ping`

Demonstrates `pi.events.emit` as the ping side of a two-extension
ping/pong handshake. Subscribes to the `pong` channel and persists
each pong observation as a session entry.

Pairs with `event-bus-pong`. Together they exercise:

- `pi.events.emit(channel, data)` from a slash command handler
  (`/ping`).
- `pi.events.on(channel, handler)` for bus subscriptions, with
  the `Disposable` lifetime tied to the registry.
- Round-trip across two extensions: ping → pong handler →
  pong emit → ping handler.
- Persistence via `pi.session.appendEntry` so every observation
  survives reload (browser host has no console-only sink).

## Origin

Ported from
`packages/coding-agent/examples/extensions/event-bus.ts`. The
upstream is a single extension that registers both an emitter and
a listener on the same bus channel and uses `ctx.ui.notify` to
surface each receipt. The web-acp port:

- Splits emitter and listener into two extensions so the e2e
  proves cross-extension delivery (single-extension self-ping
  passes trivially).
- Drops `ctx.ui.notify` (UI primitives are out of scope for M6
  per `extensions.md`) and routes observations through
  `pi.session.appendEntry`.
- Uses the `ping` / `pong` channel pair instead of the upstream
  `my:notification` so the channel direction is visible in the
  e2e assertions.
