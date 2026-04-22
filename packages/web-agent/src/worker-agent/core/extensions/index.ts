/**
 * Barrel for the worker-side extension runtime.
 *
 * Exports the types extension authors and the worker-host consume, plus
 * the loader/runner/wrapper implementations the `WorkerAgentHost`
 * composes. Main-thread descriptors (`ExtensionDescriptor`,
 * `ExtensionError`) are re-exported from the top-level `worker-agent`
 * barrel so React code doesn't need to reach into `core/extensions/`.
 */

export type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ContextEvent,
  ContextEventResult,
  ContextSupplier,
  Extension,
  ExtensionAPI,
  ExtensionCommandHandler,
  ExtensionContext,
  ExtensionDescriptor,
  ExtensionError,
  ExtensionEventHandler,
  ExtensionFactory,
  ExtensionManifest,
  ExtensionSelectOption,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUINotifyType,
  MessageEndEvent,
  RegisteredCommand,
  RegisteredTool,
  SessionLoadedEvent,
  ToolCallEvent,
  ToolCallEventResult,
  ToolDefinition,
  ToolResultEvent,
  ToolResultEventResult,
  TurnStartEvent,
} from './types';

export { defineTool } from './types';

export {
  EXTENSIONS_DIR_SEGMENT,
  defaultUIContextBuilder,
  loadExtensionsFromVault,
  loadExtensionFromSource,
} from './loader';
export type {
  ExtensionLoaderOps,
  ExtensionUIContextBuilder,
  LoadExtensionsOptions,
  LoadExtensionsResult,
  ModuleImporter,
} from './loader';

export { ExtensionRunner } from './runner';
export type { ExtensionErrorListener, ToolCallOutcome, ToolResultOverride } from './runner';

export { wrapRegisteredTool, wrapRegisteredTools } from './wrapper';
