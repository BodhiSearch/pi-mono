import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { UseVolumesResult } from '@/hooks/useVolumes';
import VolumeRow from './VolumeRow';

export interface VolumesPanelProps {
  volumes: UseVolumesResult;
}

export default function VolumesPanel({ volumes }: VolumesPanelProps) {
  const { entries, addVolume, removeVolume, setDescription, restoreAccess } = volumes;

  const handleAdd = () => {
    addVolume().catch(err => {
      // Directory picker rejection (user cancelled) is the most common
      // failure; we swallow it so it doesn't surface as a toast.
      if (err instanceof DOMException && err.name === 'AbortError') return;
      console.error('[VolumesPanel] addVolume failed:', err);
    });
  };

  return (
    <section
      data-testid="volumes-panel"
      data-test-state={String(entries.length)}
      className="border-b bg-gray-50"
    >
      <header className="flex items-center justify-between px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-gray-500">Volumes</h2>
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid="btn-add-volume"
          onClick={handleAdd}
        >
          <Plus className="size-3.5" />
          Add
        </Button>
      </header>
      {entries.length === 0 ? (
        <div data-testid="volumes-panel-empty" className="px-3 pb-3 text-xs text-gray-400">
          No volumes mounted. Click "Add" to give the agent access to a folder.
        </div>
      ) : (
        <ul className="flex flex-col">
          {entries.map(entry => (
            <VolumeRow
              key={entry.mountName}
              entry={entry}
              onRemove={removeVolume}
              onDescriptionChange={setDescription}
              onRestore={restoreAccess}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
