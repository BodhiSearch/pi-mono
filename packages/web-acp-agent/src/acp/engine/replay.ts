import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { BuiltinPayload, SessionEntry, TurnPayload } from '../../storage/session-store';

// Absent callback skips that kind silently.
export interface EntryWalkers {
  notification?: (payload: SessionNotification) => void | Promise<void>;
  turn?: (payload: TurnPayload) => void | Promise<void>;
  builtin?: (payload: BuiltinPayload) => void | Promise<void>;
}

// Callbacks run sequentially so notification re-emit order matches
// persisted seq — `loadSession` relies on this for replay determinism.
export async function walkEntries(entries: SessionEntry[], walkers: EntryWalkers): Promise<void> {
  for (const entry of entries) {
    if (entry.kind === 'notification' && walkers.notification) {
      await walkers.notification(entry.payload as SessionNotification);
    } else if (entry.kind === 'turn' && walkers.turn) {
      await walkers.turn(entry.payload as TurnPayload);
    } else if (entry.kind === 'builtin' && walkers.builtin) {
      await walkers.builtin(entry.payload as BuiltinPayload);
    }
  }
}
