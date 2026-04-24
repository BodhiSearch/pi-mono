import type { McpConnectionMeta, McpConnectionState, McpInstanceView } from './types';

/**
 * Main-thread MCP status panel. Renders one row per enabled instance
 * and reflects the worker's connection lifecycle reported via
 * `session/update` → `_meta.bodhi.mcp`. Each row exposes a stable
 * `data-testid="mcp-server-<slug>"` with `data-test-state` driven by
 * the latest reported state. Registered tools are mirrored as
 * `[data-testid="mcp-tool-<slug>-<tool>"]` so e2e can assert the
 * worker's `tools/list` reached the main thread.
 */
export interface McpPanelProps {
  instances: McpInstanceView[];
  states: Record<string, McpConnectionMeta>;
}

const DEFAULT_STATE: McpConnectionState = 'disconnected';

const STATE_CLASS: Record<McpConnectionState, string> = {
  disconnected: 'bg-gray-400',
  connecting: 'bg-yellow-500 animate-pulse',
  connected: 'bg-green-500',
  error: 'bg-red-500',
};

export default function McpPanel({ instances, states }: McpPanelProps) {
  const enabled = instances.filter(instance => instance.enabled);
  const connectedCount = enabled.filter(
    instance => (states[instance.slug]?.state ?? DEFAULT_STATE) === 'connected'
  ).length;
  return (
    <section
      data-testid="mcp-panel"
      data-teststate={String(connectedCount)}
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
                </div>
                {meta?.error && (
                  <span data-testid={`mcp-server-${instance.slug}-error`} className="text-red-600">
                    {meta.error}
                  </span>
                )}
                {meta?.tools && meta.tools.length > 0 && (
                  <ul
                    data-testid={`mcp-server-${instance.slug}-tools`}
                    className="ml-4 flex flex-wrap gap-1"
                  >
                    {meta.tools.map(toolName => (
                      <li
                        key={toolName}
                        data-testid={`mcp-tool-${instance.slug}-${toolName}`}
                        className="rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-gray-700 ring-1 ring-gray-200"
                      >
                        {toolName}
                      </li>
                    ))}
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
