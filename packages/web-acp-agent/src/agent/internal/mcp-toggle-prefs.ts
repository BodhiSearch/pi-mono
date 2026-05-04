import { isMcpToggleSnapshot, type McpToggleSnapshot } from '../../storage/mcp-toggle-shape';
import type { PreferenceStore } from '../../storage/preference-store';

const KEY = 'mcp:toggles';

function clone(snapshot: McpToggleSnapshot): McpToggleSnapshot {
  return {
    servers: { ...snapshot.servers },
    tools: Object.fromEntries(Object.entries(snapshot.tools).map(([slug, m]) => [slug, { ...m }])),
  };
}

export async function readMcpToggles(
  prefs: PreferenceStore,
  sessionId: string
): Promise<McpToggleSnapshot> {
  const value = await prefs.get(sessionId, KEY);
  return isMcpToggleSnapshot(value) ? clone(value) : { servers: {}, tools: {} };
}

export async function setMcpServerToggle(
  prefs: PreferenceStore,
  sessionId: string,
  serverSlug: string,
  value: boolean
): Promise<McpToggleSnapshot> {
  const current = await readMcpToggles(prefs, sessionId);
  const next: McpToggleSnapshot = {
    servers: { ...current.servers, [serverSlug]: value },
    tools: current.tools,
  };
  await prefs.set(sessionId, KEY, next);
  return clone(next);
}

export async function setMcpToolToggle(
  prefs: PreferenceStore,
  sessionId: string,
  serverSlug: string,
  toolName: string,
  value: boolean
): Promise<McpToggleSnapshot> {
  const current = await readMcpToggles(prefs, sessionId);
  const perServer = { ...(current.tools[serverSlug] ?? {}), [toolName]: value };
  const next: McpToggleSnapshot = {
    servers: { ...current.servers },
    tools: { ...current.tools, [serverSlug]: perServer },
  };
  await prefs.set(sessionId, KEY, next);
  return clone(next);
}
