import type { SessionNotification } from '@agentclientprotocol/sdk';

const DEFAULT_WAIT_TIMEOUT = 60_000;

export interface ExtNotificationRecord {
  method: string;
  params: unknown;
}

export class NotificationBuffer {
  readonly sessionUpdates: SessionNotification[] = [];
  readonly extNotifications: ExtNotificationRecord[] = [];
  private readonly waiters: Array<() => void> = [];

  pushSessionUpdate(n: SessionNotification): void {
    this.sessionUpdates.push(n);
    this.flushWaiters();
  }

  pushExtNotification(method: string, params: unknown): void {
    this.extNotifications.push({ method, params });
    this.flushWaiters();
  }

  accumulatedAssistantText(sessionId: string): string {
    let text = '';
    for (const n of this.sessionUpdates) {
      if (n.sessionId !== sessionId) continue;
      const update = n.update as {
        sessionUpdate?: string;
        content?: { type?: string; text?: string };
      };
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = update.content;
        if (content && content.type === 'text' && typeof content.text === 'string') {
          text += content.text;
        }
      }
    }
    return text;
  }

  waitForUpdate(
    sessionId: string,
    predicate: (n: SessionNotification) => boolean,
    timeoutMs = DEFAULT_WAIT_TIMEOUT
  ): Promise<SessionNotification> {
    return new Promise<SessionNotification>((resolve, reject) => {
      const tryMatch = (): boolean => {
        for (const n of this.sessionUpdates) {
          if (n.sessionId === sessionId && predicate(n)) {
            resolve(n);
            return true;
          }
        }
        return false;
      };
      if (tryMatch()) return;
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(check);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `waitForUpdate(${sessionId}) timed out after ${timeoutMs}ms; ` +
              `sessionUpdates=${this.sessionUpdates.length} ` +
              `extNotifications=${this.extNotifications.length}`
          )
        );
      }, timeoutMs);
      const check = (): void => {
        if (tryMatch()) {
          clearTimeout(timer);
          const idx = this.waiters.indexOf(check);
          if (idx >= 0) this.waiters.splice(idx, 1);
        }
      };
      this.waiters.push(check);
    });
  }

  reset(): void {
    this.sessionUpdates.length = 0;
    this.extNotifications.length = 0;
  }

  private flushWaiters(): void {
    for (const check of [...this.waiters]) {
      check();
    }
  }
}
