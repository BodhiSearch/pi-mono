import { describe, expect, it, vi } from 'vitest';
import { createExtensionEventBus } from './event-bus';

describe('createExtensionEventBus', () => {
  it('delivers data to registered handlers in subscription order', async () => {
    const bus = createExtensionEventBus();
    const received: number[] = [];
    bus.on('ch', async d => {
      received.push((d as { n: number }).n * 1);
    });
    bus.on('ch', async d => {
      received.push((d as { n: number }).n * 10);
    });
    await bus.emit('ch', { n: 2 });
    expect(received).toEqual([2, 20]);
  });

  it('unsubscribes correctly', async () => {
    const bus = createExtensionEventBus();
    const calls: unknown[] = [];
    const unsub = bus.on('ch', d => {
      calls.push(d);
    });
    await bus.emit('ch', 'first');
    unsub();
    await bus.emit('ch', 'second');
    expect(calls).toEqual(['first']);
  });

  it('isolates handler errors — other handlers still run', async () => {
    const bus = createExtensionEventBus();
    const calls: string[] = [];
    bus.on('ch', () => {
      throw new Error('boom');
    });
    bus.on('ch', () => {
      calls.push('ok');
    });
    await bus.emit('ch', null);
    expect(calls).toEqual(['ok']);
  });

  it('skips re-entrant emit on the same channel and warns', async () => {
    const bus = createExtensionEventBus();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];

    bus.on('ch', async () => {
      calls.push('outer');
      await bus.emit('ch', null); // re-entrant — must be skipped
      calls.push('outer-after');
    });

    await bus.emit('ch', null);

    expect(calls).toEqual(['outer', 'outer-after']);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('re-entrantly'));
    warnSpy.mockRestore();
  });

  it('allows concurrent emit on different channels', async () => {
    const bus = createExtensionEventBus();
    const calls: string[] = [];

    bus.on('a', async () => {
      calls.push('a');
      await bus.emit('b', null); // different channel — must be allowed
    });
    bus.on('b', () => {
      calls.push('b');
    });

    await bus.emit('a', null);
    expect(calls).toEqual(['a', 'b']);
  });

  it('cleans up the inflight marker even when a handler throws', async () => {
    const bus = createExtensionEventBus();
    bus.on('ch', () => {
      throw new Error('fail');
    });

    // First emit (throws internally, caught by the bus)
    await bus.emit('ch', null);

    // Second emit must not be blocked by a stale inflight entry
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const calls: string[] = [];
    bus.on('ch', () => {
      calls.push('second');
    });
    await bus.emit('ch', null);
    // Both handlers run (first throws + second logs), no re-entrancy warning
    expect(calls).toEqual(['second']);
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('allows two sequential unawaited emits on the same channel from outside a handler', () => {
    // This is a concurrency scenario, NOT re-entrancy. Both calls must run.
    const bus = createExtensionEventBus();
    const received: number[] = [];
    bus.on('ch', d => {
      received.push(d as number);
    });
    // unawaited — both promises start concurrently
    void bus.emit('ch', 1);
    void bus.emit('ch', 2);
    // Handlers are synchronous so both fire before any await yields
    expect(received).toEqual([1, 2]);
  });

  it('clear() drops all subscriptions', async () => {
    const bus = createExtensionEventBus();
    const calls: unknown[] = [];
    bus.on('ch', d => {
      calls.push(d);
    });
    bus.clear();
    await bus.emit('ch', 'after-clear');
    expect(calls).toEqual([]);
  });
});
