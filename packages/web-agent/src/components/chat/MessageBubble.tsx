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
  const showActions = !!entryId && (onFork || onBranchHere);

  return (
    <div
      className={`group relative flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}
      data-entry-id={entryId}
    >
      <div
        data-testid={`chat-message-turn-${turn}`}
        data-messagetype={message.role}
        data-turn={turn}
        data-entry-id={entryId}
        data-teststate={hasToolCalls ? 'has-tool-calls' : undefined}
        className={`max-w-[70%] px-4 py-2 rounded-lg ${
          isUser ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </div>
      {showActions && entryId ? (
        <div
          data-testid="chat-message-actions"
          data-entry-id={entryId}
          className={`absolute top-0 ${
            isUser ? 'right-full mr-2' : 'left-full ml-2'
          } flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100`}
        >
          {onFork ? (
            <button
              type="button"
              data-testid="chat-message-fork-action"
              data-entry-id={entryId}
              onClick={() => onFork(entryId)}
              className="rounded border border-gray-200 bg-white p-1 text-gray-500 shadow-sm hover:text-gray-900"
              title="Fork from here — create a new session copying messages up to this point"
            >
              <GitFork className="h-3 w-3" />
            </button>
          ) : null}
          {onBranchHere ? (
            <button
              type="button"
              data-testid="chat-message-branch-action"
              data-entry-id={entryId}
              onClick={() => onBranchHere(entryId)}
              className="rounded border border-gray-200 bg-white p-1 text-gray-500 shadow-sm hover:text-gray-900"
              title="Branch from here — your next prompt continues from this message as a sibling"
            >
              <GitBranch className="h-3 w-3" />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
