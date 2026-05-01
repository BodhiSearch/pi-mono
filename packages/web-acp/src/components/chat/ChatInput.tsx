import { useMemo, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import { Plus, RefreshCw, ArrowUp, Square } from 'lucide-react';
import type { AvailableCommand } from '@agentclientprotocol/sdk';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ModelCombobox from './ModelCombobox';
import CommandPicker from './CommandPicker';
import type { BodhiModelInfo } from '@/lib/bodhi-models';
import type { ApiFormat } from '@bodhiapp/bodhi-js-react/api';

interface ChatInputProps {
  onSendMessage: (message: string) => Promise<void>;
  onClearMessages: () => void;
  onStop: () => void;
  isStreaming: boolean;
  selectedModel: string;
  setSelectedModel: (id: string, fmt: ApiFormat) => void;
  models: BodhiModelInfo[];
  isLoadingModels: boolean;
  onRefreshModels: () => void;
  availableCommands: readonly AvailableCommand[];
}

export default function ChatInput({
  onSendMessage,
  onClearMessages,
  onStop,
  isStreaming,
  selectedModel,
  setSelectedModel,
  models,
  isLoadingModels,
  onRefreshModels,
  availableCommands,
}: ChatInputProps) {
  const { isReady, isAuthenticated } = useBodhi();
  const [message, setMessage] = useState('');
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isDisabled = !isReady || !isAuthenticated;
  const slashState = useMemo(() => parseSlashState(message), [message]);
  // The picker is open iff the input is in slash-state AND the user
  // hasn't dismissed THIS query. Editing past the dismissed query
  // (typing or deleting characters) reopens the picker because the
  // dismissed-query token no longer matches the live one.
  const pickerOpen = slashState.kind === 'active' && dismissedQuery !== slashState.query;

  const getHintText = () => {
    if (!isReady) return 'Client not ready';
    if (!isAuthenticated) return 'Please log in to send messages';
    return 'Type a message or "/" for commands…';
  };

  const handleSubmit = async () => {
    if (isDisabled || !message.trim()) return;
    if (pickerOpen) return; // Enter while picker open is consumed by the picker
    const messageToSend = message;
    setMessage('');
    setDismissedQuery(null);
    await onSendMessage(messageToSend);
  };

  const handleNewChat = () => {
    onClearMessages();
    setMessage('');
    setDismissedQuery(null);
  };

  const handleSelect = (cmd: AvailableCommand) => {
    setMessage(`/${cmd.name} `);
    setDismissedQuery(null);
    // Restore focus + caret position to the end of the textarea so
    // the user can immediately type arguments.
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      const value = el.value;
      el.setSelectionRange(value.length, value.length);
    });
  };

  const handlePickerDismiss = () => {
    setDismissedQuery(slashState.kind === 'active' ? slashState.query : null);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' && !pickerOpen) {
      void handleSubmit();
    }
  };

  const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
    setMessage(e.target.value);
  };

  return (
    <div className="w-full px-4 py-4">
      <div className="max-w-4xl mx-auto">
        <div className="relative">
          <CommandPicker
            open={pickerOpen}
            query={slashState.kind === 'active' ? slashState.query : ''}
            commands={availableCommands}
            onSelect={handleSelect}
            onDismiss={handlePickerDismiss}
          />
          <div className="grid grid-cols-[auto_1fr_auto] grid-rows-[1fr_auto] gap-2 p-3 bg-white border border-gray-200 rounded-3xl shadow-sm">
            <Button
              data-testid="btn-new-chat"
              onClick={handleNewChat}
              variant="ghost"
              size="icon"
              title="New chat"
              disabled={isDisabled}
              className="row-span-2 self-center"
            >
              <Plus />
            </Button>

            <Input
              data-testid="chat-input"
              ref={inputRef}
              value={message}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              placeholder={getHintText()}
              disabled={isDisabled}
              className="col-start-2 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
            />

            <div className="col-start-2 flex items-center gap-2 justify-end">
              <ModelCombobox
                models={models}
                selected={selectedModel}
                onSelect={setSelectedModel}
                disabled={isDisabled}
              />

              <Button
                data-testid="btn-refresh-models"
                onClick={onRefreshModels}
                variant="ghost"
                size="icon"
                title="Refresh models"
                disabled={isLoadingModels}
              >
                <RefreshCw className={isLoadingModels ? 'animate-spin' : ''} size={18} />
              </Button>
            </div>

            {isStreaming ? (
              <Button
                data-testid="btn-stop"
                onClick={onStop}
                variant="ghost"
                size="icon"
                className="row-span-2 col-start-3 self-center"
                title="Stop streaming"
                aria-label="Stop streaming"
              >
                <Square />
              </Button>
            ) : (
              <Button
                data-testid="send-button"
                onClick={handleSubmit}
                disabled={isDisabled || !message.trim()}
                variant="ghost"
                size="icon"
                className="row-span-2 col-start-3 self-center"
                title="Send message"
              >
                <ArrowUp />
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

type SlashState = { kind: 'inactive' } | { kind: 'active'; query: string };

/**
 * Returns the picker query when the message starts with `/` and the
 * leading token has not yet been terminated by whitespace. Once the
 * user types a space (= moving on to args) the picker closes; the
 * literal `/cmd args` text is what the agent expands on send.
 */
function parseSlashState(message: string): SlashState {
  if (!message.startsWith('/')) return { kind: 'inactive' };
  const rest = message.slice(1);
  const wsIdx = rest.search(/\s/);
  if (wsIdx !== -1) return { kind: 'inactive' };
  return { kind: 'active', query: rest };
}
