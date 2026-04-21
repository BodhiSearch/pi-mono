/**
 * Frontend-only chat-panel messages.
 *
 * Used for builtin slash-command feedback (`/help`, `/session`,
 * confirmation lines, etc.) that should appear inline in the chat
 * panel but MUST NOT be persisted to the session DB. On every
 * `session_loaded` the list is reset to `[]` — reloading the app
 * yields an empty transient buffer by design.
 *
 * Interleaving with persisted messages is by insertion order via
 * `afterMessageIndex`: the transient is rendered immediately after
 * the N-th persisted message, where N was the persisted-message
 * count when the transient was pushed.
 */
export interface TransientMessage {
  id: string;
  kind: 'info' | 'error';
  /** Optional heading displayed above the body text. */
  title?: string;
  /**
   * Body text. Newlines are preserved by the renderer, so callers can
   * pass multi-line output (e.g. the `/help` listing) without any
   * extra formatting.
   */
  text: string;
  createdAt: number;
  /**
   * Number of persisted messages in the transcript at the moment this
   * transient was appended. The renderer splices the transient in
   * after that many persisted bubbles so streaming assistant output
   * doesn't disturb its position.
   */
  afterMessageIndex: number;
}

let transientIdCounter = 0;

/**
 * Stable id generator. The monotonic suffix guarantees uniqueness
 * even when two transient messages are pushed in the same
 * millisecond (e.g. a confirmation plus a follow-up error).
 */
export function nextTransientId(): string {
  transientIdCounter += 1;
  return `transient-${Date.now()}-${transientIdCounter}`;
}
