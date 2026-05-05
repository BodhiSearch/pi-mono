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
  return {
    async emit(channel, data) {
      const handlers = channels.get(channel);
      if (!handlers || handlers.size === 0) return;
      for (const handler of [...handlers]) {
        try {
          await handler(data);
        } catch (err) {
          console.error(`[extensions] pi.events handler '${channel}' threw:`, err);
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
