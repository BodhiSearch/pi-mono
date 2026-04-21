/**
 * Main-thread UI for the M8 extension runtime.
 *
 * Provides the per-extension enabled toggle (`enable_ui = per_ext_toggle`)
 * and a global "Disable all" trip-switch that satisfies the M8 gate.
 * Broken extensions render with their load error inline; runtime errors
 * are surfaced as ephemeral banners via the `errors` prop so users don't
 * lose them when they toggle another extension.
 *
 * Data-testid conventions follow the playwright skill:
 * - `extensions-popover-trigger`, `extensions-popover-content`
 * - `extensions-row-<name>`, `extensions-toggle-<name>`
 * - `extensions-disable-all`, `extensions-badge`
 * - `extensions-empty-state`, `extensions-error-<path>`
 */

import { useMemo } from 'react';
import { Puzzle, AlertTriangle, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExtensionDescriptor, ExtensionError } from '@/worker-agent';
import type { ExtensionEnabledMap } from '@/extension-store/ExtensionStore';

interface ExtensionsPanelProps {
  extensions: ExtensionDescriptor[];
  enabledMap: ExtensionEnabledMap;
  errors: ExtensionError[];
  onToggle: (name: string, enabled: boolean) => void;
  onDisableAll: () => void;
  onClearErrors: () => void;
}

function isEnabled(map: ExtensionEnabledMap, name: string): boolean {
  // Defaulting absent entries to `true` matches the hook's reconciliation
  // logic — new extensions are opt-out rather than opt-in.
  return map[name] ?? true;
}

export default function ExtensionsPanel({
  extensions,
  enabledMap,
  errors,
  onToggle,
  onDisableAll,
  onClearErrors,
}: ExtensionsPanelProps) {
  const enabledCount = useMemo(
    () => extensions.filter(e => e.loaded && isEnabled(enabledMap, e.name)).length,
    [extensions, enabledMap]
  );
  const hasBroken = extensions.some(e => !!e.error);
  const hasAny = extensions.length > 0;
  const hasErrors = errors.length > 0;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          data-testid="extensions-popover-trigger"
          data-test-state={hasBroken || hasErrors ? 'error' : enabledCount > 0 ? 'active' : 'idle'}
          variant="ghost"
          size="icon"
          className="relative"
          title="Extensions"
        >
          <Puzzle className="size-4" />
          {enabledCount > 0 && (
            <span
              data-testid="extensions-badge"
              className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[10px] bg-emerald-500 text-white rounded-full flex items-center justify-center"
            >
              {enabledCount}
            </span>
          )}
          {(hasBroken || hasErrors) && (
            <span
              data-testid="extensions-error-indicator"
              className="absolute -bottom-1 -right-1 h-3 w-3 bg-destructive rounded-full flex items-center justify-center"
              aria-label="Extension errors present"
            />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        data-testid="extensions-popover-content"
        className="w-80 p-2"
        align="start"
        side="top"
      >
        <div className="flex items-center justify-between px-1 pb-1">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Extensions
          </span>
          {hasAny && (
            <Button
              data-testid="extensions-disable-all"
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={onDisableAll}
              disabled={enabledCount === 0}
              title="Disable every loaded extension"
            >
              Disable all
            </Button>
          )}
        </div>

        {hasErrors && (
          <div
            data-testid="extensions-runtime-errors"
            className="rounded-md border border-destructive/40 bg-destructive/5 p-2 mb-2 space-y-1"
          >
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-xs font-medium text-destructive">
                <AlertTriangle className="size-3" /> Runtime errors
              </span>
              <button
                data-testid="extensions-clear-errors"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={onClearErrors}
                aria-label="Clear extension errors"
              >
                <X className="size-3" />
              </button>
            </div>
            <ul className="space-y-1 text-[11px] text-destructive">
              {errors.map((err, idx) => (
                <li
                  key={`${err.extensionPath}:${err.event}:${idx}`}
                  data-testid={`extensions-runtime-error-${idx}`}
                >
                  <span className="font-mono">{err.extensionPath}</span> — {err.event}:{' '}
                  <span className="opacity-80">{err.error}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {!hasAny ? (
          <p data-testid="extensions-empty-state" className="text-sm text-muted-foreground p-2">
            No extensions discovered
          </p>
        ) : (
          <div className="space-y-1">
            {extensions.map(ext => {
              const enabled = isEnabled(enabledMap, ext.name);
              const broken = !!ext.error;
              // `data-test-state` reflects the worker's authoritative
              // view (`ext.loaded`) rather than the optimistic
              // `enabledMap` — tests assert on this attribute to
              // synchronise with extension reload round-trips. Broken
              // extensions always surface as 'broken'.
              const rowState: 'broken' | 'enabled' | 'disabled' = broken
                ? 'broken'
                : ext.loaded
                  ? 'enabled'
                  : 'disabled';
              const row = (
                <div
                  data-testid={`extensions-row-${ext.name}`}
                  data-test-state={rowState}
                  className={broken ? 'opacity-80' : undefined}
                >
                  <div className="flex items-center gap-2 rounded-md p-2 hover:bg-accent">
                    <Checkbox
                      data-testid={`extensions-toggle-${ext.name}`}
                      id={`extensions-${ext.name}`}
                      checked={enabled && !broken}
                      onCheckedChange={next => onToggle(ext.name, next === true)}
                      disabled={broken}
                    />
                    <label
                      htmlFor={`extensions-${ext.name}`}
                      className="flex-1 cursor-pointer text-sm"
                    >
                      <span className="font-medium">{ext.name}</span>
                      {ext.description && (
                        <span className="ml-1 text-muted-foreground">— {ext.description}</span>
                      )}
                    </label>
                    {broken ? (
                      <Badge variant="destructive" className="text-[10px]">
                        broken
                      </Badge>
                    ) : ext.loaded ? (
                      <Badge variant="secondary" className="text-[10px]">
                        loaded
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px]">
                        off
                      </Badge>
                    )}
                  </div>
                  {broken && ext.error && (
                    <p
                      data-testid={`extensions-error-${ext.name}`}
                      className="px-2 pb-2 text-[11px] text-destructive break-words"
                    >
                      {ext.error}
                    </p>
                  )}
                </div>
              );

              if (broken) {
                return (
                  <Tooltip key={ext.path}>
                    <TooltipTrigger asChild>{row}</TooltipTrigger>
                    <TooltipContent>Extension failed to load. See error below.</TooltipContent>
                  </Tooltip>
                );
              }
              return <div key={ext.path}>{row}</div>;
            })}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
