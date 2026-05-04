/**
 * Per-session keyed preference store. Generic key/value surface;
 * internal agent code wraps known keys with typed accessors
 * (`feature:bashEnabled`, `feature:forceToolCall`, `mcp:toggles`,
 * etc.). Values must be JSON-serialisable.
 */
export interface PreferenceStore {
  get(sessionId: string, key: string): Promise<unknown>;
  set(sessionId: string, key: string, value: unknown): Promise<void>;
  delete(sessionId: string, key: string): Promise<void>;
  list(sessionId: string): Promise<Record<string, unknown>>;
  clearSession(sessionId: string): Promise<void>;
}
