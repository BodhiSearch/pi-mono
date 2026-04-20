/**
 * Left-column vault sidebar: collapsible file tree.
 *
 * The file viewer lives in the middle column (see `Layout.tsx`); this
 * panel only owns the tree and surfaces the `selected` path up via
 * `onSelect` so the viewer can read it.
 */

import FileTree from './FileTree';
import { useVaultMount } from '@/hooks/useVaultMount';
import { useVaultTree } from '@/hooks/useVaultTree';

interface VaultPanelProps {
  selected: string | null;
  onSelect: (path: string) => void;
}

export default function VaultPanel({ selected, onSelect }: VaultPanelProps) {
  const { status } = useVaultMount();
  const { nodes } = useVaultTree(status);

  return (
    <aside
      data-testid="vault-panel"
      data-teststate={status}
      className="flex flex-col w-64 shrink-0 border-r border-gray-200 bg-white overflow-hidden"
    >
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b">
        Vault
      </div>
      <div className="flex-1 overflow-auto">
        <FileTree
          nodes={nodes}
          selected={selected}
          onSelect={onSelect}
          isEmpty={status !== 'mounted'}
        />
      </div>
    </aside>
  );
}
