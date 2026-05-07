/**
 * Tiny in-memory pub/sub used as the substrate for `pi.events`
 * (Phase 10). One bus instance per `ExtensionRegistry`; every
 * loaded extension shares it.
 *
 * Browser-compatible — does not use node's `events.EventEmitter`
 * (which is what the coding-agent reference implements). Handlers
 * fire in subscription order; thrown errors are caught and logged
 * so a buggy listener cannot poison peers or the emitter.
 *
 * `emit` returns a `Promise<void>` so callers can `await` to keep
 * downstream context (e.g. `pi.session`'s active sessionId) alive
 * across async handlers. Fire-and-forget callers that drop the
 * promise still work — peer handlers all run, errors still get
 * logged.
 */

export type ExtensionEventBusHandler = (data: unknown) => void | Promise<void>;

export interface ExtensionEventBusUnsubscribe {
  (): void;
}

export interface ExtensionEventBus {
  emit(channel: string, data: unknown): Promise<void>;
  on(channel: string, handler: ExtensionEventBusHandler): ExtensionEventBusUnsubscribe;
}

export interface ExtensionEventBusController extends ExtensionEventBus {
  /** Drops every subscription. Used on registry dispose. */
  clear(): void;
}

export function createExtensionEventBus(): ExtensionEventBusController {
  const channels = new Map<string, Set<ExtensionEventBusHandler>>();
  // Tracks channels whose handlers are currently executing synchronously.
  // Set around `handler(data)` invocation only — cleared before the `await`
  // so that concurrent external calls (which arrive after the yield) are not
  // blocked. Only synchronous re-entrant calls (from within the handler body)
  // are caught, which is the only case that can cause a stack-overflow loop.
  const inflight = new Set<string>();
  return {
    async emit(channel, data) {
      if (inflight.has(channel)) {
        console.warn(
          `[extensions] pi.events.emit('${channel}') called re-entrantly — skipping to prevent infinite loop`
        );
        return;
      }
      const handlers = channels.get(channel);
      if (!handlers || handlers.size === 0) return;
      for (const handler of [...handlers]) {
        // Set inflight around the synchronous invocation only so that a
        // handler calling emit('same-channel') synchronously is detected.
        // The flag is cleared before the await so concurrent external calls
        // that arrive after the yield point are not affected.
        inflight.add(channel);
        let handlerPromise: void | Promise<void>;
        try {
          handlerPromise = handler(data) as void | Promise<void>;
        } catch (syncErr) {
          // Handler threw synchronously; log, clear inflight, move on.
          console.error(`[extensions] pi.events handler '${channel}' threw:`, syncErr);
          continue;
        } finally {
          // Runs in both success and catch paths — clears inflight before any await.
          inflight.delete(channel);
        }
        try {
          await handlerPromise;
        } catch (asyncErr) {
          console.error(`[extensions] pi.events handler '${channel}' threw:`, asyncErr);
        }
      }
    },
    on(channel, handler) {
      let handlers = channels.get(channel);
      if (!handlers) {
        handlers = new Set();
        channels.set(channel, handlers);
      }
      handlers.add(handler);
      return () => {
        const set = channels.get(channel);
        if (!set) return;
        set.delete(handler);
        if (set.size === 0) channels.delete(channel);
      };
    },
    clear() {
      channels.clear();
    },
  };
}
