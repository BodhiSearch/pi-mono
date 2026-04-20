/**
 * FileViewer — view/edit the currently selected vault file.
 *
 * Markdown files (.md / .mdx / .markdown) render inside the Milkdown Crepe
 * WYSIWYG editor and auto-save on blur + 5s interval back through ZenFS
 * (which persists to the user's real folder via Chrome FSA). Non-markdown
 * text files render read-only in a <pre>. Binary/unsupported files show a
 * placeholder.
 *
 * Selector contract for Playwright:
 *   data-testid="vault-file-viewer" — container, always rendered
 *   data-teststate="empty" | "loading" | "ready" | "error" | "unsupported"
 *   data-path={selectedPath} — when a file is selected
 *   data-testid="vault-file-content" — <pre> holding the raw file text
 *   data-testid="markdown-editor"    — Milkdown editor root when md file is open
 */

import { useCallback, useEffect, useState } from 'react';
import { fs } from '@/web-agent';
import { MarkdownEditor } from './MarkdownEditor';
import type { MarkdownSaveState } from './MarkdownEditor';

interface FileViewerProps {
  selected: string | null;
}

type ViewerState =
  | { tag: 'empty' }
  | { tag: 'loading' }
  | { tag: 'ready'; text: string; kind: 'markdown' | 'text' }
  | { tag: 'unsupported' }
  | { tag: 'error'; message: string };

const MARKDOWN_EXT = /\.(md|markdown|mdx)$/i;

const TEXT_EXT =
  /\.(txt|json|ts|tsx|js|jsx|mjs|cjs|css|scss|less|html?|xml|svg|ya?ml|toml|ini|cfg|conf|env|sh|bash|zsh|fish|py|rb|rs|go|java|kt|c|cpp|h|hpp|cs|swift|php|lua|r|sql|graphql|gql|proto|lock|log|gitignore|dockerignore|editorconfig|sample)$/i;

const EXTENSIONLESS_TEXT = new Set([
  'Makefile',
  'Dockerfile',
  'Containerfile',
  'Procfile',
  'LICENSE',
  'LICENCE',
  'README',
  'CHANGELOG',
  '.gitignore',
  '.gitattributes',
  '.npmrc',
  '.nvmrc',
  '.prettierrc',
  '.eslintrc',
  '.babelrc',
]);

function classify(path: string): 'markdown' | 'text' | 'unsupported' {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (MARKDOWN_EXT.test(name)) return 'markdown';
  if (TEXT_EXT.test(name)) return 'text';
  if (EXTENSIONLESS_TEXT.has(name)) return 'text';
  return 'unsupported';
}

export default function FileViewer({ selected }: FileViewerProps) {
  const [state, setState] = useState<ViewerState>({ tag: 'empty' });
  const [saveState, setSaveState] = useState<MarkdownSaveState>('idle');

  useEffect(() => {
    let cancelled = false;

    if (!selected) {
      (async () => {
        await Promise.resolve();
        if (cancelled) return;
        setState({ tag: 'empty' });
        setSaveState('idle');
      })();
      return () => {
        cancelled = true;
      };
    }

    (async () => {
      await Promise.resolve();
      if (cancelled) return;
      setState({ tag: 'loading' });
      setSaveState('idle');
      const kind = classify(selected);
      if (kind === 'unsupported') {
        if (cancelled) return;
        setState({ tag: 'unsupported' });
        return;
      }
      try {
        const buf = await fs.promises.readFile(selected);
        if (cancelled) return;
        const text = new TextDecoder().decode(buf as unknown as ArrayBuffer);
        setState({ tag: 'ready', text, kind });
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

  const handleSave = useCallback(
    async (content: string) => {
      if (!selected) return;
      setSaveState('saving');
      try {
        await fs.promises.writeFile(selected, content, { encoding: 'utf8' });
        setSaveState('saved');
      } catch {
        setSaveState('error');
      }
    },
    [selected]
  );

  const attrs: { 'data-testid': string; 'data-teststate': string; 'data-path'?: string } = {
    'data-testid': 'vault-file-viewer',
    'data-teststate': state.tag,
  };
  if (selected) attrs['data-path'] = selected;

  return (
    <div {...attrs} className="flex flex-col h-full min-w-0 bg-white">
      <div className="px-3 py-2 text-xs font-mono text-muted-foreground truncate border-b">
        {selected ?? 'No file selected'}
      </div>
      <div className="flex-1 min-h-0 flex overflow-hidden">
        {state.tag === 'ready' && state.kind === 'markdown' ? (
          <MarkdownEditor
            key={selected ?? ''}
            initialContent={state.text}
            onSave={handleSave}
            saveState={saveState}
          />
        ) : null}
        {state.tag === 'ready' && state.kind === 'text' ? (
          <pre
            data-testid="vault-file-content"
            className="flex-1 overflow-auto p-3 text-xs font-mono bg-gray-50 whitespace-pre-wrap break-all"
          >
            {state.text}
          </pre>
        ) : null}
        {state.tag === 'loading' ? (
          <div className="flex-1 p-3 text-xs text-muted-foreground">Loading…</div>
        ) : null}
        {state.tag === 'error' ? (
          <div className="flex-1 p-3 text-xs text-red-600">{state.message}</div>
        ) : null}
        {state.tag === 'empty' ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Select a file to preview.
          </div>
        ) : null}
        {state.tag === 'unsupported' ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            Preview not available for this file type.
          </div>
        ) : null}
      </div>
    </div>
  );
}
