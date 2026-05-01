/**
 * Tiny wrapper over `ClientSideConnection` exposing just the calls the
 * CLI shell needs. Mirrors `packages/web-acp/src/acp/client.ts` — the
 * CLI is a different host but speaks the same wire to the same agent
 * adapter, so this surface is intentionally identical.
 */

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
import { requestPermissionStub } from '@bodhiapp/web-acp-agent';
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
} from '@bodhiapp/web-acp-agent';

export type SessionUpdateListener = (notification: SessionNotification) => void;

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
        // `fs/*` is for IDE-host integrations; the CLI exposes nothing
        // here today (built-in `bash` and the volume registry don't
        // need ACP `fs/*`). We still advertise zero so the server can
        // gate feature work that depends on it.
        fs: { readTextFile: false, writeTextFile: false },
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
    cwd: string,
    mcpServers: McpServerHttp[] = [],
    sessionMeta?: BodhiSessionMeta
  ): Promise<NewSessionResponse> {
    return this.#conn.newSession({
      cwd,
      mcpServers: toMcpServers(mcpServers),
      ...(sessionMeta ? { _meta: { bodhi: sessionMeta } } : {}),
    });
  }

  async loadSession(
    sessionId: string,
    cwd: string,
    mcpServers: McpServerHttp[] = [],
    sessionMeta?: BodhiSessionMeta
  ): Promise<LoadSessionResponse> {
    return this.#conn.loadSession({
      sessionId,
      cwd,
      mcpServers: toMcpServers(mcpServers),
      ...(sessionMeta ? { _meta: { bodhi: sessionMeta } } : {}),
    });
  }

  async getSession(sessionId: string): Promise<BodhiGetSessionResponse> {
    const raw = await this.#conn.extMethod(BODHI_GET_SESSION_METHOD, { sessionId });
    return raw as BodhiGetSessionResponse;
  }

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

function toMcpServers(servers: McpServerHttp[]): McpServer[] {
  return servers.map(server => ({ ...server, type: 'http' as const }));
}

export function buildClientHandler(client: AcpClient): Client {
  return {
    requestPermission: requestPermissionStub,
    async sessionUpdate(params) {
      client.dispatchSessionUpdate(params);
    },
  };
}
