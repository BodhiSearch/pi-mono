import { GitBranch, GitFork } from 'lucide-react';
import { extractTextFromAgentMessage, getToolCalls, type AgentMessage } from '@/types/chat';

interface MessageBubbleProps {
  message: AgentMessage;
  turn: number;
  entryId?: string;
  onFork?: (entryId: string) => void;
  onBranchHere?: (entryId: string) => void;
}

export default function MessageBubble({
  message,
  turn,
  entryId,
  onFork,
  onBranchHere,
}: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const text = extractTextFromAgentMessage(message);
  const hasToolCalls = getToolCalls(message).length > 0;
  // Actions only on assistant replies. Branching from a user message would
  // produce orphan sibling-user-messages (no semantic); forking from an
  // assistant message captures the full path up to and including that
  // reply, which is the natural "diverge from here" point.
  const showActions = !isUser && !!entryId && (onFork || onBranchHere);

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        data-testid={`chat-message-turn-${turn}`}
        data-messagetype={message.role}
        data-turn={turn}
        data-entry-id={entryId}
        data-teststate={hasToolCalls ? 'has-tool-calls' : undefined}
        className={`group relative max-w-[70%] px-4 py-2 rounded-lg ${
          isUser ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{text}</div>
        {showActions && entryId ? (
          <div
            data-testid="chat-message-actions"
            data-entry-id={entryId}
            // Absolute overlay anchored to the bubble's bottom-right ("end of
            // message"). pointer-events-none keeps the bubble clickable when
            // hidden; group-hover:pointer-events-auto re-enables when shown.
            // No layout space reserved — height stays stable on hover.
            className={`pointer-events-none absolute -bottom-3 right-2 flex items-center gap-1 rounded-md border border-gray-200 bg-white px-1 py-0.5 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100`}
          >
            {onFork ? (
              <button
                type="button"
                data-testid="chat-message-fork-action"
                data-entry-id={entryId}
                onClick={() => onFork(entryId)}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                title="Fork from here — create a new session copying messages up to this point"
              >
                <GitFork className="h-3.5 w-3.5" />
              </button>
            ) : null}
            {onBranchHere ? (
              <button
                type="button"
                data-testid="chat-message-branch-action"
                data-entry-id={entryId}
                onClick={() => onBranchHere(entryId)}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                title="Branch from here — your next prompt continues from this message as a sibling"
              >
                <GitBranch className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
