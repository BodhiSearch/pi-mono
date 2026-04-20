/**
 * FileViewer — read-only text view of the currently selected vault file.
 *
 * Selector contract for Playwright:
 *   data-testid="vault-file-viewer" — container, always rendered
 *   data-teststate="empty" | "loading" | "ready" | "error"
 *   data-path={selectedPath} — when a file is selected
 *   data-testid="vault-file-content" — <pre> holding the file text
 */

import { useEffect, useState } from 'react';
import { fs } from '@/web-agent';

interface FileViewerProps {
  selected: string | null;
}

type ViewerState =
  | { tag: 'empty' }
  | { tag: 'loading' }
  | { tag: 'ready'; text: string }
  | { tag: 'error'; message: string };

export default function FileViewer({ selected }: FileViewerProps) {
  const [state, setState] = useState<ViewerState>({ tag: 'empty' });

  useEffect(() => {
    let cancelled = false;

    if (!selected) {
      (async () => {
        await Promise.resolve();
        if (!cancelled) setState({ tag: 'empty' });
      })();
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setState({ tag: 'loading' });
      try {
        const buf = await fs.promises.readFile(selected);
        if (cancelled) return;
        const text = new TextDecoder().decode(buf as unknown as ArrayBuffer);
        setState({ tag: 'ready', text });
      } catch (err) {
        if (cancelled) return;
        setState({
          tag: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const attrs: { 'data-testid': string; 'data-teststate': string; 'data-path'?: string } = {
    'data-testid': 'vault-file-viewer',
    'data-teststate': state.tag,
  };
  if (selected) attrs['data-path'] = selected;

  return (
    <div {...attrs} className="flex flex-col h-full border-t">
      <div className="px-2 py-1 text-xs font-mono text-muted-foreground truncate">
        {selected ?? 'No file selected'}
      </div>
      {state.tag === 'ready' ? (
        <pre
          data-testid="vault-file-content"
          className="flex-1 overflow-auto p-2 text-xs font-mono bg-gray-50 whitespace-pre-wrap break-all"
        >
          {state.text}
        </pre>
      ) : null}
      {state.tag === 'error' ? (
        <div className="flex-1 p-2 text-xs text-red-600">{state.message}</div>
      ) : null}
      {state.tag === 'loading' ? (
        <div className="flex-1 p-2 text-xs text-muted-foreground">Loading…</div>
      ) : null}
      {state.tag === 'empty' ? (
        <div className="flex-1 p-2 text-xs text-muted-foreground">Select a file to preview.</div>
      ) : null}
    </div>
  );
}
