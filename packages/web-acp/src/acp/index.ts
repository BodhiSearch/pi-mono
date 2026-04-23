export { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

export type {
  Agent,
  Client,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  StopReason,
} from '@agentclientprotocol/sdk';

export const BODHI_AUTH_METHOD_ID = 'bodhi-token';
export const BODHI_LIST_MODELS_METHOD = 'bodhi/listModels';
export const BODHI_LIST_SESSIONS_METHOD = 'bodhi/listSessions';

export interface BodhiAuthenticateMeta {
  token: string;
  baseUrl: string;
}

export interface BodhiModelDescriptor {
  id: string;
  apiFormat: string;
}

export interface BodhiListModelsResponse extends Record<string, unknown> {
  models: BodhiModelDescriptor[];
}

/**
 * Session summary surfaced to the client for the picker. Mirrors
 * `SessionSummary` in `agent/session-store` but is the wire contract —
 * kept independent so the worker can evolve store internals without
 * breaking clients.
 */
export interface BodhiSessionSummary {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastModelId: string | null;
}

export interface BodhiListSessionsResponse extends Record<string, unknown> {
  sessions: BodhiSessionSummary[];
}
