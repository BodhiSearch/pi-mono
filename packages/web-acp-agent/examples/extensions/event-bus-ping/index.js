export default function eventBusPing(pi) {
  pi.events.on('pong', async data => {
    const payload = data && typeof data === 'object' ? data : {};
    await pi.session.appendEntry('event-bus', {
      role: 'ping',
      received: 'pong',
      from: payload.from ?? null,
      seq: payload.seq ?? null,
    });
  });

  pi.registerCommand('ping', {
    description: 'Emit a ping event onto the inter-extension bus',
    handler: async args => {
      const seq = Number.parseInt(args.trim(), 10);
      await pi.events.emit('ping', {
        from: 'event-bus-ping',
        seq: Number.isFinite(seq) ? seq : 1,
      });
      return 'ping emitted';
    },
  });
}
