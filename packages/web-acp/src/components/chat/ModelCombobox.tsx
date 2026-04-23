import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';

interface ModelComboboxProps {
  models: BodhiModelInfo[];
  selected: string;
  onSelect: (id: string, fmt: ApiFormat) => void;
  disabled?: boolean;
}

export default function ModelCombobox({
  models,
  selected,
  onSelect,
  disabled,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return models;
    return models.filter(m => m.id.toLowerCase().includes(q));
  }, [models, search]);

  return (
    <Popover
      open={open}
      onOpenChange={next => {
        setOpen(next);
        if (!next) setSearch('');
      }}
    >
      <PopoverTrigger asChild>
        <Button
          data-testid="model-selector"
          variant="ghost"
          role="combobox"
          aria-expanded={open}
          disabled={disabled || models.length === 0}
          className="w-[240px] border-0 focus-visible:ring-0 justify-between font-normal"
        >
          <span className="truncate">{selected || 'No models'}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[280px] p-0" align="end">
        <div className="p-2 border-b">
          <Input
            data-testid="model-search-input"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search models..."
            className="h-8"
            autoFocus
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div
              data-testid="model-option-empty"
              className="px-2 py-1.5 text-sm text-muted-foreground"
            >
              No models match
            </div>
          ) : (
            filtered.map(m => (
              <button
                key={m.id}
                type="button"
                role="option"
                aria-selected={selected === m.id}
                data-testid={`model-option-${m.id}`}
                onClick={() => {
                  onSelect(m.id, m.apiFormat);
                  setSearch('');
                  setOpen(false);
                }}
                className={cn(
                  'flex w-full items-center justify-between px-2 py-1.5 text-sm hover:bg-accent text-left',
                  selected === m.id && 'bg-accent'
                )}
              >
                <span className="truncate">{m.id}</span>
                {selected === m.id && <Check className="size-4 shrink-0 opacity-70" />}
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
