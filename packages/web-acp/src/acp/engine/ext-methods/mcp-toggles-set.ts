import {
  BODHI_MCP_TOGGLES_SET_METHOD,
  type BodhiMcpTogglesSetRequest,
  type BodhiMcpTogglesSetResponse,
} from '../../index';
import { toWireMcpToggles } from '../../wire-utils';
import type { ExtMethodHost } from '../types';

export async function mcpTogglesSet(
  params: unknown,
  host: ExtMethodHost
): Promise<BodhiMcpTogglesSetResponse> {
  if (!host.mcpToggles) {
    throw new Error(`${BODHI_MCP_TOGGLES_SET_METHOD}: mcp toggle store unavailable`);
  }
  const req = params as BodhiMcpTogglesSetRequest;
  if (
    !req ||
    typeof req.sessionId !== 'string' ||
    typeof req.serverSlug !== 'string' ||
    typeof req.value !== 'boolean'
  ) {
    throw new Error(
      `${BODHI_MCP_TOGGLES_SET_METHOD}: params must be { sessionId, serverSlug, toolName?, value: boolean }`
    );
  }
  const next = req.toolName
    ? await host.mcpToggles.setTool(req.sessionId, req.serverSlug, req.toolName, req.value)
    : await host.mcpToggles.setServer(req.sessionId, req.serverSlug, req.value);
  return { toggles: toWireMcpToggles(next) };
}
