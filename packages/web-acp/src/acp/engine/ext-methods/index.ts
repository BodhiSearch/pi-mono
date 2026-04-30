import {
  BODHI_FEATURES_LIST_METHOD,
  BODHI_FEATURES_SET_METHOD,
  BODHI_GET_SESSION_METHOD,
  BODHI_LIST_MODELS_METHOD,
  BODHI_LIST_SESSIONS_METHOD,
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
} from '../../index';
import type { ExtMethodHost } from '../types';
import { featuresList } from './features-list';
import { featuresSet } from './features-set';
import { getSession } from './get-session';
import { listModels } from './list-models';
import { listSessions } from './list-sessions';
import { mcpTogglesSet } from './mcp-toggles-set';
import { sessionsDelete } from './sessions-delete';
import { volumesList } from './volumes-list';

export type ExtMethodHandler = (
  params: unknown,
  host: ExtMethodHost
) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, ExtMethodHandler> = {
  [BODHI_LIST_MODELS_METHOD]: listModels,
  [BODHI_LIST_SESSIONS_METHOD]: listSessions,
  [BODHI_VOLUMES_LIST_METHOD]: volumesList,
  [BODHI_FEATURES_LIST_METHOD]: featuresList,
  [BODHI_FEATURES_SET_METHOD]: featuresSet,
  [BODHI_GET_SESSION_METHOD]: getSession,
  [BODHI_MCP_TOGGLES_SET_METHOD]: mcpTogglesSet,
  [BODHI_SESSIONS_DELETE_METHOD]: sessionsDelete,
};

export async function dispatchExtMethod(
  method: string,
  params: unknown,
  host: ExtMethodHost
): Promise<Record<string, unknown>> {
  const handler = HANDLERS[method];
  if (!handler) {
    throw new Error(`Unknown extension method: ${method}`);
  }
  return handler(params, host);
}
