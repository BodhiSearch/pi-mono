import { Info, TriangleAlert } from 'lucide-react';
import type { TransientMessage } from '@/types/transient-message';

interface TransientBubbleProps {
  message: TransientMessage;
}

export default function TransientBubble({ message }: TransientBubbleProps) {
  const isError = message.kind === 'error';
  const Icon = isError ? TriangleAlert : Info;
  const tone = isError
    ? 'border-red-200 bg-red-50 text-red-800'
    : 'border-blue-200 bg-blue-50 text-blue-800';

  return (
    <div className="flex justify-center mb-4">
      <div
        data-testid="chat-transient-message"
        data-transient-id={message.id}
        data-kind={message.kind}
        className={`max-w-[85%] rounded-lg border px-4 py-3 text-sm shadow-sm ${tone}`}
      >
        <div className="mb-1 flex items-center gap-1.5 font-medium">
          <Icon className="h-3.5 w-3.5" />
          {message.title ?? (isError ? 'Error' : 'Info')}
        </div>
        <div className="whitespace-pre-wrap break-words font-mono text-xs">{message.text}</div>
      </div>
    </div>
  );
}
