import {
  BODHI_MCP_TOGGLES_SET_METHOD,
  type BodhiMcpTogglesSetRequest,
  type BodhiMcpTogglesSetResponse,
} from '../../../wire';
import { setMcpServerToggle, setMcpToolToggle } from '../../../agent/internal/mcp-toggle-prefs';
import { deriveSlugFromUrl } from '../../../mcp/url-canonical';
import { toWireMcpToggles } from '../../wire-utils';
import type { ExtMethodHost } from '../types';

export async function mcpTogglesSet(
  params: unknown,
  host: ExtMethodHost
): Promise<BodhiMcpTogglesSetResponse> {
  if (!host.preferences) {
    throw new Error(`${BODHI_MCP_TOGGLES_SET_METHOD}: preference store unavailable`);
  }
  const req = params as BodhiMcpTogglesSetRequest;
  // Redundant with dispatcher schema; kept for direct-invoke callers.
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
    ? await setMcpToolToggle(
        host.preferences,
        req.sessionId,
        req.serverSlug,
        req.toolName,
        req.value
      )
    : await setMcpServerToggle(host.preferences, req.sessionId, req.serverSlug, req.value);
  // Server-off forces pool eviction across refcounts — forgotten sessions
  // can hold stale refs that keep the connection alive globally. Live
  // sessions sharing the entry reconnect on next `session/load`. Per-tool
  // toggles only filter the tool list and never touch the pool.
  if (!req.toolName && req.value === false) {
    try {
      await host.mcpPool.evictBySlug(req.serverSlug, deriveSlugFromUrl);
    } catch (err) {
      console.warn(
        `[mcp-toggles-set] explicit pool eviction for slug '${req.serverSlug}' failed:`,
        err
      );
    }
  }
  return { toggles: toWireMcpToggles(next) };
}
