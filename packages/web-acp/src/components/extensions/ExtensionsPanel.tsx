import type { BodhiExtensionDescriptor } from '@/acp/index';

export interface ExtensionsPanelProps {
  entries: BodhiExtensionDescriptor[];
}

export default function ExtensionsPanel({ entries }: ExtensionsPanelProps) {
  return (
    <section
      data-testid="extensions-panel"
      data-test-state={String(entries.length)}
      className="border-b bg-gray-50"
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Extensions</h2>
      </header>
      {entries.length === 0 ? (
        <div data-testid="extensions-panel-empty" className="px-3 pb-3 text-xs text-gray-400">
          No extensions installed.
        </div>
      ) : (
        <ul className="flex flex-col">
          {entries.map(ext => (
            <li
              key={ext.name}
              data-testid={`extension-row-${ext.name}`}
              data-test-state={ext.mountName}
              className="flex items-start gap-2 border-t px-3 py-2 first:border-t-0"
            >
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-800">{ext.name}</div>
                <div className="font-mono text-[10px] text-gray-500 truncate">
                  /mnt/{ext.mountName}
                </div>
                {ext.capabilities.events.length > 0 ? (
                  <ul
                    data-testid={`extension-row-${ext.name}-events`}
                    data-test-state={String(ext.capabilities.events.length)}
                    className="mt-1 flex flex-wrap gap-1"
                  >
                    {ext.capabilities.events.map(event => (
                      <li
                        key={event}
                        data-testid={`extension-row-${ext.name}-event-${event}`}
                        className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-700"
                      >
                        {event}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
