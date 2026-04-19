import { extractTextFromAgentMessage, getToolCalls, type AgentMessage } from '@/types/chat';

interface MessageBubbleProps {
  message: AgentMessage;
  turn: number;
}

export default function MessageBubble({ message, turn }: MessageBubbleProps) {
  const isUser = message.role === 'user';
  const text = extractTextFromAgentMessage(message);
  const hasToolCalls = getToolCalls(message).length > 0;

  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} mb-4`}>
      <div
        data-testid={`chat-message-turn-${turn}`}
        data-messagetype={message.role}
        data-turn={turn}
        data-teststate={hasToolCalls ? 'has-tool-calls' : undefined}
        className={`max-w-[70%] px-4 py-2 rounded-lg ${
          isUser ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-800'
        }`}
      >
        <div className="whitespace-pre-wrap break-words">{text}</div>
      </div>
    </div>
  );
}
