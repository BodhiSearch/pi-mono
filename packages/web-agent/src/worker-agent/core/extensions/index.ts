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
  AfterCompactEvent,
  AgentToolResult,
  AgentToolUpdateCallback,
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  BeforeCompactEvent,
  BeforeCompactEventResult,
  ContextEvent,
  ContextEventResult,
  ContextSupplier,
  Extension,
  ExtensionAPI,
  ExtensionCommandHandler,
  ExtensionContext,
  ExtensionDescriptor,
  ExtensionEditorOptions,
  ExtensionError,
  ExtensionEventHandler,
  ExtensionFactory,
  ExtensionManifest,
  ExtensionSelectOption,
  ExtensionSkillInput,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionUINotifyType,
  ExtensionWidget,
  MessageEndEvent,
  RegisteredCommand,
  RegisteredProvider,
  RegisteredSkill,
  RegisteredTool,
  SessionLoadedEvent,
  SessionLoadedReason,
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
export type {
  BeforeCompactOutcome,
  ExtensionErrorListener,
  ToolCallOutcome,
  ToolResultOverride,
} from './runner';

export { InvalidSessionError, ReadonlySessionForwarder } from './session-forwarder';
export type { SessionSupplier } from './session-forwarder';

export { wrapRegisteredTool, wrapRegisteredTools } from './wrapper';
