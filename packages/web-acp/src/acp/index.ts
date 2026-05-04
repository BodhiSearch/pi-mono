// Host-side ACP barrel. Re-exports the Bodhi wire surface from
// `@bodhiapp/web-acp-agent`; SDK types are imported directly at call sites.

export {
  EMPTY_AVAILABLE_COMMANDS,
  EMPTY_CONFIG_OPTIONS,
  EMPTY_MCP_STATES,
  EMPTY_MCP_TOGGLES,
} from './empty-sentinels';

export {
  BODHI_AUTH_METHOD_ID,
  BODHI_BUILTIN_ACTION_NOTIFICATION_METHOD,
  BODHI_FEATURE_BASH_ENABLED_CONFIG_ID,
  BODHI_FEATURE_FORCE_TOOL_CALL_CONFIG_ID,
  BODHI_MCP_STATE_NOTIFICATION_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
} from '@bodhiapp/web-acp-agent';

export type {
  BodhiAuthenticateMeta,
  AnyBodhiBuiltinAction,
  BodhiBuiltinTag,
  BodhiLoadSessionMeta,
  BodhiMcpInstanceDescriptor,
  BodhiMcpTogglesSetResponse,
  BodhiSessionInfoMeta,
  BodhiSessionMeta,
  BodhiSessionsDeleteResponse,
} from '@bodhiapp/web-acp-agent';

/** Flattened `SessionInfo` + `_meta.bodhi` view with numeric timestamps. */
export interface SessionInfoView {
  id: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
  turnCount: number;
  lastModelId: string | null;
}
