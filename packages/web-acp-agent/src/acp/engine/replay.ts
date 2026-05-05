import type { SessionNotification } from '@agentclientprotocol/sdk';
import type { AgentMessage } from '@mariozechner/pi-agent-core';
import type {
  BuiltinPayload,
  ExtensionPayload,
  SessionEntry,
  TurnPayload,
} from '../../storage/session-store';
import { makeBuiltinAssistantMessage, makeBuiltinUserMessage } from '../wire-utils';

// Absent callback skips that kind silently.
export interface EntryWalkers {
  notification?: (payload: SessionNotification) => void | Promise<void>;
  turn?: (payload: TurnPayload) => void | Promise<void>;
  builtin?: (payload: BuiltinPayload) => void | Promise<void>;
  extension?: (payload: ExtensionPayload, seq: number) => void | Promise<void>;
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
    } else if (entry.kind === 'extension' && walkers.extension) {
      await walkers.extension(entry.payload as ExtensionPayload, entry.seq);
    }
  }
}

/**
 * Build the rendered transcript from persisted entries. Walks in seq order:
 * - `'turn'` rows carry the cumulative LLM-visible history; we append
 *   the delta from the previous turn's snapshot.
 * - `'builtin'` rows are inserted as a tagged user+assistant pair so
 *   reload reproduces them in the right chronological slot. They never
 *   feed `inline.restoreMessages()` because that path consumes only
 *   `'turn'` kinds.
 *
 * Returns `unknown[]` because `AgentMessage` carries provider-specific
 * shapes that would tie this helper to pi-agent-core's surface; the
 * client casts to its own message type.
 */
export function reconstructMessages(entries: SessionEntry[]): unknown[] {
  let lastTurnMessages: AgentMessage[] = [];
  const messages: unknown[] = [];
  for (const entry of entries) {
    if (entry.kind === 'turn') {
      const payload = entry.payload as TurnPayload;
      const next = Array.isArray(payload.finalMessages) ? payload.finalMessages : [];
      if (next.length > lastTurnMessages.length) {
        messages.push(...next.slice(lastTurnMessages.length));
      }
      lastTurnMessages = next;
    } else if (entry.kind === 'builtin') {
      const payload = entry.payload as BuiltinPayload;
      const tag = {
        command: payload.command,
        ...(payload.action ? { action: payload.action } : {}),
      };
      messages.push(makeBuiltinUserMessage(payload.userText, tag));
      messages.push(makeBuiltinAssistantMessage(payload.replyText, tag));
    } else if (entry.kind === 'extension') {
      const payload = entry.payload as ExtensionPayload;
      const text = renderExtensionEntry(payload);
      const tag = {
        command: `extension:${payload.extensionName}:${payload.customType}`,
      };
      messages.push(makeBuiltinAssistantMessage(text, tag));
    }
  }
  return messages;
}

function renderExtensionEntry(payload: ExtensionPayload): string {
  const head = `[${payload.extensionName}/${payload.customType}]`;
  const body = typeof payload.data === 'string' ? payload.data : safeStringify(payload.data);
  const labelSuffix = payload.label ? ` (label: ${payload.label})` : '';
  return `${head} ${body}${labelSuffix}`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
