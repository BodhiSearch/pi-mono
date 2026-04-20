/**
 * Side panel surfacing the mounted vault contents.
 *
 * Sits to the left of the chat. The file tree + viewer give the
 * Playwright e2e a black-box surface for asserting that files the agent
 * wrote / read actually landed on the ZenFS mount.
 */

import { useState } from 'react';
import FileTree from './FileTree';
import FileViewer from './FileViewer';
import { useVaultMount } from '@/hooks/useVaultMount';
import { useVaultTree } from '@/hooks/useVaultTree';

export default function VaultPanel() {
  const { status } = useVaultMount();
  const { nodes, allDirectoryPaths } = useVaultTree(status);
  const [selected, setSelected] = useState<string | null>(null);

  return (
    <aside
      data-testid="vault-panel"
      data-teststate={status}
      className="flex flex-col w-64 border-r border-gray-200 bg-white overflow-hidden"
    >
      <div className="px-2 py-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground border-b">
        Vault
      </div>
      <div className="flex-1 overflow-auto">
        <FileTree
          nodes={nodes}
          allDirectoryPaths={allDirectoryPaths}
          selected={selected}
          onSelect={setSelected}
          isEmpty={status !== 'mounted'}
        />
      </div>
      <div className="h-64 flex-shrink-0">
        <FileViewer selected={selected} />
      </div>
    </aside>
  );
}
