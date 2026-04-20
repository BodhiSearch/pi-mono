/**
 * Session picker — minimal dropdown for switching, renaming, and deleting
 * persisted sessions. Wired into the chat panel header.
 *
 * Data testids used by e2e:
 *   - session-picker              — root (carries data-active-session-id)
 *   - session-picker-trigger      — the button that opens the list
 *   - session-picker-list         — popover content once open
 *   - session-list-item           — per-row (carries data-path=<id>)
 *   - session-new                 — "New session" button
 *   - session-rename              — in-place rename input (active-only)
 *   - session-rename-submit       — save rename
 *   - session-delete-<id>         — per-row delete button
 */

import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { SessionSummary } from '@/web-agent';

interface ActiveSession {
  id: string;
  name?: string;
}

interface SessionPickerProps {
  current: ActiveSession | null;
  list: SessionSummary[];
  onRefresh: () => Promise<void>;
  onSwitch: (id: string) => Promise<void>;
  onNew: () => Promise<string>;
  onDelete: (id: string) => Promise<void>;
  onRename: (name: string) => Promise<void>;
}

function titleFor(summary: SessionSummary): string {
  if (summary.name) return summary.name;
  if (summary.firstMessage && summary.firstMessage !== '(no messages)') {
    const trimmed = summary.firstMessage.trim();
    return trimmed.length > 40 ? `${trimmed.slice(0, 37)}…` : trimmed;
  }
  return 'Untitled session';
}

function relativeTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '';
  const diff = Date.now() - t;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function SessionPicker({
  current,
  list,
  onRefresh,
  onSwitch,
  onNew,
  onDelete,
  onRename,
}: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Pull a fresh summary list whenever the popover opens.
  useEffect(() => {
    if (!open) return;
    void onRefresh();
  }, [open, onRefresh]);

  useEffect(() => {
    if (isRenaming) {
      requestAnimationFrame(() => renameInputRef.current?.focus());
    }
  }, [isRenaming]);

  const currentTitle = current
    ? current.name || (list.find(s => s.id === current.id)?.firstMessage ?? 'New chat')
    : 'New chat';
  const displayTitle = currentTitle === '(no messages)' ? 'New chat' : currentTitle;

  const handleNew = async () => {
    try {
      await onNew();
    } finally {
      setOpen(false);
    }
  };

  const handleSwitch = async (id: string) => {
    if (current?.id === id) {
      setOpen(false);
      return;
    }
    try {
      await onSwitch(id);
    } finally {
      setOpen(false);
    }
  };

  const startRename = () => {
    setRenameValue(current?.name ?? '');
    setIsRenaming(true);
  };

  const commitRename = async () => {
    const name = renameValue.trim();
    setIsRenaming(false);
    if (!name) return;
    await onRename(name);
  };

  const handleDelete = async (id: string) => {
    await onDelete(id);
  };

  return (
    <div
      data-testid="session-picker"
      data-active-session-id={current?.id ?? ''}
      className="flex items-center gap-2"
    >
      {isRenaming ? (
        <form
          className="flex items-center gap-1"
          onSubmit={e => {
            e.preventDefault();
            void commitRename();
          }}
        >
          <Input
            data-testid="session-rename"
            ref={renameInputRef}
            value={renameValue}
            onChange={e => setRenameValue(e.target.value)}
            onBlur={() => void commitRename()}
            className="h-7 w-48 text-xs"
            placeholder="Name this chat"
          />
          <Button data-testid="session-rename-submit" type="submit" size="sm" variant="ghost">
            Save
          </Button>
        </form>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button
              data-testid="session-picker-trigger"
              variant="outline"
              size="sm"
              className="h-7 max-w-[18rem] justify-start gap-1 text-xs font-normal"
            >
              <span className="truncate">{displayTitle}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent data-testid="session-picker-list" align="start" className="w-80 p-2">
            <div className="flex items-center justify-between pb-1">
              <span className="text-xs font-semibold text-muted-foreground">Sessions</span>
              <Button
                data-testid="session-new"
                variant="ghost"
                size="sm"
                onClick={() => void handleNew()}
                className="gap-1 text-xs"
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
                New
              </Button>
            </div>
            {list.length === 0 ? (
              <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                No sessions yet — your next reply is saved automatically.
              </p>
            ) : (
              <ul className="max-h-64 space-y-1 overflow-auto">
                {list.map(s => {
                  const active = s.id === current?.id;
                  return (
                    <li
                      key={s.id}
                      data-testid="session-list-item"
                      data-path={s.id}
                      data-active={active ? 'true' : 'false'}
                      className={`flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-accent ${
                        active ? 'bg-accent' : ''
                      }`}
                    >
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => void handleSwitch(s.id)}
                      >
                        <div className="truncate font-medium">{titleFor(s)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {s.messageCount} msg · {relativeTime(s.modified)}
                        </div>
                      </button>
                      <Button
                        data-testid={`session-delete-${s.id}`}
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6"
                        title="Delete session"
                        onClick={e => {
                          e.stopPropagation();
                          void handleDelete(s.id);
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      )}

      {current && !isRenaming ? (
        <Button
          data-testid="session-rename-trigger"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={startRename}
          title="Rename session"
        >
          <Pencil className="h-3 w-3" />
        </Button>
      ) : null}
    </div>
  );
}
