import { extractTextFromAgentMessage, getToolCalls, type AgentMessage } from '@/types/chat';
import { getBuiltinTag } from '@/lib/builtin-format';

interface MessageBubbleProps {
  message: AgentMessage;
  turn: number;
}

export default function MessageBubble({ message, turn }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const text = extractTextFromAgentMessage(message);
  const hasToolCalls = getToolCalls(message).length > 0;
  const builtinTag = getBuiltinTag(message);
  const isBuiltin = Boolean(builtinTag);

  const teststate = isBuiltin ? 'builtin' : hasToolCalls ? 'has-tool-calls' : undefined;
  const userClass = isBuiltin
    ? 'bg-blue-100 text-blue-900 border border-blue-200'
    : 'bg-blue-500 text-white';
  const assistantClass = isBuiltin
    ? 'bg-gray-100 text-gray-700 border border-gray-200'
    : 'bg-gray-200 text-gray-800';

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        data-testid={`chat-message-turn-${turn}`}
        data-messagetype={message.role}
        data-turn={turn}
        data-test-state={teststate}
        data-builtin-command={builtinTag?.command}
        className={`max-w-[70%] px-4 py-2 rounded-lg ${isUser ? userClass : assistantClass}`}
      >
        {isBuiltin && (
          <div
            data-testid="builtin-badge"
            className="text-[10px] uppercase tracking-wide opacity-70 mb-1"
          >
            /{builtinTag?.command} · not sent to LLM
          </div>
        )}
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  );
}
