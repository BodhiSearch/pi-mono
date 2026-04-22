/**
 * Row of per-extension status chips driven by `pi.ui.setStatus(text)`.
 *
 * Rendered in `ChatInput`'s footer so extension-authored progress
 * information sits next to the agent's own streaming state. The chip
 * list comes from `useExtensionUI().statusChips`; `setStatus(null)`
 * clears the entry, so an empty map renders nothing.
 */

import { cn } from '@/lib/utils';

export interface ExtensionStatusChipsProps {
  statusChips: Record<string, string>;
  className?: string;
}

export default function ExtensionStatusChips({
  statusChips,
  className,
}: ExtensionStatusChipsProps) {
  const entries = Object.entries(statusChips);
  if (entries.length === 0) return null;
  return (
    <div
      data-testid="extension-status-chips"
      className={cn('flex flex-wrap items-center gap-1.5', className)}
    >
      {entries.map(([path, text]) => {
        const label = path === 'anonymous' ? 'extension' : path.split('/').pop() || path;
        return (
          <span
            key={path}
            data-testid="extension-status-chip"
            data-extension-path={path}
            className="inline-flex items-center gap-1 rounded-full bg-muted/70 px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground/80">·</span>
            <span>{text}</span>
          </span>
        );
      })}
    </div>
  );
}
