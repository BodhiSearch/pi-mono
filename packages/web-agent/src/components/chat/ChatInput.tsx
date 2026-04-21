import { useMemo, useRef, useState } from 'react';
import { useBodhi } from '@bodhiapp/bodhi-js-react';
import { Plus, RefreshCw, ArrowUp, Minimize2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import ModelCombobox from './ModelCombobox';
import McpPopover from './McpPopover';
import ExtensionsPanel from '@/components/extensions/ExtensionsPanel';
import CommandPalette, { type CommandPaletteHandle } from './CommandPalette';
import { useSlashCommands } from '@/hooks/useSlashCommands';
import type { Mcp, McpTool } from '@/lib/mcp-tools';
import type { Api, Model } from '@mariozechner/pi-ai';
import type { ExtensionDescriptor, ExtensionError, SlashCommandInfo } from '@/worker-agent';
import type { ExtensionEnabledMap } from '@/extension-store/ExtensionStore';

interface ChatInputProps {
  onSendMessage: (message: string) => Promise<void>;
  onClearMessages: () => void;
  selectedModel: string;
  setSelectedModel: (id: string) => void;
  models: Model<Api>[];
  isLoadingModels: boolean;
  onRefreshModels: () => void;
  mcps: Mcp[];
  toolsByMcpId: Record<string, McpTool[]>;
  enabledMcpTools: Record<string, string[]>;
  onToggleMcp: (mcpId: string, allToolNames: string[]) => void;
  onToggleTool: (mcpId: string, toolName: string) => void;
  getCheckboxState: (mcpId: string) => 'checked' | 'unchecked' | 'indeterminate';
  enabledToolCount: number;
  isMcpsLoading: boolean;
  isCompacting?: boolean;
  isStreaming?: boolean;
  onCompactNow?: () => void;
  extensions: ExtensionDescriptor[];
  extensionEnabledMap: ExtensionEnabledMap;
  extensionErrors: ExtensionError[];
  onToggleExtension: (name: string, enabled: boolean) => void | Promise<void>;
  onDisableAllExtensions: () => void | Promise<void>;
  onClearExtensionErrors: () => void;
}

/**
 * Split the input buffer into `{ prefix, afterSpace }` if it's in the
 * slash-prefix phase (starts with `/` and no whitespace yet). When
 * `afterSpace` is `true` the user has moved past the command name and
 * is typing arguments — the palette should close.
 */
function parseSlashPrefix(buffer: string): { prefix: string; afterSpace: boolean } | null {
  if (!buffer.startsWith('/')) return null;
  const spaceIdx = buffer.search(/\s/);
  if (spaceIdx === -1) return { prefix: buffer.slice(1), afterSpace: false };
  return { prefix: buffer.slice(1, spaceIdx), afterSpace: true };
}

export default function ChatInput({
  onSendMessage,
  onClearMessages,
  selectedModel,
  setSelectedModel,
  models,
  isLoadingModels,
  onRefreshModels,
  mcps,
  toolsByMcpId,
  enabledMcpTools,
  onToggleMcp,
  onToggleTool,
  getCheckboxState,
  enabledToolCount,
  isMcpsLoading,
  isCompacting = false,
  isStreaming = false,
  onCompactNow,
  extensions,
  extensionEnabledMap,
  extensionErrors,
  onToggleExtension,
  onDisableAllExtensions,
  onClearExtensionErrors,
}: ChatInputProps) {
  const { isReady, isAuthenticated } = useBodhi();
  const [message, setMessage] = useState('');
  const paletteRef = useRef<CommandPaletteHandle | null>(null);
  // Manual close lets the user dismiss the palette with Escape without
  // clearing the `/` prefix — reopens only when they re-type `/` at the
  // start of the buffer.
  const [paletteDismissed, setPaletteDismissed] = useState(false);
  const { filter } = useSlashCommands();

  const isDisabled = !isReady || !isAuthenticated;

  const slashState = useMemo(() => parseSlashPrefix(message), [message]);
  const paletteOpen = !!slashState && !slashState.afterSpace && !paletteDismissed;
  const filteredCommands = useMemo<SlashCommandInfo[]>(
    () => (slashState ? filter(slashState.prefix) : []),
    [slashState, filter]
  );

  const getHintText = () => {
    if (!isReady) return 'Client not ready';
    if (!isAuthenticated) return 'Please log in to send messages';
    return 'Type a message or / for commands...';
  };

  const handleSubmit = async () => {
    if (isDisabled || !message.trim()) return;
    const messageToSend = message;
    setMessage('');
    setPaletteDismissed(false);
    await onSendMessage(messageToSend);
  };

  const handleNewChat = () => {
    onClearMessages();
    setMessage('');
    setPaletteDismissed(false);
  };

  const handleSelectCommand = (command: SlashCommandInfo) => {
    // Append a trailing space so the user can start typing arguments
    // immediately, matching the coding-agent TUI completion behaviour.
    setMessage(`/${command.name} `);
    setPaletteDismissed(true);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (paletteOpen && paletteRef.current?.handleKey(event)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'Enter') {
      void handleSubmit();
    }
  };

  const handleChange = (next: string) => {
    setMessage(next);
    // Re-opening the palette happens implicitly when the prefix is
    // back in the slash-prefix phase. A manual Escape sticks until
    // the user clears the input entirely.
    if (!next.startsWith('/')) setPaletteDismissed(false);
  };

  return (
    <div className="w-full px-4 py-4">
      <div className="max-w-4xl mx-auto">
        <div className="relative grid grid-cols-[auto_1fr_auto] grid-rows-[1fr_auto] gap-2 p-3 bg-white border border-gray-200 rounded-3xl shadow-sm">
          <CommandPalette
            ref={paletteRef}
            commands={filteredCommands}
            open={paletteOpen}
            onSelect={handleSelectCommand}
            onClose={() => setPaletteDismissed(true)}
          />
          <div className="row-span-2 flex flex-col items-center justify-center gap-1">
            <Button
              onClick={handleNewChat}
              variant="ghost"
              size="icon"
              title="New chat"
              disabled={isDisabled}
            >
              <Plus />
            </Button>
            {onCompactNow && (
              <Button
                data-testid="chat-compact-button"
                data-test-state={isCompacting ? 'compacting' : 'idle'}
                onClick={onCompactNow}
                variant="ghost"
                size="icon"
                title="Compact conversation"
                disabled={isCompacting || isStreaming}
              >
                <Minimize2 className={isCompacting ? 'animate-spin' : ''} size={18} />
              </Button>
            )}
          </div>

          <Input
            data-testid="chat-input"
            value={message}
            onChange={e => handleChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={getHintText()}
            disabled={isDisabled}
            className="col-start-2 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
          />

          <div className="col-start-2 flex items-center gap-2 justify-end">
            <McpPopover
              mcps={mcps}
              toolsByMcpId={toolsByMcpId}
              enabledMcpTools={enabledMcpTools}
              onToggleMcp={onToggleMcp}
              onToggleTool={onToggleTool}
              getCheckboxState={getCheckboxState}
              enabledToolCount={enabledToolCount}
              isLoading={isMcpsLoading}
            />

            <ExtensionsPanel
              extensions={extensions}
              enabledMap={extensionEnabledMap}
              errors={extensionErrors}
              onToggle={(name, enabled) => {
                void onToggleExtension(name, enabled);
              }}
              onDisableAll={() => {
                void onDisableAllExtensions();
              }}
              onClearErrors={onClearExtensionErrors}
            />

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
        </div>
      </div>
    </div>
  );
}
