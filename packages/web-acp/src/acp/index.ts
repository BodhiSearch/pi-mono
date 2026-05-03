// Host-side ACP barrel. SDK re-exports come straight from
// `@agentclientprotocol/sdk`; every Bodhi wire constant + type is
// re-exported from `@bodhiapp/web-acp-agent` so the host has no
// duplicate-by-hand maintenance burden — the agent package owns
// the wire surface.

export { AgentSideConnection, ClientSideConnection, ndJsonStream } from '@agentclientprotocol/sdk';

export type {
  Agent,
  AvailableCommand,
  AvailableCommandInput,
  AvailableCommandsUpdate,
  Client,
  AuthenticateRequest,
  AuthenticateResponse,
  CancelNotification,
  InitializeRequest,
  InitializeResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  SessionNotification,
  StopReason,
  UnstructuredCommandInput,
} from '@agentclientprotocol/sdk';

export {
  BODHI_AUTH_METHOD_ID,
  BODHI_LIST_MODELS_METHOD,
  BODHI_LIST_SESSIONS_METHOD,
  BODHI_GET_SESSION_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
  BODHI_FEATURES_LIST_METHOD,
  BODHI_FEATURES_SET_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
} from '@bodhiapp/web-acp-agent';

export type {
  BodhiAuthenticateMeta,
  BodhiBuiltinAction,
  BodhiBuiltinCopyAction,
  BodhiBuiltinMcpAddAction,
  BodhiBuiltinMcpRemoveAction,
  AnyBodhiBuiltinAction,
  BodhiBuiltinMeta,
  BodhiBuiltinTag,
  BodhiFeatureBag,
  BodhiFeaturesListResponse,
  BodhiFeaturesSetRequest,
  BodhiFeaturesSetResponse,
  BodhiGetSessionRequest,
  BodhiGetSessionResponse,
  BodhiListModelsResponse,
  BodhiListSessionsResponse,
  BodhiMcpInstanceDescriptor,
  BodhiMcpToggleSnapshot,
  BodhiMcpTogglesSetRequest,
  BodhiMcpTogglesSetResponse,
  BodhiMcpUrlParams,
  BodhiModelDescriptor,
  BodhiSessionMeta,
  BodhiSessionSummary,
  BodhiSessionsDeleteRequest,
  BodhiSessionsDeleteResponse,
  BodhiVolumeDescriptor,
  BodhiVolumesListResponse,
} from '@bodhiapp/web-acp-agent';
