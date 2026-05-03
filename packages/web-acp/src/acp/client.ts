import type {
  Client,
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
  BODHI_FEATURES_LIST_METHOD,
  BODHI_FEATURES_SET_METHOD,
  BODHI_GET_SESSION_METHOD,
  BODHI_LIST_MODELS_METHOD,
  BODHI_LIST_SESSIONS_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
  type BodhiAuthenticateMeta,
  type BodhiFeaturesListResponse,
  type BodhiFeaturesSetResponse,
  type BodhiGetSessionResponse,
  type BodhiListModelsResponse,
  type BodhiListSessionsResponse,
  type BodhiMcpTogglesSetResponse,
  type BodhiModelDescriptor,
  type BodhiSessionMeta,
  type BodhiSessionsDeleteResponse,
  type BodhiSessionSummary,
  type BodhiVolumeDescriptor,
  type BodhiVolumesListResponse,
} from './index';

export type SessionUpdateListener = (notification: SessionNotification) => void;

/**
 * Tiny wrapper over `ClientSideConnection` exposing just the calls
 * `useAcp` needs. Transport framing (ports, ndJSON) lives one layer up.
 * Phase C provides the skeleton; phase D wires it into the hook.
 */
export class AcpClient {
  readonly #conn: ClientSideConnection;
  readonly #listeners = new Set<SessionUpdateListener>();

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
    return this.#conn.initialize({
      protocolVersion: 1,
      clientCapabilities: {
        // M2.3: advertise `fs/*` as an IDE-integration seam. Built-in
        // `bash` never calls these — external ACP agents do (see
        // `specs/web-acp-client/volumes.md`).
        fs: { readTextFile: true, writeTextFile: true },
      },
    });
  }

  async authenticate(args: BodhiAuthenticateMeta): Promise<void> {
    await this.#conn.authenticate({
      methodId: BODHI_AUTH_METHOD_ID,
      _meta: { token: args.token, baseUrl: args.baseUrl },
    });
  }

  async listModels(): Promise<BodhiModelDescriptor[]> {
    const raw = await this.#conn.extMethod(BODHI_LIST_MODELS_METHOD, {});
    const payload = raw as BodhiListModelsResponse;
    return payload.models ?? [];
  }

  async listSessions(): Promise<BodhiSessionSummary[]> {
    const raw = await this.#conn.extMethod(BODHI_LIST_SESSIONS_METHOD, {});
    const payload = raw as BodhiListSessionsResponse;
    return payload.sessions ?? [];
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

  async getSession(sessionId: string): Promise<BodhiGetSessionResponse> {
    const raw = await this.#conn.extMethod(BODHI_GET_SESSION_METHOD, { sessionId });
    return raw as BodhiGetSessionResponse;
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

  async listVolumes(): Promise<BodhiVolumeDescriptor[]> {
    const raw = await this.#conn.extMethod(BODHI_VOLUMES_LIST_METHOD, {});
    const payload = raw as BodhiVolumesListResponse;
    return payload.volumes ?? [];
  }

  async listFeatures(sessionId: string): Promise<BodhiFeaturesListResponse> {
    const raw = await this.#conn.extMethod(BODHI_FEATURES_LIST_METHOD, { sessionId });
    return raw as BodhiFeaturesListResponse;
  }

  async setFeature(
    sessionId: string,
    key: string,
    value: boolean
  ): Promise<BodhiFeaturesSetResponse> {
    const raw = await this.#conn.extMethod(BODHI_FEATURES_SET_METHOD, { sessionId, key, value });
    return raw as BodhiFeaturesSetResponse;
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

  async prompt(sessionId: string, text: string, modelId: string): Promise<PromptResponse> {
    return this.#conn.prompt({
      sessionId,
      prompt: [{ type: 'text', text }],
      _meta: { bodhi: { modelId } },
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
}

/**
 * Coerce composed `McpServerHttp` entries into the wire-shape `McpServer`
 * union the ACP SDK accepts on `session/new` / `session/load`.
 */
function toMcpServers(servers: McpServerHttp[]): McpServer[] {
  return servers.map(server => ({ ...server, type: 'http' as const }));
}

export function buildClientHandler(client: AcpClient): Client {
  return {
    async sessionUpdate(params) {
      client.dispatchSessionUpdate(params);
    },
  };
}
