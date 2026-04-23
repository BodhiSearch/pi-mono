/**
 * Modal renderer for `pi.ui.select / confirm / input` requests.
 *
 * Picks the head of the `useExtensionUI` dialog queue and renders the
 * kind-appropriate component. `notify` + `setStatus` are handled
 * directly by the hook (toasts + status-chip state) and render nothing
 * here.
 *
 * UX contract:
 *   - Clicking the backdrop or pressing Escape cancels the active
 *     dialog (resolves the worker promise with its cancel value).
 *   - Select / Input dialogs surface a `data-testid` per option so
 *     Playwright can target answers deterministically.
 *   - The `Cancel` button is always present; dialogs are never
 *     "forced" — extensions receive the cancel value instead.
 *
 * Worker-side timeout countdowns belong to Phase 2b; this renderer
 * stays intentionally minimal so the e2e suite doesn't have to mock
 * time.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import type { ActiveExtensionDialog } from '@/hooks/useExtensionUI';

export interface ExtensionUIRendererProps {
  /** Head of the dialog queue from `useExtensionUI`. `null` renders nothing. */
  activeDialog: ActiveExtensionDialog | null;
  /** Reply to the active dialog. See `useExtensionUI` for payload shapes. */
  respond: (requestId: string, result: unknown) => void;
  /** Cancel the active dialog (Esc / backdrop / explicit Cancel button). */
  dismissActive: () => void;
}

export default function ExtensionUIRenderer({
  activeDialog,
  respond,
  dismissActive,
}: ExtensionUIRendererProps) {
  if (!activeDialog) return null;

  return <ExtensionDialogShell dialog={activeDialog} respond={respond} dismiss={dismissActive} />;
}

interface ShellProps {
  dialog: ActiveExtensionDialog;
  respond: (requestId: string, result: unknown) => void;
  dismiss: () => void;
}

