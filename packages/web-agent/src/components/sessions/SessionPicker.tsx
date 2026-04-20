/**
 * Session picker — minimal dropdown for switching, renaming, and deleting
 * persisted sessions. Wired into the chat panel header.
 *
 * Data testids used by e2e (M5 unchanged + M6 additions):
 *   - session-picker              — root (carries data-active-session-id)
 *   - session-picker-trigger      — the button that opens the list
 *   - session-picker-list         — popover content once open
 *   - session-list-item           — per-row (carries data-path=<id>,
 *                                    data-parent-session=<parentId | "">
 *                                    so e2e can assert fork relationships)
 *   - session-fork-indicator      — small icon shown on forked rows (M6)
 *   - session-new                 — "New session" button
 *   - session-rename              — in-place rename input (active-only)
 *   - session-rename-submit       — save rename
 *   - session-delete-<id>         — per-row delete button
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, GitFork, History, MessageSquarePlus, Pencil, Trash2 } from 'lucide-react';
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

/**
 * Group sessions into a flat-by-display forest: roots first (sorted by
 * `modified` desc, original order), then children of each root immediately
 * after their parent. Children are tagged with `depth: 1` so the row can
 * indent + render the fork breadcrumb. We deliberately keep the structure
 * single-level — the picker is a narrow dropdown; deeper trees flatten
 * visually but each child still labels its parent.
 */
function buildForest(list: SessionSummary[]): Array<{ summary: SessionSummary; depth: number }> {
  const byId = new Map(list.map(s => [s.id, s]));
  const childrenByParent = new Map<string, SessionSummary[]>();
  const roots: SessionSummary[] = [];
  for (const s of list) {
    const parent = s.parentSessionPath;
    if (parent && byId.has(parent)) {
      const arr = childrenByParent.get(parent) ?? [];
      arr.push(s);
      childrenByParent.set(parent, arr);
    } else {
      roots.push(s);
    }
  }
  const out: Array<{ summary: SessionSummary; depth: number }> = [];
  for (const root of roots) {
    out.push({ summary: root, depth: 0 });
    const kids = childrenByParent.get(root.id);
    if (kids) {
      for (const k of kids) out.push({ summary: k, depth: 1 });
    }
  }
  return out;
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
  onSwitch,
  onNew,
  onDelete,
  onRename,
}: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const forest = useMemo(() => buildForest(list), [list]);
  const summaryById = useMemo(() => new Map(list.map(s => [s.id, s])), [list]);

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
      className="flex min-w-0 flex-1 items-center gap-1"
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
              title="Switch or start a chat session"
              className="h-8 min-w-0 flex-1 justify-start gap-1.5 px-2 text-xs font-normal"
            >
              <History className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{displayTitle}</span>
              {list.length > 0 ? (
                <span className="ml-auto rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                  {list.length}
                </span>
              ) : null}
              <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent data-testid="session-picker-list" align="end" className="w-80 p-2">
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
                {forest.map(({ summary: s, depth }) => {
                  const active = s.id === current?.id;
                  const parent = s.parentSessionPath
                    ? summaryById.get(s.parentSessionPath)
                    : undefined;
                  return (
                    <li
                      key={s.id}
                      data-testid="session-list-item"
                      data-path={s.id}
                      data-parent-session={s.parentSessionPath ?? ''}
                      data-active={active ? 'true' : 'false'}
                      data-depth={depth}
                      className={`flex items-center gap-1 rounded px-2 py-1.5 text-xs hover:bg-accent ${
                        active ? 'bg-accent' : ''
                      } ${depth > 0 ? 'ml-4' : ''}`}
                    >
                      {depth > 0 ? (
                        <GitFork
                          data-testid="session-fork-indicator"
                          className="h-3 w-3 shrink-0 text-muted-foreground"
                          aria-label="Forked session"
                        />
                      ) : null}
                      <button
                        type="button"
                        className="min-w-0 flex-1 text-left"
                        onClick={() => void handleSwitch(s.id)}
                      >
                        <div className="truncate font-medium">{titleFor(s)}</div>
                        <div className="text-[11px] text-muted-foreground">
                          {s.messageCount} msg · {relativeTime(s.modified)}
                          {parent ? (
                            <span data-testid="session-parent-breadcrumb">
                              {' · forked from '}
                              {titleFor(parent)}
                            </span>
                          ) : null}
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
