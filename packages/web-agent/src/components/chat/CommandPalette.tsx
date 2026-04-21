/**
 * Slash-command autocomplete palette.
 *
 * Rendered inline by `ChatInput` while the user is typing a `/` prefix.
 * Unlike `ModelCombobox` this is not a Radix Popover — the text input
 * stays focused and owns keyboard input, so the palette is a plain
 * absolutely-positioned list. `ChatInput`'s `onKeyDown` forwards
 * navigation keys (ArrowUp/Down, Enter, Tab, Escape) to `onKey`.
 */

import { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import type { SlashCommandInfo } from '@/worker-agent';

export interface CommandPaletteHandle {
  /**
   * Forward a keyboard event from the text input. Returns `true` if the
   * palette consumed the key (caller should call `preventDefault`), or
   * `false` to let the input handle it.
   */
  handleKey: (event: KeyboardEvent | React.KeyboardEvent) => boolean;
}

interface CommandPaletteProps {
  /** Pre-filtered commands to display (already matched against the prefix). */
  commands: SlashCommandInfo[];
  open: boolean;
  /** Called when the user selects (Enter / Tab / click) a command. */
  onSelect: (command: SlashCommandInfo) => void;
  /** Called when the palette asks to close (Escape). */
  onClose: () => void;
}

const CommandPalette = forwardRef<CommandPaletteHandle, CommandPaletteProps>(
  function CommandPalette({ commands, open, onSelect, onClose }, ref) {
    const [activeIndex, setActiveIndex] = useState(0);
    const containerRef = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
      setActiveIndex(0);
    }, [commands]);

    // Scroll the active option into view when keyboard-nav drives it off-screen.
    useEffect(() => {
      const list = containerRef.current;
      if (!list) return;
      const active = list.querySelector<HTMLElement>(`[data-active-option="true"]`);
      active?.scrollIntoView({ block: 'nearest' });
    }, [activeIndex]);

    useImperativeHandle(
      ref,
      () => ({
        handleKey(event) {
          if (!open) return false;
          switch (event.key) {
            case 'ArrowDown':
              setActiveIndex(i => (commands.length === 0 ? 0 : (i + 1) % commands.length));
              return true;
            case 'ArrowUp':
              setActiveIndex(i =>
                commands.length === 0 ? 0 : (i - 1 + commands.length) % commands.length
              );
              return true;
            case 'Enter':
            case 'Tab': {
              const choice = commands[activeIndex];
              if (choice) {
                onSelect(choice);
                return true;
              }
              return false;
            }
            case 'Escape':
              onClose();
              return true;
            default:
              return false;
          }
        },
      }),
      [open, commands, activeIndex, onSelect, onClose]
    );

    if (!open) {
      return (
        <div
          data-testid="command-palette"
          data-test-state="closed"
          className="hidden"
          aria-hidden
        />
      );
    }

    return (
      <div
        data-testid="command-palette"
        data-test-state="open"
        role="listbox"
        aria-label="Slash commands"
        className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-2rem)] max-h-64 overflow-y-auto rounded-2xl border border-gray-200 bg-white shadow-lg z-50"
        ref={containerRef}
      >
        {commands.length === 0 ? (
          <div
            data-testid="command-palette-empty"
            className="px-3 py-2 text-sm text-muted-foreground"
          >
            No matching commands
          </div>
        ) : (
          <ul className="py-1">
            {commands.map((cmd, idx) => {
              const isActive = idx === activeIndex;
              return (
                <li key={`${cmd.source}:${cmd.name}`}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-testid={`command-option-${cmd.name}`}
                    data-active-option={isActive ? 'true' : 'false'}
                    data-command-source={cmd.source}
                    onMouseDown={e => {
                      // Prevent the input from losing focus before onSelect fires.
                      e.preventDefault();
                    }}
                    onClick={() => onSelect(cmd)}
                    className={cn(
                      'flex w-full items-start gap-2 px-3 py-2 text-left text-sm hover:bg-accent',
                      isActive && 'bg-accent'
                    )}
                  >
                    <span className="font-mono text-sm text-primary shrink-0">/{cmd.name}</span>
                    {cmd.argumentHint && (
                      <span className="text-xs text-muted-foreground shrink-0">
                        {cmd.argumentHint}
                      </span>
                    )}
                    {cmd.description && (
                      <span className="text-xs text-muted-foreground truncate flex-1">
                        {cmd.description}
                      </span>
                    )}
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground shrink-0">
                      {cmd.source}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    );
  }
);

export default CommandPalette;
