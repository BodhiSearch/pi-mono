/**
 * Read-only session forwarder handed to extensions as `ctx.session`.
 *
 * The forwarder pins the supplier + the session id that was current
 * at construction time. Every method re-reads the live supplier and
 * throws `InvalidSessionError` when:
 *
 *  - the supplier returns `null` (no active session, e.g. vault
 *    unmounted after the extension captured the reference), or
 *  - the supplier returns a manager whose `getSessionId()` differs
 *    from the id pinned at construction time (the session was
 *    swapped since the forwarder was issued — e.g. the user switched
 *    sessions between emitting `session_loaded` and an async handler
 *    later reading `ctx.session`).
 *
 * The web-agent issues a fresh forwarder on every `buildContext` call
 * inside `ExtensionHostController`, so handlers that close over the
 * reference in one invocation will see the stale-session error on the
 * next session — which is exactly the contract we want.
 */

import type {
  ReadonlySessionManager,
  SessionEntry,
  SessionHeader,
  SessionTreeNode,
} from '../session/types';

/** Supplier used by the forwarder to re-read the active session manager. */
export type SessionSupplier = () => ReadonlySessionManager | null;

/**
 * Thrown by every forwarder method when the underlying session is
 * missing or has changed. Extensions typically propagate the throw
 * so the runner's error-isolation fan-out reports it without crashing
 * the worker.
 */
export class InvalidSessionError extends Error {
  constructor(message = 'ExtensionContext.session is no longer valid') {
    super(message);
    this.name = 'InvalidSessionError';
  }
}

/**
 * Thin pass-through that re-reads the live session on each call and
 * guards against mid-flight swaps. Implements
 * `ReadonlySessionManager` so extensions use it exactly the same way
 * they would a directly-owned `SessionManager`.
 */
export class ReadonlySessionForwarder implements ReadonlySessionManager {
  private readonly supplier: SessionSupplier;
  private readonly pinnedSessionId: string;

  constructor(supplier: SessionSupplier, pinnedSessionId: string) {
    this.supplier = supplier;
    this.pinnedSessionId = pinnedSessionId;
  }

  /**
   * Construct a forwarder pinned to the session the supplier currently
   * reports. Returns `null` when no session is active so the caller
   * can surface `ctx.session = null` to extensions instead of an
   * always-throwing proxy.
   */
  static from(supplier: SessionSupplier): ReadonlySessionForwarder | null {
    const current = supplier();
    if (!current) return null;
    return new ReadonlySessionForwarder(supplier, current.getSessionId());
  }

  private live(): ReadonlySessionManager {
    const current = this.supplier();
    if (!current) {
      throw new InvalidSessionError(
        'ExtensionContext.session: no active session (vault unmounted or never loaded)'
      );
    }
    if (current.getSessionId() !== this.pinnedSessionId) {
      throw new InvalidSessionError(
        `ExtensionContext.session: session was swapped (pinned=${this.pinnedSessionId}, live=${current.getSessionId()})`
      );
    }
    return current;
  }

  getCwd(): string {
    return this.live().getCwd();
  }
  getSessionDir(): string {
    return this.live().getSessionDir();
  }
  getSessionId(): string {
    return this.live().getSessionId();
  }
  getSessionFile(): string | undefined {
    return this.live().getSessionFile();
  }
  getHeader(): SessionHeader | null {
    return this.live().getHeader();
  }
  getEntries(): SessionEntry[] {
    return this.live().getEntries();
  }
  getEntry(id: string): SessionEntry | undefined {
    return this.live().getEntry(id);
  }
  getLeafId(): string | null {
    return this.live().getLeafId();
  }
  getLeafEntry(): SessionEntry | undefined {
    return this.live().getLeafEntry();
  }
  getLabel(id: string): string | undefined {
    return this.live().getLabel(id);
  }
  getBranch(fromId?: string): SessionEntry[] {
    return this.live().getBranch(fromId);
  }
  getTree(): SessionTreeNode[] {
    return this.live().getTree();
  }
  getSessionName(): string | undefined {
    return this.live().getSessionName();
  }
}
