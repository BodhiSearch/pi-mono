import type { McpToggleSnapshot } from './compose-mcp-servers';
import type { McpConnectionMeta, McpConnectionState, McpInstanceView } from './types';

/**
 * Main-thread MCP status panel. Renders one row per enabled instance
 * and reflects the worker's connection lifecycle reported via
 * `session/update` → `_meta.bodhi.mcp`. Each row exposes a stable
 * `data-testid="mcp-server-<slug>"` with `data-test-state` driven by
 * the latest reported state. Registered tools are mirrored as
 * `[data-testid="mcp-tool-<slug>-<tool>"]` so e2e can assert the
 * worker's `tools/list` reached the main thread.
 *
 * Per-session toggles add two extra data-testids on each row:
 *
 * - `[data-testid="mcp-session-server-<slug>"]` with
 *   `data-test-state="on|off"` for the per-server flag.
 * - `[data-testid="mcp-session-tool-<slug>-<tool>"]` with the same
 *   state attr for each per-tool flag.
 *
 * Writes land on `AcpClient.setMcpToggle` via `onSetToggle`. Absence
 * of `onSetToggle` (e.g. pre-session mount) downgrades the panel to
 * read-only — status still renders but the checkboxes are disabled.
 */
export interface McpPanelProps {
  instances: McpInstanceView[];
  states: Record<string, McpConnectionMeta>;
  toggles?: McpToggleSnapshot;
  onSetToggle?: (serverSlug: string, value: boolean, toolName?: string) => void;
}

const DEFAULT_STATE: McpConnectionState = 'disconnected';

const STATE_CLASS: Record<McpConnectionState, string> = {
  disconnected: 'bg-gray-400',
  connecting: 'bg-yellow-500 animate-pulse',
  connected: 'bg-green-500',
  error: 'bg-red-500',
};

function serverEnabled(toggles: McpToggleSnapshot | undefined, slug: string): boolean {
  if (!toggles) return true;
  return toggles.servers[slug] !== false;
}

function toolEnabled(
  toggles: McpToggleSnapshot | undefined,
  slug: string,
  toolName: string
): boolean {
  if (!toggles) return true;
  const perServer = toggles.tools[slug];
  if (!perServer) return true;
  return perServer[toolName] !== false;
}

export default function McpPanel({ instances, states, toggles, onSetToggle }: McpPanelProps) {
  const enabled = instances.filter(instance => instance.enabled);
  const connectedCount = enabled.filter(
    instance => (states[instance.slug]?.state ?? DEFAULT_STATE) === 'connected'
  ).length;
  const canToggle = !!onSetToggle;
  return (
    <section
      data-testid="mcp-panel"
      data-test-state={String(connectedCount)}
      className="border-b bg-gray-50"
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">MCP servers</h2>
        <span className="text-[10px] text-gray-500">
          {connectedCount}/{enabled.length} connected
        </span>
      </header>
      {enabled.length === 0 ? (
        <p data-testid="mcp-panel-empty" className="px-3 pb-2 text-xs text-gray-500">
          No MCP instances enabled.
        </p>
      ) : (
        <ul className="flex flex-col pb-2">
          {enabled.map(instance => {
            const meta = states[instance.slug];
            const state = meta?.state ?? DEFAULT_STATE;
            const serverOn = serverEnabled(toggles, instance.slug);
            return (
              <li
                key={instance.slug}
                data-testid={`mcp-server-${instance.slug}`}
                data-test-state={state}
                className="flex flex-col gap-1 px-3 py-1.5 text-xs"
              >
                <div className="flex items-center gap-2">
                  <span
                    data-testid={`mcp-server-${instance.slug}-dot`}
                    className={`inline-block size-2 rounded-full ${STATE_CLASS[state]}`}
                  />
                  <span className="font-medium text-gray-700">{instance.name}</span>
                  <span className="text-[10px] text-gray-500">({instance.slug})</span>
                  <label
                    data-testid={`mcp-session-server-${instance.slug}`}
                    data-test-state={serverOn ? 'on' : 'off'}
                    className="ml-auto flex items-center gap-1 text-[10px] text-gray-600"
                  >
                    <input
                      type="checkbox"
                      checked={serverOn}
                      disabled={!canToggle}
                      onChange={e => onSetToggle?.(instance.slug, e.currentTarget.checked)}
                    />
                    <span>{serverOn ? 'on' : 'off'}</span>
                  </label>
                </div>
                {meta?.error && (
                  <span data-testid={`mcp-server-${instance.slug}-error`} className="text-red-600">
                    {meta.error}
                  </span>
                )}
                {meta?.tools && meta.tools.length > 0 && (
                  <ul
                    data-testid={`mcp-server-${instance.slug}-tools`}
                    className="ml-4 flex flex-col gap-0.5"
                  >
                    {meta.tools.map(toolName => {
                      const toolOn = toolEnabled(toggles, instance.slug, toolName);
                      return (
                        <li
                          key={toolName}
                          data-testid={`mcp-tool-${instance.slug}-${toolName}`}
                          className="flex items-center gap-2 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-gray-700 ring-1 ring-gray-200"
                        >
                          <span>{toolName}</span>
                          <label
                            data-testid={`mcp-session-tool-${instance.slug}-${toolName}`}
                            data-test-state={toolOn && serverOn ? 'on' : 'off'}
                            className="ml-auto flex items-center gap-1 text-[10px] text-gray-600"
                          >
                            <input
                              type="checkbox"
                              checked={toolOn}
                              disabled={!canToggle || !serverOn}
                              onChange={e =>
                                onSetToggle?.(instance.slug, e.currentTarget.checked, toolName)
                              }
                            />
                            <span>{toolOn ? 'on' : 'off'}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
