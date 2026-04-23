import { useEffect, useRef, useMemo } from 'react';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { ToolResultMessage } from '@mariozechner/pi-ai';
import MessageBubble from './MessageBubble';
import ToolCallMessage from './ToolCallMessage';
import { extractTextFromAgentMessage, getToolCalls, type AgentMessage } from '@/types/chat';

interface ChatMessagesProps {
  messages: AgentMessage[];
  streamingMessage?: AgentMessage;
  isStreaming: boolean;
  error?: string | null;
}

export default function ChatMessages({
  messages,
  streamingMessage,
  isStreaming,
  error,
}: ChatMessagesProps) {
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const isUserScrolledUpRef = useRef(false);
  const prevMessagesLengthRef = useRef(0);

  const renderList = useMemo<AgentMessage[]>(() => {
    return streamingMessage ? [...messages, streamingMessage] : messages;
  }, [messages, streamingMessage]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const isAtBottom = scrollTop + clientHeight >= scrollHeight - 50;
      isUserScrolledUpRef.current = !isAtBottom;
    };

    viewport.addEventListener('scroll', handleScroll);
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const lastMessage = renderList[renderList.length - 1];
    const isNewUserMessage =
      renderList.length > prevMessagesLengthRef.current && lastMessage?.role === 'user';

    if (isNewUserMessage) {
      isUserScrolledUpRef.current = false;
    }

    prevMessagesLengthRef.current = renderList.length;
  }, [renderList]);

  useEffect(() => {
    if (!isUserScrolledUpRef.current) {
      messagesEndRef.current?.scrollIntoView({
        behavior: isStreaming ? 'instant' : 'smooth',
      });
    }
  }, [renderList, isStreaming]);

  const toolResults = useMemo(() => {
    const map = new Map<string, ToolResultMessage>();
    for (const msg of renderList) {
      if (msg.role === 'toolResult') {
        map.set(msg.toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [renderList]);

  const turnByIndex = useMemo(() => {
    const turns: number[] = [];
    let userCount = 0;
    for (const msg of renderList) {
      if (msg.role === 'user') userCount++;
      turns.push(Math.max(0, userCount - 1));
    }
    return turns;
  }, [renderList]);

  const lastMsg = renderList[renderList.length - 1];
  const showPending =
    isStreaming &&
    (!lastMsg || lastMsg.role !== 'assistant' || !extractTextFromAgentMessage(lastMsg));

  return (
    <ScrollArea
      className="flex-1 overflow-hidden"
      data-testid="chat-area"
      data-teststate={error ? 'error' : isStreaming ? 'streaming' : 'idle'}
      ref={(node: HTMLDivElement | null) => {
        if (node) {
          const viewport = node.querySelector(
            '[data-slot="scroll-area-viewport"]'
          ) as HTMLDivElement;
          if (viewport) {
            scrollViewportRef.current = viewport;
          }
        }
      }}
    >
      <div className="p-4 bg-gray-50">
        <div className="max-w-4xl mx-auto">
          {renderList.length === 0 ? (
            <p className="text-center text-gray-400 mt-8">No messages yet. Start a conversation!</p>
          ) : (
            <>
              {renderList.map((msg, index) => {
                if (msg.role === 'toolResult') return null;
                const turn = turnByIndex[index];

                if (msg.role === 'assistant' && getToolCalls(msg).length > 0) {
                  const hasText = !!extractTextFromAgentMessage(msg);
                  return (
                    <div key={index}>
                      {hasText && <MessageBubble message={msg} turn={turn} />}
                      <ToolCallMessage message={msg} toolResults={toolResults} />
                    </div>
                  );
                }

                return <MessageBubble key={index} message={msg} turn={turn} />;
              })}
              {showPending && (
                <div data-testid="streaming-indicator" className="flex justify-start mb-4">
                  <div className="bg-gray-200 px-4 py-2 rounded-lg">
                    <div className="flex items-center gap-2">
                      <div className="w-2 h-2 bg-gray-600 rounded-full animate-pulse" />
                      <div className="w-2 h-2 bg-gray-600 rounded-full animate-pulse delay-100" />
                      <div className="w-2 h-2 bg-gray-600 rounded-full animate-pulse delay-200" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={messagesEndRef} />
            </>
          )}
        </div>
      </div>
      <div
        data-testid="chat-processing"
        aria-hidden="true"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          left: -9999,
          display: isStreaming ? 'block' : 'none',
        }}
      />
    </ScrollArea>
  );
}
