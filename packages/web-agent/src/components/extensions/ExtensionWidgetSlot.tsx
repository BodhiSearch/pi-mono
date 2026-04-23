/**
 * Transcript-area slot rendering extension-contributed widgets.
 *
 * `useExtensionUI().widgets` produces an ordered snapshot list keyed
 * by `${extensionPath}::${widgetId}`. Each entry carries a closed-enum
 * `kind` (`progress | info | choice`) plus a structured-clone-safe
 * `props` bag. We validate props at render time (never at the
 * structured-clone boundary) so malformed payloads fail gracefully.
 *
 * Every widget is wrapped in a bubble annotated with:
 *   data-testid="extension-widget"
 *   data-widget-kind="progress | info | choice"
 *   data-widget-id=<id>
 *   data-extension-path=<path>
 *
 * That contract is what Playwright asserts against, so the visual
 * styling is intentionally plain — extensions are responsible for the
 * semantics, not the palette.
 */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ExtensionWidgetSnapshot } from '@/hooks/useExtensionUI';
import type { ExtensionWidget } from '@/worker-agent';

export interface ExtensionWidgetSlotProps {
  widgets: ExtensionWidgetSnapshot[];
  /**
   * Optional callback invoked when the user clicks a choice button.
   * Exposed so parent components can forward through a dedicated RPC
   * verb in later phases; for 2b we leave it undefined and widgets are
   * observation-only unless a future extension wires a tool call from
   * inside its own choice props.
   */
  onChoice?: (slotKey: string, choiceId: string) => void;
  className?: string;
}

export default function ExtensionWidgetSlot({
  widgets,
  onChoice,
  className,
}: ExtensionWidgetSlotProps) {
  if (widgets.length === 0) return null;
  return (
    <div
      data-testid="extension-widget-slot"
      className={cn('flex flex-col gap-2 px-4 py-2', className)}
    >
      {widgets.map(snapshot => (
        <WidgetBubble key={snapshot.slotKey} snapshot={snapshot} onChoice={onChoice} />
      ))}
    </div>
  );
}

function WidgetBubble({
  snapshot,
  onChoice,
}: {
  snapshot: ExtensionWidgetSnapshot;
  onChoice?: (slotKey: string, choiceId: string) => void;
}) {
  const { widget, extensionPath, widgetId, slotKey } = snapshot;
  const label =
    extensionPath === 'anonymous' ? 'extension' : extensionPath.split('/').pop() || extensionPath;
  return (
    <div
      data-testid="extension-widget"
      data-widget-kind={widget.kind}
      data-widget-id={widgetId}
      data-extension-path={extensionPath}
      className="rounded-lg border border-border/60 bg-muted/30 p-3 text-sm text-foreground"
    >
      <div className="mb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <WidgetBody widget={widget} slotKey={slotKey} onChoice={onChoice} />
    </div>
  );
}

function WidgetBody({
  widget,
  slotKey,
  onChoice,
}: {
  widget: ExtensionWidget;
  slotKey: string;
  onChoice?: (slotKey: string, choiceId: string) => void;
}) {
  if (widget.kind === 'progress') {
    return <ProgressWidgetBody props={widget.props} />;
  }
  if (widget.kind === 'info') {
    return <InfoWidgetBody props={widget.props} />;
  }
  if (widget.kind === 'choice') {
    return <ChoiceWidgetBody props={widget.props} slotKey={slotKey} onChoice={onChoice} />;
  }
  return null;
}

function clampRatio(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function pickString(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  return null;
}

function ProgressWidgetBody({ props }: { props: Record<string, unknown> }) {
  const ratio = clampRatio(props.ratio);
  const label = pickString(props.label);
  const note = pickString(props.note);
  return (
    <div data-testid="extension-widget-progress">
      {label !== null ? (
        <div className="mb-1 flex items-center justify-between text-xs font-medium text-foreground">
          <span data-testid="extension-widget-progress-label">{label}</span>
          {ratio !== null ? (
            <span
              className="text-muted-foreground"
              data-testid="extension-widget-progress-ratio"
              data-ratio={String(ratio)}
            >
              {Math.round(ratio * 100)}%
            </span>
          ) : null}
        </div>
      ) : null}
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-primary transition-all"
          style={{ width: ratio === null ? '0%' : `${Math.round(ratio * 100)}%` }}
          data-testid="extension-widget-progress-bar"
          data-ratio={ratio === null ? 'unknown' : String(ratio)}
        />
      </div>
      {note !== null ? (
        <div
          className="mt-1 text-[11px] text-muted-foreground"
          data-testid="extension-widget-progress-note"
        >
          {note}
        </div>
      ) : null}
    </div>
  );
}

function InfoWidgetBody({ props }: { props: Record<string, unknown> }) {
  const title = pickString(props.title);
  const message = pickString(props.message) ?? '';
  return (
    <div data-testid="extension-widget-info">
      {title !== null ? (
        <div
          className="mb-0.5 text-sm font-semibold text-foreground"
          data-testid="extension-widget-info-title"
        >
          {title}
        </div>
      ) : null}
      <div className="text-sm text-foreground" data-testid="extension-widget-info-message">
        {message}
      </div>
    </div>
  );
}

interface ChoiceOption {
  id: string;
  label: string;
}

function readChoiceOptions(value: unknown): ChoiceOption[] {
  if (!Array.isArray(value)) return [];
  const out: ChoiceOption[] = [];
  for (const entry of value) {
    if (entry && typeof entry === 'object') {
      const maybe = entry as Record<string, unknown>;
      const id = pickString(maybe.id);
      const label = pickString(maybe.label);
      if (id !== null && label !== null) {
        out.push({ id, label });
      }
    }
  }
  return out;
}

function ChoiceWidgetBody({
  props,
  slotKey,
  onChoice,
}: {
  props: Record<string, unknown>;
  slotKey: string;
  onChoice?: (slotKey: string, choiceId: string) => void;
}) {
  const title = pickString(props.title);
  const options = readChoiceOptions(props.options);
  return (
    <div data-testid="extension-widget-choice">
      {title !== null ? (
        <div
          className="mb-2 text-sm font-medium text-foreground"
          data-testid="extension-widget-choice-title"
        >
          {title}
        </div>
      ) : null}
      <div className="flex flex-wrap gap-1.5" data-testid="extension-widget-choice-options">
        {options.map(option => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant="outline"
            data-testid="extension-widget-choice-option"
            data-choice-id={option.id}
            onClick={() => onChoice?.(slotKey, option.id)}
            disabled={onChoice === undefined}
          >
            {option.label}
          </Button>
        ))}
      </div>
    </div>
  );
}
