import { GitBranch, GitFork, Layers } from 'lucide-react';
import { extractTextFromAgentMessage, getToolCalls, type AgentMessage } from '@/types/chat';
import type { UiMessageMeta } from '@/worker-agent/core/session/types';

interface MessageBubbleProps {
  message: AgentMessage;
  turn: number;
  meta?: UiMessageMeta;
  onFork?: (entryId: string) => void;
  onBranchHere?: (entryId: string) => void;
}

export default function MessageBubble({
  message,
  turn,
  meta,
  onFork,
  onBranchHere,
}: MessageBubbleProps) {
  const entryId = meta?.entryId;
  const isCompactionSummary = meta?.kind === 'compaction-summary';

  if (isCompactionSummary) {
    return (
      <div className="flex justify-center mb-4">
        <div
          data-testid="chat-compaction-summary"
          data-kind="compaction-summary"
          data-tokens-before={meta?.tokensBefore}
          data-first-kept-entry-id={meta?.firstKeptEntryId}
          data-entry-id={entryId}
          className="max-w-[85%] rounded-lg border border-dashed border-gray-300 bg-gray-50 px-4 py-3 text-sm text-gray-500"
        >
          <div className="mb-1 flex items-center gap-1.5 font-medium text-gray-600">
            <Layers className="h-3.5 w-3.5" />
            Compacted conversation
          </div>
          <div className="whitespace-pre-wrap break-words">
            {extractTextFromAgentMessage(message)}
          </div>
        </div>
      </div>
    );
  }

  const isUser = message.role === 'user';
  const text = extractTextFromAgentMessage(message);
  const hasToolCalls = getToolCalls(message).length > 0;
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
