/**
 * Chat-header slot that surfaces the extension-contributed title.
 *
 * Data flow:
 *   `pi.ui.setTitle(text)` → worker `ExtensionUIController`
 *   → RPC `extension_ui_request { kind: 'setTitle' }`
 *   → `useExtensionUI().title` (most-recent non-null wins; null entries
 *     are removed).
 *
 * The slot renders nothing when no extension has set a title, so the
 * regular header copy remains untouched. Consumers decide where to
 * mount the slot (usually next to the agent name).
 */

import { cn } from '@/lib/utils';

export interface ExtensionTitleSlotProps {
  title: string | null;
  extensionPath: string | null;
  className?: string;
}

export default function ExtensionTitleSlot({
  title,
  extensionPath,
  className,
}: ExtensionTitleSlotProps) {
  if (title === null || extensionPath === null) return null;
  return (
    <span
      data-testid="extension-title"
      data-extension-path={extensionPath}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[11px] font-medium text-muted-foreground',
        className
      )}
    >
      {title}
    </span>
  );
}
