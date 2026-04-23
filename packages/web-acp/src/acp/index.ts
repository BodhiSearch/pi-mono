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
