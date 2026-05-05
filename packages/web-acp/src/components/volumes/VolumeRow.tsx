import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { VolumeEntry } from '@/hooks/useVolumes';

export interface VolumeRowProps {
  entry: VolumeEntry;
  onRemove: (mountName: string) => void;
  onDescriptionChange: (mountName: string, description: string) => void;
  onRestore: (mountName: string) => void;
}

export default function VolumeRow({
  entry,
  onRemove,
  onDescriptionChange,
  onRestore,
}: VolumeRowProps) {
  return (
    <li
      data-testid={`volume-row-${entry.mountName}`}
      data-test-state={entry.state}
      className="flex items-center gap-2 px-3 py-2 text-sm border-b"
    >
      <div className="flex-1 min-w-0">
        <div className="font-mono text-xs text-gray-600 truncate">/mnt/{entry.mountName}</div>
        {entry.tags.length > 0 ? (
          <ul
            data-testid={`volume-row-${entry.mountName}-tags`}
            data-test-state={String(entry.tags.length)}
            className="mt-1 flex flex-wrap gap-1"
          >
            {entry.tags.map(tag => (
              <li
                key={tag}
                data-testid={`volume-row-${entry.mountName}-tag-${tag}`}
                className="inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-mono text-gray-700"
              >
                {tag}
              </li>
            ))}
          </ul>
        ) : null}
        <Input
          data-testid={`input-volume-description-${entry.mountName}`}
          placeholder="Description (optional)"
          defaultValue={entry.description ?? ''}
          onBlur={e => onDescriptionChange(entry.mountName, e.target.value)}
          className="mt-1 text-xs h-7"
        />
        {entry.state === 'error' && entry.errorMessage ? (
          <div
            data-testid={`volume-row-${entry.mountName}-error`}
            className="text-xs text-red-600 mt-1"
          >
            {entry.errorMessage}
          </div>
        ) : null}
      </div>
      {entry.needsPermission ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          data-testid={`btn-restore-volume-${entry.mountName}`}
          onClick={() => onRestore(entry.mountName)}
        >
          Grant
        </Button>
      ) : null}
      <Button
        type="button"
        size="icon"
        variant="ghost"
        data-testid={`btn-remove-volume-${entry.mountName}`}
        onClick={() => onRemove(entry.mountName)}
        aria-label={`Remove ${entry.mountName}`}
      >
        <X className="size-4" />
      </Button>
    </li>
  );
}
