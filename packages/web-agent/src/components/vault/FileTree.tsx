/**
 * FileTree — collapsible tree of vault directories/files.
 *
 * Pattern copied from bodhiapps/zenfs-browser. Directories render as
 * collapsible rows with chevron + folder icons and default to collapsed;
 * files render as leaf rows with `data-testid="vault-file-entry"` +
 * `data-path` so Playwright can target individual entries regardless of
 * depth. Directory rows expose `data-testid="vault-dir-entry"` +
 * `data-teststate="expanded"|"collapsed"` so the e2e helper can walk the
 * ancestor chain and click-expand before asserting on nested files.
 */

import { useState } from 'react';
import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { VaultTreeNode } from '@/hooks/useVaultTree';

interface FileTreeProps {
  nodes: readonly VaultTreeNode[];
  selected: string | null;
  onSelect: (path: string) => void;
  isEmpty: boolean;
}

export default function FileTree({ nodes, selected, onSelect, isEmpty }: FileTreeProps) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

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

  if (nodes.length === 0) {
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

  const toggle = (path: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <ul data-testid="vault-file-tree" data-teststate="ready" className="text-xs py-1">
      {nodes.map(node => (
        <TreeNode
          key={node.path}
          node={node}
          depth={0}
          expanded={expanded}
          onToggle={toggle}
          selected={selected}
          onSelect={onSelect}
        />
      ))}
    </ul>
  );
}

interface TreeNodeProps {
  node: VaultTreeNode;
  depth: number;
  expanded: Set<string>;
  onToggle: (path: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}

function TreeNode({ node, depth, expanded, onToggle, selected, onSelect }: TreeNodeProps) {
  const indent = { paddingLeft: `${depth * 12 + 6}px` };

  if (node.kind === 'directory') {
    const isOpen = expanded.has(node.path);
    return (
      <li>
        <button
          type="button"
          data-testid="vault-dir-entry"
          data-path={node.path}
          data-teststate={isOpen ? 'expanded' : 'collapsed'}
          onClick={() => onToggle(node.path)}
          className="w-full flex items-center gap-1 py-0.5 pr-2 hover:bg-gray-50 font-mono text-left"
          style={indent}
          title={node.path}
        >
          {isOpen ? (
            <ChevronDown className="w-3 h-3 text-gray-500 shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-gray-500 shrink-0" />
          )}
          {isOpen ? (
            <FolderOpen className="w-3.5 h-3.5 text-blue-500 shrink-0" />
          ) : (
            <Folder className="w-3.5 h-3.5 text-blue-500 shrink-0" />
          )}
          <span className="truncate">{node.name}</span>
        </button>
        {isOpen && node.children.length > 0 && (
          <ul>
            {node.children.map(child => (
              <TreeNode
                key={child.path}
                node={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                selected={selected}
                onSelect={onSelect}
              />
            ))}
          </ul>
        )}
      </li>
    );
  }

  const isSelected = node.path === selected;
  return (
    <li>
      <button
        type="button"
        data-testid="vault-file-entry"
        data-path={node.path}
        data-teststate={isSelected ? 'selected' : 'unselected'}
        onClick={() => onSelect(node.path)}
        className={cn(
          'w-full flex items-center gap-1 py-0.5 pr-2 hover:bg-gray-50 font-mono text-left',
          isSelected && 'bg-blue-50 text-blue-700'
        )}
        style={{ paddingLeft: `${depth * 12 + 6 + 16}px` }}
        title={node.path}
      >
        <File className="w-3.5 h-3.5 text-gray-400 shrink-0" />
        <span className="truncate">{node.name}</span>
      </button>
    </li>
  );
}
