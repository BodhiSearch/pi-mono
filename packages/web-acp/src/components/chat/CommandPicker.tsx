import { useEffect, useMemo, useRef, useState } from 'react';
import type { AvailableCommand } from '@agentclientprotocol/sdk';

interface CommandPickerProps {
  open: boolean;
  query: string;
  commands: readonly AvailableCommand[];
  onSelect: (command: AvailableCommand) => void;
  onDismiss: () => void;
}

/**
 * Headless slash-command picker. Filters `commands` by the running
 * query (the text after the leading `/` in the chat input), supports
 * keyboard navigation via window-level listeners while open, and
 * exposes deterministic `data-testid` / `data-test-state` hooks for
 * Playwright. Visual chrome is intentionally minimal — the picker
 * lives directly above the chat input.
 */
export default function CommandPicker({
  open,
  query,
  commands,
  onSelect,
  onDismiss,
}: CommandPickerProps) {
  const [rawHighlight, setHighlight] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query]);
  const highlight = filtered.length === 0 ? 0 : Math.min(rawHighlight, filtered.length - 1);
  const state = !open ? 'closed' : filtered.length === 0 ? 'empty' : 'open';

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDismiss();
        return;
      }
      if (filtered.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight(idx => (idx + 1) % filtered.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight(idx => (idx - 1 + filtered.length) % filtered.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        const cmd = filtered[highlight];
        if (cmd) onSelect(cmd);
        return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [open, filtered, highlight, onSelect, onDismiss]);

  if (!open) {
    return (
      <div
        data-testid="command-picker"
        data-test-state="closed"
        ref={containerRef}
        className="hidden"
      />
    );
  }

  return (
    <div
      data-testid="command-picker"
      data-test-state={state}
      ref={containerRef}
      className="absolute bottom-full left-0 right-0 mb-2 max-h-64 overflow-y-auto rounded-lg border border-gray-200 bg-white shadow-lg"
    >
      {filtered.length === 0 ? (
        <div data-testid="command-picker-empty" className="px-3 py-2 text-sm text-gray-500">
          No commands match
        </div>
      ) : (
        <ul className="py-1">
          {filtered.map((cmd, idx) => (
            <li
              key={cmd.name}
              data-testid={`command-picker-item-${cmd.name}`}
              data-test-state={idx === highlight ? 'highlighted' : 'idle'}
              className={`flex flex-col px-3 py-2 cursor-pointer ${
                idx === highlight ? 'bg-blue-50' : 'hover:bg-gray-50'
              }`}
              onMouseDown={e => {
                e.preventDefault();
                onSelect(cmd);
              }}
              onMouseEnter={() => setHighlight(idx)}
            >
              <span className="font-mono text-sm text-gray-900">/{cmd.name}</span>
              <span className="text-xs text-gray-600">
                {cmd.description}
                {cmd.input?.hint ? ` · ${cmd.input.hint}` : ''}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function filterCommands(commands: readonly AvailableCommand[], query: string): AvailableCommand[] {
  if (query.length === 0) return [...commands];
  const lower = query.toLowerCase();
  return commands.filter(cmd => cmd.name.toLowerCase().startsWith(lower));
}
