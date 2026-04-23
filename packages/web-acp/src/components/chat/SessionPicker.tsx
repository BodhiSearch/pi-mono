import { MessageSquare } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BodhiSessionSummary } from '@/acp/index';

interface SessionPickerProps {
  sessions: BodhiSessionSummary[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
}

/**
 * Left-rail picker over past ACP sessions surfaced by
 * `bodhi/listSessions`. Click handling is wired in phase C (session
 * restore); phase B keeps the picker purely informational so a reload
 * is enough to show that sessions survive.
 */
export default function SessionPicker({ sessions, activeSessionId, onSelect }: SessionPickerProps) {
  return (
    <aside
      data-testid="session-picker"
      data-testsessions={sessions.length}
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
              <li key={session.id}>
                <button
                  type="button"
                  data-testid={`session-row-${session.id}`}
                  data-sessionid={session.id}
                  data-teststate={isActive ? 'active' : 'inactive'}
                  onClick={() => onSelect(session.id)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-2 text-sm text-left hover:bg-gray-100 transition-colors',
                    isActive && 'bg-white border-l-2 border-primary font-medium'
                  )}
                >
                  <MessageSquare className="size-3.5 shrink-0 text-gray-400" />
                  <span className="truncate flex-1">{label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
