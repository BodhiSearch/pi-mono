/**
 * FileTree — flat list of vault file paths.
 *
 * Kept intentionally simple for M2/M3 — a flat sorted path list, not a
 * collapsible tree. The Playwright black-box tests use
 * `data-testid="vault-file-entry"` + `data-path` to assert presence; a
 * `data-teststate` marks the selected entry.
 */

import { cn } from '@/lib/utils';

interface FileTreeProps {
  files: readonly string[];
  selected: string | null;
  onSelect: (path: string) => void;
  isEmpty: boolean;
}

export default function FileTree({ files, selected, onSelect, isEmpty }: FileTreeProps) {
  if (isEmpty) {
    return (
      <div
        data-testid="vault-file-tree"
        data-teststate="empty"
        className="text-xs text-muted-foreground px-2 py-3"
      >
        No vault mounted.
      </div>
    );
  }

  if (files.length === 0) {
    return (
      <div
        data-testid="vault-file-tree"
        data-teststate="loading"
        className="text-xs text-muted-foreground px-2 py-3"
      >
        (empty vault)
      </div>
    );
  }

  return (
    <ul data-testid="vault-file-tree" data-teststate="ready" className="text-xs">
      {files.map(path => {
        const isSelected = path === selected;
        return (
          <li key={path}>
            <button
              type="button"
              data-testid="vault-file-entry"
              data-path={path}
              data-teststate={isSelected ? 'selected' : 'unselected'}
              onClick={() => onSelect(path)}
              className={cn(
                'w-full text-left px-2 py-1 font-mono truncate hover:bg-gray-50',
                isSelected && 'bg-blue-50 text-blue-700'
              )}
              title={path}
            >
              {path.startsWith('/vault/') ? path.slice('/vault/'.length) : path}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
