import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

interface StatusIndicatorProps {
  label: string;
  status: boolean;
  tooltip?: string;
}

export default function StatusIndicator({ label, status, tooltip }: StatusIndicatorProps) {
  return (
    <div className="flex items-center gap-1" title={tooltip}>
      <Badge
        data-testid={`badge-${label.toLowerCase()}-status`}
        data-teststate={status ? 'ready' : 'not-ready'}
        variant={status ? 'default' : 'destructive'}
        className={cn('size-2 p-0 rounded-full border-0', status ? 'bg-green-500' : 'bg-red-500')}
      />
      <span className="text-xs text-gray-600">{label}</span>
    </div>
  );
}
