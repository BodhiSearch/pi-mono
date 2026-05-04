import { MessageSquare, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SessionInfoView } from '@/acp/index';

interface SessionPickerProps {
  sessions: SessionInfoView[];
  activeSessionId: string | null;
  /** Cursor for the next page; `null` once the last page has loaded. */
  nextCursor?: string | null;
  onSelect: (sessionId: string) => void;
  onDelete: (sessionId: string) => void;
  onLoadMore?: () => void;
}

/**
 * Left-rail picker over past ACP sessions surfaced by `Agent.listSessions`.
 * Each row carries a hover-revealed delete affordance that flows
 * through `_bodhi/sessions/delete` (no confirmation by design).
 * Selecting a row is the parent's `onSelect`; deleting stops
 * propagation so the row click doesn't fire alongside.
 */
export default function SessionPicker({
  sessions,
  activeSessionId,
  nextCursor,
  onSelect,
  onDelete,
  onLoadMore,
}: SessionPickerProps) {
  return (
    <aside
      data-testid="session-picker"
      data-test-state={String(sessions.length)}
      className="w-64 shrink-0 border-r bg-gray-50 overflow-y-auto"
    >
      <div className="px-3 py-3 text-xs font-semibold uppercase text-gray-500 tracking-wide">
        Sessions
      </div>
      {sessions.length === 0 ? (
        <div data-testid="session-picker-empty" className="px-3 py-2 text-sm text-gray-400">
          No sessions yet
        </div>
      ) : (
        <ul className="flex flex-col">
          {sessions.map(session => {
            const label = session.title?.trim() || '(untitled)';
            const isActive = session.id === activeSessionId;
            return (
              <li
                key={session.id}
                className={cn(
                  'group relative flex items-stretch hover:bg-gray-100 transition-colors',
                  isActive && 'bg-white border-l-2 border-primary'
                )}
              >
                <button
                  type="button"
                  data-testid={`session-row-${session.id}`}
                  data-sessionid={session.id}
                  data-test-state={isActive ? 'active' : 'inactive'}
                  onClick={() => onSelect(session.id)}
                  className={cn(
                    'flex flex-1 min-w-0 items-center gap-2 px-3 py-2 pr-9 text-sm text-left',
                    isActive && 'font-medium'
                  )}
                >
                  <MessageSquare className="size-3.5 shrink-0 text-gray-400" />
                  <span className="truncate flex-1">{label}</span>
                </button>
                <button
                  type="button"
                  aria-label="Delete session"
                  title="Delete session"
                  data-testid={`session-delete-${session.id}`}
                  onClick={event => {
                    event.stopPropagation();
                    onDelete(session.id);
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center rounded p-1 text-gray-400 opacity-0 transition-opacity hover:bg-gray-200 hover:text-red-600 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      {nextCursor && onLoadMore ? (
        <div className="px-3 py-2">
          <button
            type="button"
            data-testid="session-picker-load-more"
            onClick={onLoadMore}
            className="w-full text-xs text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded px-2 py-1.5 transition-colors"
          >
            Load more
          </button>
        </div>
      ) : null}
    </aside>
  );
}
