/**
 * Minimal vault status indicator for the app header.
 *
 * M2 scope only exposes status + a folder-picker button. A full file-tree UI
 * arrives in a later milestone.
 */

import { Button } from '@/components/ui/button';
import { useVaultMount } from '@/hooks/useVaultMount';
import type { VaultMountStatus } from '@/hooks/useVaultMount';

const LABELS: Record<VaultMountStatus, string> = {
  initializing: 'Initializing…',
  empty: 'No vault',
  prompt: 'Access needs re-grant',
  mounting: 'Mounting…',
  mounted: 'Mounted',
  error: 'Mount error',
};

function supportsFsa(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

export function VaultStatus() {
  const vault = useVaultMount();

  const fsaAvailable = supportsFsa();

  return (
    <div
      data-testid="vault-status"
      data-teststate={vault.status}
      className="flex items-center gap-2 text-sm"
    >
      <span
        className="inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs font-medium"
        aria-label={`Vault status: ${LABELS[vault.status]}`}
      >
        <span
          className={
            vault.status === 'mounted'
              ? 'h-1.5 w-1.5 rounded-full bg-green-500'
              : vault.status === 'error'
                ? 'h-1.5 w-1.5 rounded-full bg-red-500'
                : vault.status === 'prompt'
                  ? 'h-1.5 w-1.5 rounded-full bg-yellow-500'
                  : 'h-1.5 w-1.5 rounded-full bg-gray-400'
          }
        />
        <span>{LABELS[vault.status]}</span>
        {vault.name ? (
          <span data-testid="vault-name" className="ml-1 text-muted-foreground">
            {vault.name}
          </span>
        ) : null}
      </span>

      {vault.status === 'empty' && fsaAvailable ? (
        <Button
          size="sm"
          variant="outline"
          data-testid="vault-pick"
          onClick={() => {
            void vault.openDirectory();
          }}
        >
          Pick folder
        </Button>
      ) : null}

      {vault.status === 'prompt' ? (
        <Button
          size="sm"
          variant="outline"
          data-testid="vault-restore"
          onClick={() => {
            void vault.restoreAccess();
          }}
        >
          Grant access
        </Button>
      ) : null}

      {vault.status === 'mounted' ? (
        <Button
          size="sm"
          variant="ghost"
          data-testid="vault-unmount"
          onClick={() => {
            void vault.closeDirectory();
          }}
        >
          Unmount
        </Button>
      ) : null}
    </div>
  );
}
