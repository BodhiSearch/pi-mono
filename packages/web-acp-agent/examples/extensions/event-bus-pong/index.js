export default function eventBusPong(pi) {
  pi.events.on('ping', async data => {
    const payload = data && typeof data === 'object' ? data : {};
    await pi.session.appendEntry('event-bus', {
      role: 'pong',
      received: 'ping',
      from: payload.from ?? null,
      seq: payload.seq ?? null,
    });
    await pi.events.emit('pong', { from: 'event-bus-pong', seq: payload.seq ?? null });
  });
}
