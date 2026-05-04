import {
  BODHI_MCP_TOGGLES_SET_METHOD,
  BODHI_SESSIONS_DELETE_METHOD,
  BODHI_VOLUMES_LIST_METHOD,
} from '../../../wire';
import type { ExtMethodHost } from '../types';
import { mcpTogglesSet } from './mcp-toggles-set';
import { EXT_METHOD_SCHEMAS } from './schemas';
import { sessionsDelete } from './sessions-delete';
import { volumesList } from './volumes-list';

export type ExtMethodHandler = (
  params: unknown,
  host: ExtMethodHost
) => Promise<Record<string, unknown>>;

const HANDLERS: Record<string, ExtMethodHandler> = {
  [BODHI_VOLUMES_LIST_METHOD]: volumesList,
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
    const err = new Error(`Method not found: ${method}`);
    (err as unknown as { code: number }).code = -32601;
    throw err;
  }
  const schema = EXT_METHOD_SCHEMAS[method];
  if (schema) {
    const result = schema.safeParse(params);
    if (!result.success) {
      const err = new Error(`${method}: invalid params (${result.error.message})`);
      (err as unknown as { code: number }).code = -32602;
      throw err;
    }
    return handler(result.data, host);
  }
  return handler(params, host);
}
