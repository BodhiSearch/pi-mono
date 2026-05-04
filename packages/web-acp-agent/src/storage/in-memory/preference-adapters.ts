// Bridge adapters used by the host integration test in
// `packages/web-acp/src/runtime/storage-dexie/agent-adapter.test.ts`
// to drive the legacy MCP toggle ext-method end-to-end against a real
// `PreferenceStore`. Production code does NOT use these — the engine
// reads/writes through `agent/internal/{feature,mcp-toggle}-prefs.ts`
// directly. Kept here so the integration test can simulate the full
// `_bodhi/mcp/toggles/set` round-trip without re-deriving wire shapes.
import {
  setMcpServerToggle,
  setMcpToolToggle,
  readMcpToggles,
} from '../../agent/internal/mcp-toggle-prefs';
import type { McpToggleSnapshot } from '../mcp-toggle-shape';
import type { PreferenceStore } from '../preference-store';

export interface McpToggleAdapter {
  get(sessionId: string): Promise<McpToggleSnapshot>;
  setServer(sessionId: string, serverSlug: string, value: boolean): Promise<McpToggleSnapshot>;
  setTool(
    sessionId: string,
    serverSlug: string,
    toolName: string,
    value: boolean
  ): Promise<McpToggleSnapshot>;
  clear(sessionId: string): Promise<void>;
}

export function mcpToggleStoreOverPreferences(prefs: PreferenceStore): McpToggleAdapter {
  return {
    get(sessionId) {
      return readMcpToggles(prefs, sessionId);
    },
    setServer(sessionId, serverSlug, value) {
      return setMcpServerToggle(prefs, sessionId, serverSlug, value);
    },
    setTool(sessionId, serverSlug, toolName, value) {
      return setMcpToolToggle(prefs, sessionId, serverSlug, toolName, value);
    },
    async clear(sessionId) {
      await prefs.delete(sessionId, 'mcp:toggles');
    },
  };
}
