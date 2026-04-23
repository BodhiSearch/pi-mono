import { useEffect, useMemo } from 'react';
import { toast } from 'sonner';
import { useAgent } from '@/hooks/useAgent';
import { useMcpList } from '@/hooks/useMcpList';
import { useMcpSelection } from '@/hooks/useMcpSelection';
import { useMcpAgentTools } from '@/hooks/useMcpAgentTools';
import { useSkillSandbox } from '@/hooks/useSkillSandbox';
import { useExtensionState } from '@/hooks/useExtensionState';
import { useExtensionUI } from '@/hooks/useExtensionUI';
import ExtensionUIRenderer from '@/components/extensions/ExtensionUIRenderer';
import ExtensionTitleSlot from '@/components/extensions/ExtensionTitleSlot';
import ExtensionWidgetSlot from '@/components/extensions/ExtensionWidgetSlot';
import { SessionPicker } from '@/components/sessions/SessionPicker';
import type { McpToolDescriptor, ToolCallHandler } from '@/worker-agent';
import ChatMessages from './ChatMessages';
import ChatInput from './ChatInput';

export default function ChatDemo() {
  const { mcps, toolsByMcpId, isLoading: isMcpsLoading } = useMcpList();
  const { enabledMcpTools, toggleTool, toggleMcp, getEnabledToolCount, getCheckboxState } =
    useMcpSelection(mcps, toolsByMcpId);

  const { descriptors: mcpDescriptors, handler: mcpHandler } = useMcpAgentTools({
    enabledMcpTools,
    mcps,
    toolsByMcpId,
  });

  const { descriptor: skillDescriptor, handler: skillHandler } = useSkillSandbox();

  const {
    extensions,
    errors: extensionErrors,
    enabledMap: extensionEnabledMap,
    setEnabled: setExtensionEnabled,
    disableAll: disableAllExtensions,
    clearErrors: clearExtensionErrors,
  } = useExtensionState();

  // `pi.ui.*` is a singleton pipeline: one subscriber drives the
  // toast / dialog / status-chip surface. Subscribing here (not in
  // `ExtensionUIRenderer`) ensures `notify` + `setStatus` still land
  // even when no dialog is currently active — otherwise mounting the
  // renderer only on demand would miss the events, and subscribing
  // again inside the renderer would produce duplicate toasts.
  const {
    statusChips: extensionStatusChips,
    activeDialog,
    respond: respondToDialog,
    dismissActive: dismissExtensionDialog,
    title: extensionTitle,
    titleExtensionPath: extensionTitlePath,
    widgets: extensionWidgets,
  } = useExtensionUI();

  // Merge MCP tools with the bash-skill shim so the worker sees one
  // flat tool list. The handler dispatches by tool name — skills go
  // to the sandbox, everything else falls through to MCP.
  const mcpToolDescriptors = useMemo<McpToolDescriptor[]>(
    () => [skillDescriptor, ...mcpDescriptors],
    [skillDescriptor, mcpDescriptors]
  );
  const toolCallHandler = useMemo<ToolCallHandler>(() => {
    return async (toolName, args) => {
      if (toolName === skillDescriptor.name) {
        return skillHandler(toolName, args);
      }
      return mcpHandler(toolName, args);
    };
  }, [skillDescriptor, skillHandler, mcpHandler]);

  const {
    messages,
    streamingMessage,
    isStreaming,
    isCompacting,
    selectedModel,
    setSelectedModel,
    sendMessage,
    clearMessages,
    error: chatError,
    clearError: clearChatError,
    models,
    isLoadingModels,
    loadModels,
    sessions,
    transientMessages,
  } = useAgent({
    mcpToolDescriptors,
    toolCallHandler,
  });

  useEffect(() => {
    if (chatError) {
      toast.error(chatError, {
        onDismiss: clearChatError,
        onAutoClose: clearChatError,
      });
    }
  }, [chatError, clearChatError]);

  return (
    <>
      <div className="flex items-center gap-2 border-b border-gray-200 bg-white px-3 py-2">
        <span className="shrink-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          Chat
        </span>
        <SessionPicker
          current={sessions.current}
          list={sessions.list}
          onSwitch={sessions.load}
          onNew={sessions.newSession}
          onDelete={sessions.delete}
          onRename={sessions.rename}
        />
        <ExtensionTitleSlot
          title={extensionTitle}
          extensionPath={extensionTitlePath}
          className="ml-auto"
        />
      </div>
      <ChatMessages
        messages={messages}
        streamingMessage={streamingMessage}
        isStreaming={isStreaming}
        error={chatError}
        messageMeta={sessions.messageMeta}
        transientMessages={transientMessages}
        onForkFromEntry={entryId => {
          void sessions.fork(entryId);
        }}
        onBranchFromEntry={entryId => {
          void sessions.navigateToLeaf(entryId);
        }}
      />
      <ExtensionWidgetSlot widgets={extensionWidgets} />

      <ChatInput
        onSendMessage={sendMessage}
        onClearMessages={clearMessages}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        models={models}
        isLoadingModels={isLoadingModels}
        onRefreshModels={loadModels}
        mcps={mcps}
        toolsByMcpId={toolsByMcpId}
        enabledMcpTools={enabledMcpTools}
        onToggleMcp={toggleMcp}
        onToggleTool={toggleTool}
        getCheckboxState={getCheckboxState}
        enabledToolCount={getEnabledToolCount()}
        isMcpsLoading={isMcpsLoading}
        isCompacting={isCompacting}
        isStreaming={isStreaming}
        onCompactNow={() => void sessions.compactNow()}
        extensions={extensions}
        extensionEnabledMap={extensionEnabledMap}
        extensionErrors={extensionErrors}
        onToggleExtension={setExtensionEnabled}
        onDisableAllExtensions={disableAllExtensions}
        onClearExtensionErrors={clearExtensionErrors}
        extensionStatusChips={extensionStatusChips}
      />
      <ExtensionUIRenderer
        activeDialog={activeDialog}
        respond={respondToDialog}
        dismissActive={dismissExtensionDialog}
      />
    </>
  );
}