function ExtensionDialogShell({ dialog, respond, dismiss }: ShellProps) {
  // Escape everywhere cancels — matches the backdrop-click contract.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        dismiss();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [dismiss]);

  return (
    <div
      data-testid="extension-ui-overlay"
      data-extension-path={dialog.extensionPath}
      data-dialog-kind={dialog.kind}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={e => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <div
        className={cn(
          'w-full rounded-lg bg-white p-6 shadow-xl',
          dialog.kind === 'editor' ? 'max-w-2xl' : 'max-w-md'
        )}
        role="dialog"
        aria-modal="true"
        data-testid="extension-ui-dialog"
      >
        <ExtensionDialogBody dialog={dialog} respond={respond} dismiss={dismiss} />
      </div>
    </div>
  );
}

function ExtensionDialogBody({ dialog, respond, dismiss }: ShellProps) {
  if (dialog.kind === 'select') {
    return <SelectDialog dialog={dialog} respond={respond} dismiss={dismiss} />;
  }
  if (dialog.kind === 'confirm') {
    return <ConfirmDialog dialog={dialog} respond={respond} dismiss={dismiss} />;
  }
  if (dialog.kind === 'editor') {
    return <EditorDialog dialog={dialog} respond={respond} dismiss={dismiss} />;
  }
  return <InputDialog dialog={dialog} respond={respond} dismiss={dismiss} />;
}

function ExtensionAttribution({ path }: { path: string }) {
  return (
    <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {path === 'anonymous' ? 'extension' : path.split('/').pop() || path}
    </div>
  );
}

function SelectDialog({
  dialog,
  respond,
  dismiss,
}: {
  dialog: Extract<ActiveExtensionDialog, { kind: 'select' }>;
  respond: ShellProps['respond'];
  dismiss: () => void;
}) {
  const { payload, requestId, extensionPath } = dialog;
  return (
    <div>
      <ExtensionAttribution path={extensionPath} />
      <h2 className="text-base font-semibold text-foreground" data-testid="extension-dialog-title">
        {payload.title}
      </h2>
      <div className="mt-4 flex flex-col gap-2" data-testid="extension-dialog-options">
        {payload.options.map(opt => (
          <Button
            key={opt.index}
            type="button"
            variant="outline"
            className="justify-start"
            data-testid={`extension-dialog-option-${opt.index}`}
            data-option-label={opt.label}
            onClick={() => respond(requestId, { index: opt.index })}
          >
            {opt.label}
          </Button>
        ))}
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          type="button"
          variant="ghost"
          data-testid="extension-dialog-cancel"
          onClick={dismiss}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function ConfirmDialog({
  dialog,
  respond,
  dismiss,
}: {
  dialog: Extract<ActiveExtensionDialog, { kind: 'confirm' }>;
  respond: ShellProps['respond'];
  dismiss: () => void;
}) {
  const { payload, requestId, extensionPath } = dialog;
  return (
    <div>
      <ExtensionAttribution path={extensionPath} />
      <h2 className="text-base font-semibold text-foreground" data-testid="extension-dialog-title">
        {payload.title}
      </h2>
      <p className="mt-2 text-sm text-muted-foreground" data-testid="extension-dialog-message">
        {payload.message}
      </p>
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="extension-dialog-cancel"
          onClick={dismiss}
        >
          Cancel
        </Button>
        <Button
          type="button"
          data-testid="extension-dialog-confirm"
          onClick={() => respond(requestId, true)}
        >
          Confirm
        </Button>
      </div>
    </div>
  );
}

function EditorDialog({
  dialog,
  respond,
  dismiss,
}: {
  dialog: Extract<ActiveExtensionDialog, { kind: 'editor' }>;
  respond: ShellProps['respond'];
  dismiss: () => void;
}) {
  const { payload, requestId, extensionPath } = dialog;
  // The buffer starts from the prefill the worker sent. If
  // `pi.ui.setEditorText` arrives while the editor is open, the hook
  // mutates `dialog.payload.prefill` and we re-sync via the effect
  // below so extension-driven edits aren't silently overwritten by
  // user input that predates the update.
  const [value, setValue] = useState(payload.prefill);
  const lastPrefillRef = useRef(payload.prefill);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (payload.prefill !== lastPrefillRef.current) {
      lastPrefillRef.current = payload.prefill;
      setValue(payload.prefill);
    }
  }, [payload.prefill]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [requestId]);

  const submit = useCallback(() => {
    respond(requestId, value);
  }, [respond, requestId, value]);

  return (
    <div>
      <ExtensionAttribution path={extensionPath} />
      <h2 className="text-base font-semibold text-foreground" data-testid="extension-dialog-title">
        {payload.title}
      </h2>
      <textarea
        ref={textareaRef}
        data-testid="extension-editor"
        data-extension-path={extensionPath}
        data-editor-language={payload.language ?? ''}
        className="mt-3 min-h-[220px] w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        placeholder={payload.placeholder ?? undefined}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          // Ctrl/Cmd + Enter submits — matches the coding-agent modal
          // editor's affordance so muscle memory carries over.
          if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="extension-dialog-cancel"
          onClick={dismiss}
        >
          Cancel
        </Button>
        <Button type="button" data-testid="extension-dialog-submit" onClick={submit}>
          Save
        </Button>
      </div>
    </div>
  );
}

function InputDialog({
  dialog,
  respond,
  dismiss,
}: {
  dialog: Extract<ActiveExtensionDialog, { kind: 'input' }>;
  respond: ShellProps['respond'];
  dismiss: () => void;
}) {
  const { payload, requestId, extensionPath } = dialog;
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Focus the input on mount so keyboard users can start typing
  // immediately. Re-running on requestId keeps focus correct if the
  // renderer remounts for a queued successor.
  useEffect(() => {
    inputRef.current?.focus();
  }, [requestId]);

  const submit = useCallback(() => {
    respond(requestId, value);
  }, [respond, requestId, value]);

  return (
    <div>
      <ExtensionAttribution path={extensionPath} />
      <h2 className="text-base font-semibold text-foreground" data-testid="extension-dialog-title">
        {payload.title}
      </h2>
      <Input
        ref={inputRef}
        data-testid="extension-dialog-input"
        className="mt-3"
        placeholder={payload.placeholder ?? undefined}
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="mt-4 flex justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          data-testid="extension-dialog-cancel"
          onClick={dismiss}
        >
          Cancel
        </Button>
        <Button type="button" data-testid="extension-dialog-submit" onClick={submit}>
          Submit
        </Button>
      </div>
    </div>
  );
}
