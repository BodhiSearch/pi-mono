import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import type {
  AuthenticateResponse,
  ClientSideConnection,
  InitializeResponse,
  LoadSessionResponse,
  McpServer,
  McpServerHttp,
  NewSessionResponse,
  PromptResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import {
  BODHI_AUTH_METHOD_ID,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  type BodhiAuthenticateMeta,
  type BodhiMcpTogglesSetResponse,
  type BodhiSessionInfoMeta,
  type BodhiSessionMeta,
  type BodhiSessionsDeleteResponse,
  type SessionInfoView,
} from './index';

export type SessionUpdateListener = (notification: SessionNotification) => void;
export type ExtNotificationListener = (method: string, params: Record<string, unknown>) => void;

/**
 * Thin facade over `ClientSideConnection` with the subset of ACP/Bodhi
 * calls the host hooks need. NDJSON framing and the MessageChannel live
 * in `acp/runtime.ts`.
 */
export class AcpClient {
  readonly #conn: ClientSideConnection;
  readonly #listeners = new Set<SessionUpdateListener>();
  readonly #extListeners = new Set<ExtNotificationListener>();

  constructor(conn: ClientSideConnection) {
    this.#conn = conn;
  }

  get signal(): AbortSignal {
    return this.#conn.signal;
  }

  get closed(): Promise<void> {
    return this.#conn.closed;
  }

  async initialize(): Promise<InitializeResponse> {
    const response = await this.#conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
    });
    if (response.protocolVersion !== PROTOCOL_VERSION) {
      console.warn(
        '[acp/client] agent advertises protocolVersion=%s; client expected %s',
        response.protocolVersion,
        PROTOCOL_VERSION
      );
    }
    return response;
  }

  async authenticate(args: BodhiAuthenticateMeta): Promise<AuthenticateResponse> {
    return this.#conn.authenticate({
      methodId: BODHI_AUTH_METHOD_ID,
      _meta: { token: args.token, baseUrl: args.baseUrl },
    });
  }

  async setSessionModel(sessionId: string, modelId: string): Promise<void> {
    await this.#conn.unstable_setSessionModel({ sessionId, modelId });
  }

  /**
   * Cursor-paginated list of sessions, sorted by `updatedAt` desc.
   * Page size is fixed at 10 (encoded inside the agent's cursor).
   * Pass the previous response's `nextCursor` to fetch the next page;
   * `nextCursor: null` means the last page has been reached.
   * Flattens `SessionInfo._meta.bodhi` extras into a numeric-timestamp view.
   */
  async listSessions(cursor?: string): Promise<{
    sessions: SessionInfoView[];
    nextCursor: string | null;
  }> {
    const response = await this.#conn.listSessions(cursor ? { cursor } : {});
    const sessions = (response.sessions ?? []).map(info => {
      const meta = (info._meta?.bodhi ?? {}) as Partial<BodhiSessionInfoMeta>;
      const updatedAtMs = info.updatedAt ? Date.parse(info.updatedAt) : NaN;
      return {
        id: info.sessionId,
        title: info.title ?? null,
        createdAt: typeof meta.createdAt === 'number' ? meta.createdAt : 0,
        updatedAt: Number.isFinite(updatedAtMs) ? updatedAtMs : 0,
        turnCount: typeof meta.turnCount === 'number' ? meta.turnCount : 0,
        lastModelId: typeof meta.lastModelId === 'string' ? meta.lastModelId : null,
      };
    });
    return { sessions, nextCursor: response.nextCursor ?? null };
  }

  async newSession(
    mcpServers: McpServerHttp[] = [],
    sessionMeta?: BodhiSessionMeta
  ): Promise<NewSessionResponse> {
    return this.#conn.newSession({
      cwd: '/',
      mcpServers: toMcpServers(mcpServers),
      ...(sessionMeta ? { _meta: { bodhi: sessionMeta } } : {}),
    });
  }

  /** Releases in-memory resources; the persisted row remains for `loadSession`. */
  async closeSession(sessionId: string): Promise<void> {
    await this.#conn.closeSession({ sessionId });
  }

  async loadSession(
    sessionId: string,
    mcpServers: McpServerHttp[] = [],
    sessionMeta?: BodhiSessionMeta
  ): Promise<LoadSessionResponse> {
    return this.#conn.loadSession({
      sessionId,
      cwd: '/',
      mcpServers: toMcpServers(mcpServers),
      ...(sessionMeta ? { _meta: { bodhi: sessionMeta } } : {}),
    });
  }

  /**
   * Persistently remove a session. Resolves with `true` if the worker
   * found and deleted a row, `false` if it had no record (idempotent
   * on repeat-deletes). The worker also releases any held MCP
   * connections + clears its inline-agent buffer if the session was
   * the active one.
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const raw = await this.#conn.extMethod(BODHI_SESSIONS_DELETE_METHOD, { sessionId });
    const payload = raw as BodhiSessionsDeleteResponse;
    return payload.deleted === true;
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<void> {
    await this.#conn.setSessionConfigOption({ sessionId, configId, value });
  }

  /**
   * Mutate per-session MCP toggles. Pass `toolName` to flip a per-tool
   * override; omit it to flip the server-level override. The response
   * returns the full toggle snapshot so callers can update local UI
   * without a follow-up `getSession` round-trip.
   */
  async setMcpToggle(
    sessionId: string,
    serverSlug: string,
    value: boolean,
    toolName?: string
  ): Promise<BodhiMcpTogglesSetResponse> {
    const raw = await this.#conn.extMethod(BODHI_MCP_TOGGLES_SET_METHOD, {
      sessionId,
      serverSlug,
      toolName,
      value,
    });
    return raw as BodhiMcpTogglesSetResponse;
  }

  async prompt(sessionId: string, text: string): Promise<PromptResponse> {
    return this.#conn.prompt({
      sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  async cancel(sessionId: string): Promise<void> {
    await this.#conn.cancel({ sessionId });
  }

  onSessionUpdate(listener: SessionUpdateListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Exposed so the outer transport layer (the hook) can hand
   * session/update notifications back to subscribers.
   */
  dispatchSessionUpdate(notification: SessionNotification): void {
    for (const l of this.#listeners) {
      try {
        l(notification);
      } catch (err) {
        console.error('AcpClient listener threw:', err);
      }
    }
  }

  onExtNotification(listener: ExtNotificationListener): () => void {
    this.#extListeners.add(listener);
    return () => this.#extListeners.delete(listener);
  }

  dispatchExtNotification(method: string, params: Record<string, unknown>): void {
    for (const l of this.#extListeners) {
      try {
        l(method, params);
      } catch (err) {
        console.error('AcpClient ext listener threw:', err);
      }
    }
  }
}

/**
 * Coerce composed `McpServerHttp` entries into the wire-shape `McpServer`
 * union the ACP SDK accepts on `session/new` / `session/load`.
 */
function toMcpServers(servers: McpServerHttp[]): McpServer[] {
  return servers.map(server => ({ ...server, type: 'http' as const }));
}
