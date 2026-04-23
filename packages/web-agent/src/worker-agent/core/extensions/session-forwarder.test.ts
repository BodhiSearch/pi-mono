import { describe, expect, it } from 'vitest';
import { InvalidSessionError, ReadonlySessionForwarder } from './session-forwarder';
import type {
  ReadonlySessionManager,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from '../session/types';

class FakeSession implements ReadonlySessionManager {
  readonly id: string;
  entries: SessionEntry[] = [];
  constructor(id: string) {
    this.id = id;
  }
  getCwd(): string {
    return '/vault';
  }
  getSessionDir(): string {
    return '/vault/.pi/sessions';
  }
  getSessionId(): string {
    return this.id;
  }
  getSessionFile(): string | undefined {
    return undefined;
  }
  getHeader(): SessionHeader | null {
    return null;
  }
  getEntries(): SessionEntry[] {
    return this.entries;
  }
  getEntry(): SessionEntry | undefined {
    return undefined;
  }
  getLeafId(): string | null {
    return null;
  }
  getLeafEntry(): SessionEntry | undefined {
    return undefined;
  }
  getLabel(): string | undefined {
    return undefined;
  }
  getBranch(): SessionEntry[] {
    return this.entries;
  }
  getTree(): SessionTreeNode[] {
    return [];
  }
  getSessionName(): string | undefined {
    return `session-${this.id}`;
  }
}

describe('ReadonlySessionForwarder', () => {
  it('returns null when no session is active at construction time', () => {
    const forwarder = ReadonlySessionForwarder.from(() => null);
    expect(forwarder).toBeNull();
  });

  it('forwards reads to the live session manager while the id matches', () => {
    const sess = new FakeSession('s1');
    const forwarder = ReadonlySessionForwarder.from(() => sess);
    expect(forwarder).not.toBeNull();
    expect(forwarder!.getSessionId()).toBe('s1');
    expect(forwarder!.getSessionName()).toBe('session-s1');
  });

  it('throws InvalidSessionError when the supplier returns null after pinning', () => {
    let active: ReadonlySessionManager | null = new FakeSession('s1');
    const forwarder = ReadonlySessionForwarder.from(() => active);
    active = null;
    expect(() => forwarder!.getSessionId()).toThrow(InvalidSessionError);
    expect(() => forwarder!.getEntries()).toThrow(/no active session/);
  });

  it('throws InvalidSessionError when the session has been swapped', () => {
    let active: ReadonlySessionManager = new FakeSession('s1');
    const forwarder = ReadonlySessionForwarder.from(() => active);
    active = new FakeSession('s2');
    expect(() => forwarder!.getCwd()).toThrow(InvalidSessionError);
    try {
      forwarder!.getHeader();
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidSessionError);
      expect((err as Error).message).toContain('pinned=s1');
      expect((err as Error).message).toContain('live=s2');
    }
  });

  it('tracks mutations on the live session rather than snapshotting', () => {
    const sess = new FakeSession('s1');
    const forwarder = ReadonlySessionForwarder.from(() => sess);
    expect(forwarder!.getEntries()).toEqual([]);
    sess.entries = [{ id: 'e1', parentId: null } as unknown as SessionEntry];
    expect(forwarder!.getEntries()).toHaveLength(1);
  });
});
